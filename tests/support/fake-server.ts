/**
 * An in-memory iAqualink: login/refresh, devices.json, the iAqua session.json
 * command channel (with its TOGGLE semantics) and the eXO shadow. Shapes come
 * from ./fixtures.ts; behaviour mirrors what iaqualink-py expects of the
 * service. Used as the `fetchImpl` of a real IaqualinkClient, so the tests
 * drive the real request-building, auth, retry and parsing code.
 */
import {
  DEVICES,
  IAQUA_AUX,
  IAQUA_HOME_STATE,
  IQ20_MASTER_DEVICES,
  IQ20_SCHEDULES,
  LOGIN_OK,

  REFRESH_OK,
  devicesScreen,
  exoShadow,
  homeScreen,

  type AuxState,
  type HomeState,
} from './fixtures.js';

import { FakeWebTouch, WT_INIT } from './fake-webtouch.js';

export interface LoggedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

type Json = Record<string, any>;

function deepMerge(target: Json, patch: Json): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

export class FakeIaqualink {
  password = 'correct horse';
  home: HomeState = structuredClone(IAQUA_HOME_STATE);
  aux: Record<string, AuxState> = structuredClone(IAQUA_AUX);
  shadow: Json = exoShadow();
  devices: Json[] = structuredClone(DEVICES);
  homeStatus = 'Online';
  scale = 'F';
  /** When true, eXO desired writes are accepted but never reach `reported`. */
  exoLag = false;
  /** When true, iAqua commands answer 200 but change nothing. */
  iaquaIgnoresCommands = false;
  refreshValid = true;
  /** Called after any state-changing command/write is applied. */
  afterWrite: (() => void) | undefined;
  /** Login-response override (e.g. to drop the RefreshToken). */
  loginBody: Json = structuredClone(LOGIN_OK);
  /** Top-level get_home fields outside home_screen (iaqualink-py docs iaqua.md "Top-level response fields"). */
  homeExtras: Json = { onetouch: 'true', attached_system_fw_version: '3.0' };
  /**
   * Which session endpoint (client SESSION_ENDPOINTS id) answers the iQ20
   * schedule/device-list commands. The others reply "unknown command" — the
   * live answer is not known yet, which is why the client probes.
   */
  scheduleEndpoint: string | null = 'p-api-v2';
  schedules: Json[] = structuredClone(IQ20_SCHEDULES);
  masterDevices: Json[] = structuredClone(IQ20_MASTER_DEVICES);
  isNewScheduleAllowed = true;
  /** When set, get_schedule_list answers `is_error: true` with this response text. */
  scheduleError: string | undefined;

  /** The RS panel behind WebTouch. */
  readonly webtouch = new FakeWebTouch();
  /** prm /v2/users/<id>/locations body. */
  locations: unknown = [{ serial_number: 'IAQ123', name: 'Pool', touchLink: 'TOUCH-123' }];
  /** /v2/webtouch/init body. */
  webtouchInit: Json = structuredClone(WT_INIT);

  readonly log: LoggedRequest[] = [];
  private authToken = '';
  private idToken = '';
  private sessionId = '';
  private queued: Array<{ status: number; body?: unknown; headers?: Record<string, string>; match?: RegExp }> = [];

  /**
   * When set, the NEXT matching request is APPLIED and then its connection
   * drops before any response (consumed once) — a write whose outcome the
   * client cannot know.
   */
  dropAfterApply: RegExp | undefined;

  /** Make the NEXT matching request answer `status` (consumed once). */
  failNext(status: number, opts: { body?: unknown; headers?: Record<string, string>; match?: RegExp } = {}): void {
    this.queued.push({ status, ...opts });
  }

  /** Invalidate every issued token — the next authed call answers 401. */
  expireSession(): void {
    this.authToken = 'expired';
    this.idToken = 'expired';
    this.sessionId = 'expired';
  }

  count(pathPart: string): number {
    return this.log.filter((r) => r.url.href.includes(pathPart)).length;
  }

  commands(): string[] {
    return this.log.filter((r) => r.url.pathname.endsWith('/session.json')).map((r) => r.url.searchParams.get('command') ?? '');
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    this.log.push({ method, url, headers, body });

    const qi = this.queued.findIndex((q) => !q.match || q.match.test(url.href));
    if (qi >= 0) {
      const [q] = this.queued.splice(qi, 1);
      return this.reply(q!.status, q!.body ?? { message: `status ${q!.status}` }, q!.headers);
    }
    if (this.dropAfterApply?.test(url.href)) {
      this.dropAfterApply = undefined;
      this.route(method, url, headers, body, init.signal ?? undefined);
      throw new TypeError('fetch failed', { cause: new Error('socket hang up') });
    }
    return this.route(method, url, headers, body, init.signal ?? undefined);
  };

  private reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  private issue(data: Json): Json {
    this.authToken = data.authentication_token;
    this.sessionId = data.session_id;
    this.idToken = data.userPoolOAuth.IdToken;
    return data;
  }

  private route(method: string, url: URL, headers: Record<string, string>, body: Json | undefined, signal?: AbortSignal): Response {
    const path = `${url.host}${url.pathname}`;
    const wt = this.webtouchRoute(method, path, url, headers, body, signal);
    if (wt) return wt;
    if (path === 'prod.zodiac-io.com/users/v1/login' && method === 'POST') {
      if (body?.api_key !== 'EOOEMOW4YR6QNB07' || body?.password !== this.password) {
        return this.reply(401, { message: 'Authorization Required' });
      }
      return this.reply(200, this.issue(structuredClone(this.loginBody)));
    }
    if (path === 'prod.zodiac-io.com/users/v1/refresh' && method === 'POST') {
      if (!this.refreshValid || body?.refresh_token !== 'refresh-tok') return this.reply(401, { message: 'Unauthorized' });
      return this.reply(200, this.issue(structuredClone(REFRESH_OK)));
    }
    if (path === 'r-api.iaqualink.net/devices.json') {
      if (url.searchParams.get('authentication_token') !== this.authToken || !this.authToken) {
        return this.reply(401, { message: 'Unauthorized' });
      }
      return this.reply(200, this.devices);
    }
    const endpoint = this.sessionEndpoint(path, headers.authorization);
    if (endpoint !== undefined) {
      if (!endpoint || url.searchParams.get('sessionID') !== this.sessionId) {
        return this.reply(401, { message: 'Unauthorized' });
      }
      return this.iaqua(url.searchParams, endpoint);
    }
    const shadow = /^prod\.zodiac-io\.com\/devices\/v1\/([^/]+)\/shadow$/.exec(path);
    if (shadow) {
      if (headers.authorization !== this.idToken || !this.idToken) return this.reply(401, { message: 'Unauthorized' });
      if (method === 'POST') {
        if (!this.exoLag) deepMerge(this.shadow.state.reported, body!.state.desired);
        this.afterWrite?.();
        return this.reply(200, { state: { desired: body!.state.desired } });
      }
      return this.reply(200, this.shadow);
    }
    return this.reply(404, { message: 'not found' });
  }

  /** prm.iaqualink.net/v2 — the WebTouch bootstrap (ejc3/iaqualink-webtouch client.py:100-163) and the panel's command/stream. */
  private webtouchRoute(method: string, path: string, url: URL, headers: Record<string, string>, body: Json | undefined, signal?: AbortSignal): Response | undefined {
    const bearer = headers.authorization === `Bearer ${this.idToken}` && Boolean(this.idToken);
    const bare = headers.authorization === this.idToken && Boolean(this.idToken);
    if (path === 'prm.iaqualink.net/v2/userId') return bearer ? this.reply(200, { session_user_id: 'u-77' }) : this.reply(401, {});
    if (path === 'prm.iaqualink.net/v2/users/u-77/locations') return bearer ? this.reply(200, this.locations) : this.reply(401, {});
    if (path === 'prm.iaqualink.net/v2/webtouch/init') {
      if (!bare) return this.reply(401, {});
      return url.searchParams.get('actionID') === 'TOUCH-123' ? this.reply(200, this.webtouchInit) : this.reply(404, { message: 'no such location' });
    }
    if (path === 'prm.iaqualink.net/v2/webtouch/command' && method === 'POST') {
      if (!bare) return this.reply(401, {});
      this.webtouch.command(String(body!.actionID), String(body!.command), body!.text === undefined ? undefined : String(body!.text));
      return new Response('', { status: 200 });
    }
    if (path === 'prm.iaqualink.net/v2/webtouch/stream') return this.webtouch.stream(signal);
    return undefined;
  }

  /**
   * The session endpoint a request reached: its client id, '' when the token
   * is wrong for it, undefined when the path is not a session endpoint.
   */
  private sessionEndpoint(path: string, auth: string | undefined): string | undefined {
    const bearer = auth === `Bearer ${this.idToken}`;
    const bare = auth === this.idToken;
    if (path === 'r-api.iaqualink.net/v2/mobile/session.json') return bearer ? 'r-api-v2' : '';
    if (path === 'p-api.iaqualink.net/v2/mobile/session.json') return bearer ? 'p-api-v2' : bare ? 'p-api-v2-bare' : '';
    if (path === 'prm.iaqualink.net/v1/mobile/session.json') return bare ? 'prm-v1' : '';
    return undefined;
  }

  private homeBody() {
    return { ...this.homeExtras, ...homeScreen(this.home, { status: this.homeStatus, scale: this.scale }) };
  }

  private scheduleBody(): Json {
    if (this.scheduleError !== undefined) {
      return { is_error: true, response: this.scheduleError, count: 0, totalCount: 0, scheduleList: [] };
    }
    return {
      serial: 'IAQ123',
      device_status: 'online',
      is_error: false,
      count: this.schedules.length,
      totalCount: this.schedules.length,
      pageNum: 1,
      isNewScheduleAllowed: this.isNewScheduleAllowed,
      scheduleList: this.schedules,
      response: 'success',
    };
  }

  private scheduleCommand(cmd: string): Response {
    if (cmd === 'get_master_device_list') {
      const list = this.masterDevices;
      return this.reply(200, { is_error: false, count: list.length, totalCount: list.length, listType: 1, pageNum: 1, deviceList: list, response: 'success' });
    }
    return this.reply(200, this.scheduleBody());
  }

  private iaqua(q: URLSearchParams, endpoint: string): Response {
    const cmd = q.get('command') ?? '';
    const devicesBody = () => devicesScreen(this.aux, { status: this.homeStatus });
    if (/schedule|master_device/.test(cmd)) {
      if (endpoint !== this.scheduleEndpoint) return this.reply(200, { message: 'unknown command' });
      return this.scheduleCommand(cmd);
    }
    if (cmd === 'get_home') return this.reply(200, this.homeBody());
    if (cmd === 'get_devices') return this.reply(200, devicesBody());
    this.afterWrite?.();
    if (this.iaquaIgnoresCommands) {
      return this.reply(200, cmd.startsWith('set_aux') || cmd === 'set_light' ? devicesBody() : this.homeBody());
    }
    const toggle = /^set_(pool_pump|spa_pump|pool_heater|spa_heater|solar_heater)$/.exec(cmd);
    if (toggle) {
      const name = toggle[1]!;
      const on = ['1', '3'].includes(this.home[name] ?? '0');
      this.home[name] = on ? '0' : name.endsWith('_heater') ? '3' : '1';
      return this.reply(200, this.homeBody());
    }
    const aux = /^set_aux_(\w+)$/.exec(cmd);
    if (aux) {
      const a = this.aux[`aux_${aux[1]}`];
      if (a) a.state = a.state === '1' ? '0' : '1';
      return this.reply(200, devicesBody());
    }
    if (cmd === 'set_light') {
      const a = this.aux[`aux_${q.get('aux')}`]!;
      const light = q.get('light') ?? '0';
      if (a.type === '1') a.subtype = light;
      a.state = light === '0' ? '0' : '1';
      return this.reply(200, devicesBody());
    }
    if (cmd === 'set_temps') {
      const hasSpa = 'spa_set_point' in this.home;
      if (hasSpa) {
        this.home.spa_set_point = q.get('temp1') ?? this.home.spa_set_point!;
        this.home.pool_set_point = q.get('temp2') ?? this.home.pool_set_point!;
      } else {
        this.home.pool_set_point = q.get('temp1') ?? this.home.pool_set_point!;
      }
      return this.reply(200, this.homeBody());
    }
    return this.reply(200, { message: 'unknown command' });
  }
}
