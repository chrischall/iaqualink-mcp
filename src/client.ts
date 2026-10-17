/**
 * The iAqualink (Zodiac / Fluidra) cloud client.
 *
 * Every endpoint, header and body here is transcribed from iaqualink-py 0.7.0
 * — the open-source client Home Assistant's integration uses — or from the
 * WebTouch capture. Login, devices.json, the iAqua reads and WebTouch have been
 * seen working on a real RS panel (2026-10-11/12); the iAqua set_* commands and
 * every eXO request are still derived (docs/IAQUALINK-API.md records provenance
 * line by line). The hosts involved:
 *
 *  - `prod.zodiac-io.com` — login, token refresh, and the eXO device shadow;
 *  - `r-api.iaqualink.net` — the system list (`devices.json`) and the iAqua
 *    command channel (`v2/mobile/session.json`);
 *  - `p-api.iaqualink.net` and `prm.iaqualink.net` — ALTERNATE iAqua command
 *    channels, tried only by the iQ20 schedule probe (see SESSION_ENDPOINTS):
 *    which one serves schedules is not yet known from a live account;
 *  - `prm.iaqualink.net/v2` — WebTouch, the RS panel emulation (src/webtouch.ts):
 *    location lookup, init, commands, and the panel's display stream.
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
  ApiError,
  McpToolError,
  RateLimitError,
  RequestTimeoutError,
  UnreachableError,
  WriteOutcomeUnknownError,
  createApiClient,
  createThrottle,
  readEnvVar,
  truncateErrorMessage,
  type ApiClient,
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
/** iaqualink-py master (eb1cf63) systems/iaqua/system.py:45 — its session URL since it moved off r-api. */
export const P_API_SESSION_URL = 'https://p-api.iaqualink.net/v2/mobile/session.json';
/** The iAquaLink iOS app's schedule host (krishvios/iAquaLink-Mirror@50e4182 Environment.m:313-327 + IQ20ApiManager.m:197-231). */
export const PRM_SESSION_URL = 'https://prm.iaqualink.net/v1/mobile/session.json';

/** WebTouch (RS panel emulation) — ejc3/iaqualink-webtouch@42c4d65 client.py:19-20,100-163 and the 2026-10-11 live capture. */
export const PRM_ROOT = 'https://prm.iaqualink.net/v2';
export const WEBTOUCH_USER_URL = `${PRM_ROOT}/userId`;
export const WEBTOUCH_INIT_URL = `${PRM_ROOT}/webtouch/init`;
export const WEBTOUCH_COMMAND_URL = `${PRM_ROOT}/webtouch/command`;
/** Hosts the WebTouch display stream (init's `serverConnection`) may be on; extend with IAQUALINK_WEBTOUCH_STREAM_HOSTS. */
// The live RS panel's stream came from webtouch.iaqualink.net (capture 2026-10-11).
export const WEBTOUCH_STREAM_HOSTS = ['webtouch.iaqualink.net', 'prm.iaqualink.net'];

/** What `webtouch/init` hands back that a session needs. */
export interface WebTouchInit {
  /** The display stream URL (an iframe in the browser). */
  serverConnection: string;
  /** actionID for button presses (`actionIdMasterId`). */
  master: string;
  /** actionID for the start-up press (`actionIdMasterStart`). */
  start: string;
  /** actionID for keypad text entry (`actionIdMasterSTB`). */
  stb: string;
}

/** One way of reaching the iAqua session.json command channel. */
export interface SessionEndpoint {
  id: string;
  url: string;
  /** `bearer` = `Authorization: Bearer <IdToken>`; `bare` = `Authorization: <IdToken>`. */
  auth: 'bearer' | 'bare';
  source: string;
}

/**
 * The candidate command channels, in the order the iQ20 schedule probe tries
 * them (each once). The first is the channel every other command uses; the
 * rest differ in host, API version and Authorization style, and come from
 * sources that disagree with each other (docs/IAQUALINK-API.md "Schedules").
 */
export const SESSION_ENDPOINTS: readonly SessionEndpoint[] = [
  { id: 'r-api-v2', url: IAQUA_SESSION_URL, auth: 'bearer', source: 'this server\'s iAqua channel (iaqualink-py 0.7.0)' },
  { id: 'p-api-v2', url: P_API_SESSION_URL, auth: 'bearer', source: 'iaqualink-py master system.py:45,129-131' },
  { id: 'p-api-v2-bare', url: P_API_SESSION_URL, auth: 'bare', source: 'iaqualink-py master docs/reference/systems/iaqua.md:19-27' },
  { id: 'prm-v1', url: PRM_SESSION_URL, auth: 'bare', source: 'iAquaLink iOS app 2022 (Environment.m:313-327, AuthenticatedConnection.m:60-63)' },
];

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

/**
 * What a write whose outcome is unknown tells the model. iAqua pump/heater/aux
 * commands are TOGGLES, so the right next step is a fresh read, never a blind
 * re-send (fleet-audit#1268).
 */
export const WRITE_OUTCOME_HINT =
  'The command may have reached the pool controller. Re-read the state with iaqualink_get_status before ' +
  'retrying; a retry of a toggle that already landed would be refused as unchanged, but check first.';

/** One request through {@link IaqualinkClient.send}. */
interface SendInit {
  method: string;
  /** JSON-serialised as the request body. */
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * The request changes equipment: the iAqua `set_*` commands (GETs), eXO
   * desired-state POSTs and WebTouch presses. A write that times out or drops
   * throws {@link WriteOutcomeUnknownError}, never a retry-looking transport
   * error. Anything else (login, refresh, reads) keeps the plain errors.
   */
  write?: boolean;
}

const NO_CREDENTIAL_HINT =
  'Set IAQUALINK_EMAIL and IAQUALINK_PASSWORD (the iAqualink app sign-in), or reconnect the hosted connector and enter them.';

export class IaqualinkClient {
  readonly statusCacheMs: number;
  private readonly email: string | undefined;
  private readonly password: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly throttle: Throttle;
  private readonly streamHosts: string[];
  /** One mcp-utils API client per origin (the server talks to several hosts). */
  private readonly apis = new Map<string, ApiClient>();

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
    const extra = readEnvVar('IAQUALINK_WEBTOUCH_STREAM_HOSTS', { env }) ?? '';
    this.streamHosts = [...WEBTOUCH_STREAM_HOSTS, ...extra.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)];
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
   * `redactSecrets` matches secret SHAPES and a password has none, so it is
   * scrubbed by value (`truncateErrorMessage`'s `values`, fleet-audit#1398) —
   * BEFORE the shape redactor and the length cut, so a password straddling
   * the cut cannot leave its first characters behind.
   */
  private scrub(text: string): string {
    return truncateErrorMessage(text, undefined, { values: [this.password], placeholder: '[redacted]' });
  }

  private api(origin: string): ApiClient {
    let api = this.apis.get(origin);
    if (!api) {
      api = createApiClient({
        baseUrl: origin,
        serviceName: SERVICE,
        baseHeaders: { 'user-agent': USER_AGENT },
        // Every attempt (429 retries included) goes through the one throttle.
        fetchImpl: (input, init) => this.throttle(() => this.fetchImpl(input, init)),
        sleep: this.sleep,
        timeout: REQUEST_TIMEOUT_MS,
        retry: { count: MAX_429_RETRIES, delayMs: DEFAULT_BACKOFF_MS, honorRetryAfter: true, maxRetryAfterMs: MAX_RETRY_AFTER_MS },
        // The reauth path (withSession) owns 401s; the login latch owns a refused login.
        onUnauthorized: () => new AuthExpired(401),
        onRateLimited: ({ retryAfterMs }) =>
          new RateLimitError(SERVICE, retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000)),
        writeOutcomeHint: WRITE_OUTCOME_HINT,
      });
      this.apis.set(origin, api);
    }
    return api;
  }

  /**
   * One JSON request, through mcp-utils' `createApiClient` (429 retry with
   * Retry-After, 401 → reauth, timeouts, write-outcome semantics). Query
   * parameters travel separately so they — session tokens included — never
   * appear in an error message.
   */
  private async send(url: string, init: SendInit): Promise<unknown> {
    const u = new URL(url);
    const query = Object.fromEntries(u.searchParams);
    try {
      return await this.api(u.origin).fetchJson(init.method, u.pathname, {
        ...(Object.keys(query).length > 0 ? { query } : {}),
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        // Only a real write reports an unknown outcome; a login or refresh POST is safe to repeat.
        idempotent: !init.write,
      });
    } catch (err) {
      if (err instanceof AuthExpired || err instanceof RateLimitError || err instanceof WriteOutcomeUnknownError) throw err;
      if (err instanceof ApiError) {
        if (err.status >= 500) throw new UnreachableError(SERVICE, err.status);
        throw new McpToolError(this.scrub(err.message), { kind: 'http', status: err.status, cause: err });
      }
      if (init.write && (err instanceof RequestTimeoutError || !(err instanceof McpToolError))) {
        // A GET that changes equipment (the iAqua set_* commands) is a write
        // the client cannot tell apart from a read: report it as one.
        throw new WriteOutcomeUnknownError(SERVICE, init.method, {
          ...(err instanceof RequestTimeoutError ? { timeoutMs: err.timeoutMs } : {}),
          cause: err,
          hint: WRITE_OUTCOME_HINT,
        });
      }
      if (err instanceof McpToolError || err instanceof RequestTimeoutError) throw err;
      throw new McpToolError(`Could not reach ${u.host}: ${(err as Error).message}`, {
        kind: 'transport',
        cause: err,
        hint: 'Check the network (and, when hosted, that the egress allowlist includes this host).',
      });
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
        body: { api_key: API_KEY, email, password },
      });
      return this.applyTokens(data, '');
    } catch (err) {
      // A login 403 is a refusal too — latch it like a 401 so it is never retried.
      if (err instanceof AuthExpired || (err instanceof McpToolError && err.status === 403)) {
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
        body: { email: this.email, refresh_token: stale.refreshToken },
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
  private async withSession<T>(call: (s: Session) => Promise<T>, opts: { reauth?: boolean } = {}): Promise<T> {
    const session = this.session ?? (await this.authenticate());
    try {
      return await call(session);
    } catch (err) {
      if (!(err instanceof AuthExpired)) throw err;
      // An alternate endpoint refusing a session the primary accepts says
      // nothing about the session — report it rather than re-authenticating.
      if (opts.reauth === false) {
        throw new McpToolError(`iAqualink answered ${err.status} on this endpoint.`, { kind: 'http', status: err.status });
      }
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

  /**
   * Send an iAqua session.json command. `endpoint` defaults to the primary
   * channel; an alternate one never triggers a re-authentication (a 401 there
   * is reported as an `http` error) so the schedule probe cannot churn logins.
   */
  async iaquaCommand(
    serial: string,
    command: string,
    params: Record<string, string> = {},
    endpoint: SessionEndpoint = SESSION_ENDPOINTS[0]!,
  ): Promise<unknown> {
    return this.withSession(
      (s) => {
        const qs = new URLSearchParams({ ...params, actionID: 'command', command, serial, sessionID: s.sessionId });
        return this.send(`${endpoint.url}?${qs}`, {
          method: 'GET',
          headers: { authorization: endpoint.auth === 'bearer' ? `Bearer ${s.idToken}` : s.idToken, api_key: API_KEY },
          // The iAqua channel carries writes as GETs: every set_* command changes equipment.
          write: !command.startsWith('get_'),
        });
      },
      { reauth: endpoint === SESSION_ENDPOINTS[0] },
    );
  }

  /**
   * Redact upstream text for a tool result via `truncateErrorMessage`: the
   * password and every live session token by value first (they have no
   * recognisable shape; raw and JSON-escaped), then secret shapes, then the
   * length cap — scrubbing before the cut so no half-secret survives it.
   */
  scrubText(text: string, max = 2_000): string {
    const s = this.session;
    return truncateErrorMessage(text, max, {
      values: [this.password, s?.sessionId, s?.authToken, s?.idToken, s?.refreshToken],
      placeholder: '[redacted]',
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
        body: { state: { desired } },
        write: true,
      }),
    );
  }

  // ── WebTouch ──────────────────────────────────────────────────────────────

  /**
   * Find the system's WebTouch location and initialise a panel session:
   * `GET /v2/userId` → `session_user_id`, `GET /v2/users/<id>/locations` →
   * the location's `touchLink` (both `Authorization: Bearer <IdToken>`), then
   * `GET /v2/webtouch/init?actionID=<touchLink>` (bare IdToken). The stream
   * URL must be https on an allowlisted host.
   */
  async webtouchInit(serial: string): Promise<WebTouchInit> {
    const bearer = (url: string) => this.withSession((s) => this.send(url, { method: 'GET', headers: { authorization: `Bearer ${s.idToken}` } }));
    const user = (await bearer(WEBTOUCH_USER_URL)) as { session_user_id?: unknown } | null;
    if (typeof user?.session_user_id !== 'string' && typeof user?.session_user_id !== 'number') {
      throw new McpToolError('WebTouch: iAqualink returned no user id.', { kind: 'http' });
    }
    const locs = (await bearer(`${PRM_ROOT}/users/${encodeURIComponent(String(user.session_user_id))}/locations`)) as unknown;
    const list = Array.isArray(locs) ? locs : (locs as { locations?: unknown } | null)?.locations;
    const loc = (Array.isArray(list) ? list : []).find(
      (l: Record<string, unknown>) => (l?.serial_number ?? l?.serial) === serial,
    ) as Record<string, unknown> | undefined;
    if (!loc) throw new McpToolError(`iAqualink lists no WebTouch location for ${serial}.`);
    const touchLink = loc.touchLink ?? loc.touch_link;
    if (typeof touchLink !== 'string' || !touchLink) throw new McpToolError(`The WebTouch location for ${serial} has no touchLink.`);
    const init = (await this.withSession((s) =>
      this.send(`${WEBTOUCH_INIT_URL}?${new URLSearchParams({ actionID: touchLink })}`, { method: 'GET', headers: { authorization: s.idToken } }),
    )) as Record<string, unknown> | null;
    const f = [init?.serverConnection, init?.actionIdMasterId, init?.actionIdMasterStart, init?.actionIdMasterSTB];
    if (!f.every((x) => typeof x === 'string' && x !== '')) {
      throw new McpToolError('WebTouch: unexpected init response (missing serverConnection / actionIdMaster* fields).', { kind: 'http' });
    }
    const [serverConnection, master, start, stb] = f as string[];
    const u = new URL(serverConnection!);
    if (u.protocol !== 'https:' || !this.streamHosts.includes(u.host.toLowerCase())) {
      throw new McpToolError(`WebTouch: the display stream host ${u.protocol}//${u.host} is not on the WebTouch allowlist.`, {
        hint: 'If iAqualink really serves the stream there, add the host to IAQUALINK_WEBTOUCH_STREAM_HOSTS (and, hosted, to mint.yaml egress).',
      });
    }
    return { serverConnection: serverConnection!, master: master!, start: start!, stb: stb! };
  }

  /** Press a panel button (or, with `text`, submit the keypad). 200 with an empty body. */
  async webtouchCommand(actionID: string, command: number, text?: string): Promise<void> {
    const body = { actionID, command: String(command), dt: String(this.now()), ...(text !== undefined ? { text } : {}) };
    await this.withSession((s) =>
      this.send(WEBTOUCH_COMMAND_URL, { method: 'POST', headers: { authorization: s.idToken }, body, write: true }),
    );
  }

  /**
   * Open the long-lived display stream. Unauthenticated (as ejc3's client does); closed via `signal`.
   * Uncompressed on purpose: with fetch's default gzip/br the panel's updates sat in a compressor
   * buffer and arrived in ~20 s bursts (live 2026-10-12); identity streams them as they happen.
   */
  async openWebTouchStream(url: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await this.fetchImpl(url, { method: 'GET', headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity' }, signal });
    if (res.status !== 200) throw new McpToolError(`WebTouch: the display stream answered ${res.status}.`, { kind: 'http', status: res.status });
    if (!res.body) throw new McpToolError('WebTouch: the display stream returned no body.', { kind: 'http' });
    return res.body;
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
