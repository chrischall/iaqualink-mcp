/**
 * The iAqualink (Zodiac / Fluidra) cloud client.
 *
 * Every endpoint, header and body here is transcribed from iaqualink-py 0.7.0
 * — the open-source client Home Assistant's integration uses — and is NOT yet
 * verified against a live account (docs/IAQUALINK-API.md records provenance
 * line by line). Three hosts are involved:
 *
 *  - `prod.zodiac-io.com` — login, token refresh, and the eXO device shadow;
 *  - `r-api.iaqualink.net` — the system list (`devices.json`) and the iAqua
 *    command channel (`v2/mobile/session.json`).
 *
 * Auth is a plain server-side email/password login. Two rules matter more than
 * anything else in this file:
 *
 *  1. **A rejected password is never retried.** Zodiac's login is the only way
 *     in, and a loop of failed sign-ins is how accounts get locked. One login
 *     attempt per call path; a 401/403 from the login endpoint is LATCHED for
 *     the life of the process (restart / reconnect with a corrected password
 *     to clear it).
 *  2. **Refresh and login are single-flight.** Concurrent calls that all see
 *     a 401 share one refresh; a refused refresh falls back to ONE login.
 *
 * Requests are serialized through one throttle and a successful status read
 * is cached per system for a few seconds (`IAQUALINK_STATUS_CACHE_SECONDS`),
 * because iaqualink-py documents that eXO systems answer 429 when polled every
 * 15 s and both system types are polled by the vendor's own app.
 */
import {
  McpToolError,
  RateLimitError,
  UnreachableError,
  createThrottle,
  fetchBounded,
  parseJsonBody,
  readEnvVar,
  truncateErrorMessage,
  type EnvSource,
  type Throttle,
} from '@chrischall/mcp-utils';

/** The mobile app's public API key, as shipped in iaqualink-py's const.py. */
export const API_KEY = 'EOOEMOW4YR6QNB07';
export const LOGIN_URL = 'https://prod.zodiac-io.com/users/v1/login';
export const REFRESH_URL = 'https://prod.zodiac-io.com/users/v1/refresh';
export const DEVICES_URL = 'https://r-api.iaqualink.net/devices.json';
export const IAQUA_SESSION_URL = 'https://r-api.iaqualink.net/v2/mobile/session.json';
export const EXO_DEVICES_URL = 'https://prod.zodiac-io.com/devices/v1';

const USER_AGENT = 'okhttp/3.14.7';
const SERVICE = 'iAqualink';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_429_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_BACKOFF_MS = 2_000;
const DEFAULT_STATUS_CACHE_MS = 5_000;
const SYSTEMS_CACHE_MS = 5 * 60_000;

export const SUPPORTED_TYPES = ['iaqua', 'exo'] as const;
export type SupportedType = (typeof SUPPORTED_TYPES)[number];

/** One row of `devices.json`. Only the fields this server reads are typed. */
export interface DeviceRecord {
  serial_number: string;
  name?: string;
  device_type: string;
  [key: string]: unknown;
}

export type RawStatus =
  | { kind: 'iaqua'; system: DeviceRecord; home: unknown; devices: unknown }
  | { kind: 'exo'; system: DeviceRecord; shadow: unknown };

export interface ClientOptions {
  email?: string;
  password?: string;
  /** Environment to read the credential and knobs from. Defaults to `process.env`. */
  env?: EnvSource;
  fetchImpl?: typeof fetch;
  statusCacheMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Session {
  sessionId: string;
  authToken: string;
  userId: string;
  idToken: string;
  refreshToken: string;
}

/** A 401 (or the devices.json 404 iaqualink-py maps to one) — internal signal for the reauth path. */
class AuthExpired extends Error {
  constructor(readonly status: number) {
    super(`iAqualink answered ${status}`);
  }
}

const NO_CREDENTIAL_HINT =
  'Set IAQUALINK_EMAIL and IAQUALINK_PASSWORD (the iAqualink app sign-in), or reconnect the hosted connector and enter them.';

function hostOf(url: string): string {
  return new URL(url).host;
}

export class IaqualinkClient {
  readonly statusCacheMs: number;
  private readonly email: string | undefined;
  private readonly password: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly throttle: Throttle;

  private session: Session | undefined;
  private authInFlight: Promise<Session> | undefined;
  private loginRefusal: McpToolError | undefined;
  private systems: { at: number; list: DeviceRecord[] } | undefined;
  private readonly statusCache = new Map<string, { at: number; value: RawStatus }>();

  constructor(opts: ClientOptions = {}) {
    const env = opts.env ?? process.env;
    this.email = opts.email ?? readEnvVar('IAQUALINK_EMAIL', { env });
    // Never trimmed: a password may legitimately begin or end with a space.
    this.password = opts.password ?? readEnvVar('IAQUALINK_PASSWORD', { env, trim: false });
    const ttl = Number(readEnvVar('IAQUALINK_STATUS_CACHE_SECONDS', { env }));
    this.statusCacheMs =
      opts.statusCacheMs ?? (Number.isFinite(ttl) && ttl >= 0 ? ttl * 1000 : DEFAULT_STATUS_CACHE_MS);
    // A wrapper, never the bare global: some hosts' undici throws "Illegal
    // invocation" when fetch is called with a non-global receiver.
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.throttle = createThrottle({ minIntervalMs: opts.minIntervalMs ?? 250 });
  }

  /** Where the credential came from — never its value. */
  describeCredential(): { source: string | null; detail: { email: boolean; password: boolean } } {
    const detail = { email: Boolean(this.email), password: Boolean(this.password) };
    return { source: detail.email && detail.password ? 'IAQUALINK_EMAIL + IAQUALINK_PASSWORD' : null, detail };
  }

  /** The signed-in account, for binding confirmations to it. */
  get account(): string | undefined {
    return this.email?.toLowerCase();
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  /**
   * Scrub the password out of any upstream text before it can reach a user.
   * `redactSecrets` matches secret SHAPES and a password has none. Only called
   * from `send`, which runs after `requireCredential`, so the password is set
   * (and non-empty — an empty needle would splice the placeholder everywhere).
   */
  private scrub(text: string): string {
    return truncateErrorMessage(text).split(this.password!).join('[redacted]');
  }

  private async send(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.throttle(async () => {
        try {
          return await fetchBounded(url, {
            ...init,
            headers: { 'user-agent': USER_AGENT, 'content-type': 'application/json', ...init.headers },
          }, { timeoutMs: REQUEST_TIMEOUT_MS, read: 'text', service: SERVICE, fetchImpl: this.fetchImpl });
        } catch (err) {
          if (err instanceof McpToolError) throw err;
          throw new McpToolError(`Could not reach ${hostOf(url)}: ${(err as Error).message}`, {
            kind: 'transport',
            cause: err,
            hint: 'Check the network (and, when hosted, that the egress allowlist includes this host).',
          });
        }
      });
      if (res.status === 429) {
        const header = res.headers.get('retry-after');
        const seconds = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : undefined;
        if (attempt >= MAX_429_RETRIES) throw new RateLimitError(SERVICE, seconds);
        await this.sleep(seconds === undefined ? DEFAULT_BACKOFF_MS : Math.min(seconds * 1000, MAX_RETRY_AFTER_MS));
        continue;
      }
      if (res.status === 401) throw new AuthExpired(401);
      if (res.status >= 500) throw new UnreachableError(SERVICE, res.status);
      if (res.status !== 200) {
        throw new McpToolError(`${SERVICE} answered ${res.status} for ${hostOf(url)}: ${this.scrub(res.body)}`, {
          kind: 'http',
          status: res.status,
        });
      }
      return parseJsonBody(res.body, { service: SERVICE, status: res.status });
    }
  }

  // ── auth ──────────────────────────────────────────────────────────────────

  private requireCredential(): { email: string; password: string } {
    if (this.email && this.password) return { email: this.email, password: this.password };
    const missing = [!this.email && 'IAQUALINK_EMAIL', !this.password && 'IAQUALINK_PASSWORD'].filter(Boolean);
    throw new McpToolError(`iAqualink is not configured: ${missing.join(' and ')} not set.`, {
      kind: 'no_credential',
      hint: NO_CREDENTIAL_HINT,
    });
  }

  private applyTokens(data: unknown, refreshFallback: string): Session {
    const d = data as {
      id?: unknown;
      authentication_token?: unknown;
      session_id?: unknown;
      userPoolOAuth?: { IdToken?: unknown; RefreshToken?: unknown };
    } | null;
    const fields = [d?.session_id, d?.authentication_token, d?.id, d?.userPoolOAuth?.IdToken];
    if (!fields.every((f) => (typeof f === 'string' && f !== '') || typeof f === 'number')) {
      throw new McpToolError('Unexpected login response from iAqualink (missing session tokens).', { kind: 'http' });
    }
    const refresh = d!.userPoolOAuth!.RefreshToken;
    this.session = {
      sessionId: String(d!.session_id),
      authToken: String(d!.authentication_token),
      userId: String(d!.id),
      idToken: String(d!.userPoolOAuth!.IdToken),
      refreshToken: typeof refresh === 'string' && refresh ? refresh : refreshFallback,
    };
    return this.session;
  }

  private async login(): Promise<Session> {
    if (this.loginRefusal) throw this.loginRefusal;
    const { email, password } = this.requireCredential();
    try {
      const data = await this.send(LOGIN_URL, {
        method: 'POST',
        body: JSON.stringify({ api_key: API_KEY, email, password }),
      });
      return this.applyTokens(data, '');
    } catch (err) {
      if (err instanceof AuthExpired) {
        this.loginRefusal = new McpToolError('iAqualink rejected the email/password.', {
          kind: 'credential_rejected',
          status: err.status,
          hint:
            'Check IAQUALINK_EMAIL / IAQUALINK_PASSWORD (or reconnect the connector with the right sign-in). ' +
            'This server will not try the same password again until it restarts, so repeated failures cannot lock the account.',
        });
        throw this.loginRefusal;
      }
      throw err;
    }
  }

  private async refresh(stale: Session | undefined): Promise<Session> {
    if (!stale?.refreshToken || !this.email) return this.login();
    try {
      const data = await this.send(REFRESH_URL, {
        method: 'POST',
        // No api_key — the refresh endpoint does not take one (iaqualink-py client.py).
        body: JSON.stringify({ email: this.email, refresh_token: stale.refreshToken }),
      });
      return this.applyTokens(data, stale.refreshToken);
    } catch (err) {
      if (err instanceof AuthExpired) return this.login();
      throw err;
    }
  }

  /** Single-flight: every caller waiting on auth shares one attempt. */
  private authenticate(stale?: Session): Promise<Session> {
    if (!this.authInFlight) {
      const attempt = stale ? this.refresh(stale) : this.login();
      this.authInFlight = attempt.finally(() => {
        this.authInFlight = undefined;
      });
    }
    return this.authInFlight;
  }

  /**
   * Run an authenticated request, re-authenticating ONCE on a 401. A second
   * 401 after a fresh session is reported, never retried again.
   */
  private async withSession<T>(call: (s: Session) => Promise<T>): Promise<T> {
    const session = this.session ?? (await this.authenticate());
    try {
      return await call(session);
    } catch (err) {
      if (!(err instanceof AuthExpired)) throw err;
    }
    // Concurrent 401s share the in-flight refresh (see authenticate).
    const fresh = await this.authenticate(session);
    try {
      return await call(fresh);
    } catch (err) {
      if (err instanceof AuthExpired) {
        throw new McpToolError('iAqualink refused the session even after signing in again.', {
          kind: 'session_expired',
          status: err.status,
          hint: 'Retry in a minute; if it persists, check the account in the iAqualink app.',
        });
      }
      throw err;
    }
  }

  // ── endpoints ─────────────────────────────────────────────────────────────

  async listSystems(): Promise<DeviceRecord[]> {
    const list = await this.withSession(async (s) => {
      const qs = new URLSearchParams({ api_key: API_KEY, authentication_token: s.authToken, user_id: s.userId });
      try {
        return await this.send(`${DEVICES_URL}?${qs}`, { method: 'GET' });
      } catch (err) {
        // iaqualink-py maps a devices.json 404 to "unauthorized".
        if (err instanceof McpToolError && err.status === 404) throw new AuthExpired(404);
        throw err;
      }
    });
    if (!Array.isArray(list)) {
      throw new McpToolError('Unexpected device list from iAqualink (not an array).', { kind: 'http' });
    }
    this.systems = { at: this.now(), list: list as DeviceRecord[] };
    return this.systems.list;
  }

  async getSystem(serial: string): Promise<DeviceRecord> {
    const fresh = this.systems && this.now() - this.systems.at < SYSTEMS_CACHE_MS;
    const find = (l: DeviceRecord[]) => l.find((d) => d.serial_number === serial);
    const hit = (fresh && find(this.systems!.list)) || find(await this.listSystems());
    if (!hit) {
      throw new McpToolError(`No iAqualink system with serial ${serial} on this account.`, {
        hint: 'Call iaqualink_list_systems for the serials this account can see.',
      });
    }
    return hit;
  }

  async iaquaCommand(serial: string, command: string, params: Record<string, string> = {}): Promise<unknown> {
    return this.withSession((s) => {
      const qs = new URLSearchParams({ ...params, actionID: 'command', command, serial, sessionID: s.sessionId });
      return this.send(`${IAQUA_SESSION_URL}?${qs}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${s.idToken}`, api_key: API_KEY },
      });
    });
  }

  async getExoShadow(serial: string): Promise<unknown> {
    return this.withSession((s) =>
      this.send(`${EXO_DEVICES_URL}/${encodeURIComponent(serial)}/shadow`, {
        method: 'GET',
        headers: { authorization: s.idToken },
      }),
    );
  }

  async setExoDesired(serial: string, desired: Record<string, unknown>): Promise<unknown> {
    return this.withSession((s) =>
      this.send(`${EXO_DEVICES_URL}/${encodeURIComponent(serial)}/shadow`, {
        method: 'POST',
        headers: { authorization: s.idToken },
        body: JSON.stringify({ state: { desired } }),
      }),
    );
  }

  /** The system's raw status, cached per serial for {@link statusCacheMs} unless `fresh`. */
  async readRawStatus(serial: string, opts: { fresh?: boolean } = {}): Promise<RawStatus> {
    const cached = this.statusCache.get(serial);
    if (!opts.fresh && cached && this.now() - cached.at < this.statusCacheMs) return cached.value;
    const system = await this.getSystem(serial);
    let value: RawStatus;
    if (system.device_type === 'iaqua') {
      const home = await this.iaquaCommand(serial, 'get_home');
      const devices = await this.iaquaCommand(serial, 'get_devices');
      value = { kind: 'iaqua', system, home, devices };
    } else if (system.device_type === 'exo') {
      value = { kind: 'exo', system, shadow: await this.getExoShadow(serial) };
    } else {
      throw new McpToolError(
        `System ${serial} is a "${system.device_type}", which this server does not support (supported: ${SUPPORTED_TYPES.join(', ')}).`,
      );
    }
    if (this.statusCacheMs > 0) this.statusCache.set(serial, { at: this.now(), value });
    return value;
  }

  /** Forget a cached status (after a write). */
  invalidate(serial: string): void {
    this.statusCache.delete(serial);
  }
}
