import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimitError, UnreachableError, McpToolError } from '@chrischall/mcp-utils';
import { IaqualinkClient, API_KEY } from '../src/client.js';
import { FakeIaqualink } from './support/fake-server.js';

const noSleep = async (): Promise<void> => {};

function make(server: FakeIaqualink, extra: Partial<ConstructorParameters<typeof IaqualinkClient>[0]> = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const client = new IaqualinkClient({
    email: 'me@example.com',
    password: server.password,
    fetchImpl: server.fetch,
    sleep: noSleep,
    now: clock.now,
    minIntervalMs: 0,
    ...extra,
  });
  return { client, clock };
}

describe('IaqualinkClient — configuration', () => {
  it('boots without credentials and defers the error to the first call', async () => {
    const client = new IaqualinkClient({ env: {}, fetchImpl: () => Promise.reject(new Error('no network expected')) });
    expect(client.describeCredential()).toEqual({ source: null, detail: { email: false, password: false } });
    const err = await client.listSystems().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('no_credential');
    expect((err as McpToolError).hint).toMatch(/IAQUALINK_EMAIL/);
  });

  it('names a half-configured credential', async () => {
    const client = new IaqualinkClient({ env: { IAQUALINK_EMAIL: 'me@example.com' } });
    expect(client.describeCredential()).toEqual({ source: null, detail: { email: true, password: false } });
    await expect(client.listSystems()).rejects.toThrow(/IAQUALINK_PASSWORD/);
  });

  it('reads both from the environment and keeps a password with surrounding spaces intact', async () => {
    const server = new FakeIaqualink();
    server.password = ' spaced pw ';
    const client = new IaqualinkClient({
      env: { IAQUALINK_EMAIL: ' me@example.com ', IAQUALINK_PASSWORD: ' spaced pw ' },
      fetchImpl: server.fetch,
      minIntervalMs: 0,
    });
    expect(client.describeCredential()).toEqual({
      source: 'IAQUALINK_EMAIL + IAQUALINK_PASSWORD',
      detail: { email: true, password: true },
    });
    await client.listSystems();
    const login = server.log.find((r) => r.url.pathname === '/users/v1/login')!;
    expect(login.body).toEqual({ api_key: API_KEY, email: 'me@example.com', password: ' spaced pw ' });
  });

  it('reads the status cache TTL from the environment', () => {
    const c = new IaqualinkClient({ env: { IAQUALINK_STATUS_CACHE_SECONDS: '12' } });
    expect(c.statusCacheMs).toBe(12_000);
    expect(new IaqualinkClient({ env: {} }).statusCacheMs).toBe(5_000);
    expect(new IaqualinkClient({ env: { IAQUALINK_STATUS_CACHE_SECONDS: '0' } }).statusCacheMs).toBe(0);
    expect(new IaqualinkClient({ env: { IAQUALINK_STATUS_CACHE_SECONDS: 'nope' } }).statusCacheMs).toBe(5_000);
  });

  it('defaults to the real fetch and process.env without throwing at construction', () => {
    expect(() => new IaqualinkClient()).not.toThrow();
  });
});

describe('IaqualinkClient — auth', () => {
  let server: FakeIaqualink;
  beforeEach(() => {
    server = new FakeIaqualink();
  });

  it('logs in once with the app headers and lists systems with the session tokens', async () => {
    const { client } = make(server);
    const systems = await client.listSystems();
    expect(systems.map((s) => s.serial_number)).toEqual(['IAQ123', 'EXO456', 'ZZZ789']);
    const [login, devices] = server.log;
    expect(login!.headers['user-agent']).toBe('okhttp/3.14.7');
    expect(login!.headers['content-type']).toBe('application/json');
    expect(devices!.url.searchParams.get('api_key')).toBe(API_KEY);
    expect(devices!.url.searchParams.get('authentication_token')).toBe('auth-tok');
    expect(devices!.url.searchParams.get('user_id')).toBe('user-123');
  });

  it('shares one login between concurrent calls', async () => {
    const { client } = make(server);
    await Promise.all([client.listSystems(), client.listSystems(), client.listSystems()]);
    expect(server.count('/users/v1/login')).toBe(1);
  });

  it('refreshes (without the api key) on a 401 and replays the call once', async () => {
    const { client } = make(server);
    await client.listSystems();
    server.expireSession();
    await client.listSystems();
    expect(server.count('/users/v1/login')).toBe(1);
    const refresh = server.log.find((r) => r.url.pathname === '/users/v1/refresh')!;
    expect(refresh.body).toEqual({ email: 'me@example.com', refresh_token: 'refresh-tok' });
    const last = server.log.at(-1)!;
    expect(last.url.searchParams.get('authentication_token')).toBe('auth-tok-2');
  });

  it('keeps the previous refresh token when a refresh response omits one', async () => {
    const { client } = make(server);
    await client.listSystems();
    server.expireSession();
    await client.listSystems(); // refresh #1 answers without RefreshToken
    server.expireSession();
    await client.listSystems(); // refresh #2 must still send the original token
    const refreshes = server.log.filter((r) => r.url.pathname === '/users/v1/refresh');
    expect(refreshes).toHaveLength(2);
    expect((refreshes[1]!.body as { refresh_token: string }).refresh_token).toBe('refresh-tok');
  });

  it('falls back to a full login when the refresh is refused', async () => {
    const { client } = make(server);
    await client.listSystems();
    server.expireSession();
    server.refreshValid = false;
    await client.listSystems();
    expect(server.count('/users/v1/refresh')).toBe(1);
    expect(server.count('/users/v1/login')).toBe(2);
  });

  it('logs in again (not refresh) when the login gave no refresh token', async () => {
    delete server.loginBody.userPoolOAuth.RefreshToken;
    const { client } = make(server);
    await client.listSystems();
    server.expireSession();
    await client.listSystems();
    expect(server.count('/users/v1/refresh')).toBe(0);
    expect(server.count('/users/v1/login')).toBe(2);
  });

  it('treats a devices.json 404 as an expired session, like iaqualink-py', async () => {
    const { client } = make(server);
    await client.listSystems();
    server.failNext(404, { match: /devices\.json/ });
    await expect(client.listSystems()).resolves.toHaveLength(3);
    expect(server.count('/users/v1/refresh')).toBe(1);
  });

  it('reports a session that is refused even after re-authenticating', async () => {
    const { client } = make(server);
    await client.listSystems();
    server.failNext(401, { match: /devices\.json/ });
    server.failNext(401, { match: /devices\.json/ });
    const err = (await client.listSystems().catch((e: unknown) => e)) as McpToolError;
    expect(err.kind).toBe('session_expired');
    expect(err.status).toBe(401);
  });

  it('never retries a rejected password — the refusal is latched until the credential changes', async () => {
    server.password = 'something else';
    const { client } = make(server, { password: 'wrong pw' });
    const first = (await client.listSystems().catch((e: unknown) => e)) as McpToolError;
    expect(first.kind).toBe('credential_rejected');
    expect(first.status).toBe(401);
    expect(first.hint).toMatch(/lock/i);
    expect(first.message).not.toContain('wrong pw');
    const second = (await client.listSystems().catch((e: unknown) => e)) as McpToolError;
    expect(second.kind).toBe('credential_rejected');
    expect(server.count('/users/v1/login')).toBe(1);
  });

  it('latches a login 403 the same as a 401', async () => {
    const { client } = make(server);
    server.failNext(403, { match: /login/ });
    const first = (await client.listSystems().catch((e: unknown) => e)) as McpToolError;
    expect(first.kind).toBe('credential_rejected');
    expect(first.status).toBe(403);
    const second = (await client.listSystems().catch((e: unknown) => e)) as McpToolError;
    expect(second.kind).toBe('credential_rejected');
    expect(server.count('/users/v1/login')).toBe(1);
  });

  it('surfaces a login 5xx as unreachable, without latching', async () => {
    const { client } = make(server);
    server.failNext(503, { match: /login/ });
    await expect(client.listSystems()).rejects.toBeInstanceOf(UnreachableError);
    await expect(client.listSystems()).resolves.toHaveLength(3);
  });

  it('rejects a login response missing the tokens it needs', async () => {
    const { client } = make(server);
    server.failNext(200, { match: /login/, body: { id: 'x' } });
    const err = (await client.listSystems().catch((e: unknown) => e)) as McpToolError;
    expect(err.message).toMatch(/unexpected login response/i);
  });
});

describe('IaqualinkClient — transport', () => {
  let server: FakeIaqualink;
  beforeEach(() => {
    server = new FakeIaqualink();
  });

  it('retries a 429 honouring Retry-After, then succeeds', async () => {
    const waits: number[] = [];
    const { client } = make(server, { sleep: async (ms) => void waits.push(ms) });
    server.failNext(429, { match: /devices/, headers: { 'retry-after': '2' } });
    await expect(client.listSystems()).resolves.toHaveLength(3);
    expect(waits).toEqual([2000]);
  });

  it('caps the Retry-After wait and falls back to a backoff when absent or unreadable', async () => {
    const waits: number[] = [];
    const { client } = make(server, { sleep: async (ms) => void waits.push(ms) });
    server.failNext(429, { match: /devices/, headers: { 'retry-after': '600' } });
    server.failNext(429, { match: /devices/, headers: { 'retry-after': 'soon' } });
    await client.listSystems();
    expect(waits).toEqual([10_000, 2_000]);
  });

  it('gives up after repeated 429s with a RateLimitError', async () => {
    const { client } = make(server);
    await client.listSystems();
    for (let i = 0; i < 3; i++) server.failNext(429, { match: /devices/, headers: { 'retry-after': '1' } });
    const err = await client.listSystems().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterSeconds).toBe(1);
  });

  it('reports a 5xx as unreachable with its status', async () => {
    const { client } = make(server);
    server.failNext(502, { match: /devices/ });
    const err = (await client.listSystems().catch((e: unknown) => e)) as UnreachableError;
    expect(err).toBeInstanceOf(UnreachableError);
    expect(err.status).toBe(502);
  });

  it('reports another error status with a redacted, password-free excerpt', async () => {
    const { client } = make(server);
    server.failNext(400, { match: /devices/, body: { message: `bad request for ${server.password}` } });
    const err = (await client.listSystems().catch((e: unknown) => e)) as McpToolError;
    expect(err.kind).toBe('http');
    expect(err.status).toBe(400);
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain(server.password);
  });

  it('refuses a non-JSON 200 rather than parsing it blind', async () => {
    const { client } = make(server);
    server.failNext(200, { match: /devices/, body: '<html>maintenance</html>' });
    await expect(client.listSystems()).rejects.toThrow(/JSON|non-JSON|format/i);
  });

  it('refuses a devices list that is not an array', async () => {
    const { client } = make(server);
    server.failNext(200, { match: /devices/, body: { devices: [] } });
    await expect(client.listSystems()).rejects.toThrow(/device list/i);
  });

  it('wraps a network failure as unreachable', async () => {
    const client = new IaqualinkClient({
      email: 'me@example.com',
      password: 'pw',
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
      minIntervalMs: 0,
    });
    const err = (await client.listSystems().catch((e: unknown) => e)) as McpToolError;
    expect(err.kind).toBe('transport');
    expect(err.message).toMatch(/prod\.zodiac-io\.com/);
  });
});

describe('IaqualinkClient — systems and status', () => {
  let server: FakeIaqualink;
  beforeEach(() => {
    server = new FakeIaqualink();
  });

  it('resolves a system by serial and refuses an unknown one with a hint', async () => {
    const { client } = make(server);
    expect((await client.getSystem('EXO456')).device_type).toBe('exo');
    const err = (await client.getSystem('NOPE').catch((e: unknown) => e)) as McpToolError;
    expect(err.message).toMatch(/NOPE/);
    expect(err.hint).toMatch(/iaqualink_list_systems/);
  });

  it('re-lists once when a serial is not in the cached list', async () => {
    const { client } = make(server);
    await client.listSystems();
    server.devices.push({ serial_number: 'NEW1', name: 'New', device_type: 'iaqua' });
    expect((await client.getSystem('NEW1')).name).toBe('New');
    expect(server.count('devices.json')).toBe(2);
  });

  it('sends iAqua commands on the session channel with Bearer + api_key headers', async () => {
    const { client } = make(server);
    await client.iaquaCommand('IAQ123', 'get_home');
    await client.iaquaCommand('IAQ123', 'set_temps', { temp1: '100', temp2: '84' });
    const call = server.log.at(-1)!;
    expect(call.method).toBe('GET');
    expect(call.headers.authorization).toBe('Bearer id-tok-1');
    expect(call.headers.api_key).toBe(API_KEY);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      temp1: '100',
      temp2: '84',
      actionID: 'command',
      command: 'set_temps',
      serial: 'IAQ123',
      sessionID: 'sess-1',
    });
  });

  it('reads and writes the eXO shadow with the raw IdToken', async () => {
    const { client } = make(server);
    await client.getExoShadow('EXO456');
    await client.setExoDesired('EXO456', { heating: { sp: 30 } });
    const post = server.log.at(-1)!;
    expect(post.method).toBe('POST');
    expect(post.url.href).toBe('https://prod.zodiac-io.com/devices/v1/EXO456/shadow');
    expect(post.headers.authorization).toBe('id-tok-1');
    expect(post.body).toEqual({ state: { desired: { heating: { sp: 30 } } } });
  });

  it('caches a status read per serial for the TTL, and bypasses it on request', async () => {
    const { client, clock } = make(server, { statusCacheMs: 5_000 });
    const a = await client.readRawStatus('IAQ123');
    expect(a.kind).toBe('iaqua');
    expect(server.commands()).toEqual(['get_home', 'get_devices']);
    await client.readRawStatus('IAQ123');
    expect(server.commands()).toHaveLength(2);
    await client.readRawStatus('IAQ123', { fresh: true });
    expect(server.commands()).toHaveLength(4);
    clock.advance(5_001);
    await client.readRawStatus('IAQ123');
    expect(server.commands()).toHaveLength(6);
    client.invalidate('IAQ123');
    await client.readRawStatus('IAQ123');
    expect(server.commands()).toHaveLength(8);
  });

  it('does not cache at all with a zero TTL', async () => {
    const { client } = make(server, { statusCacheMs: 0 });
    await client.readRawStatus('EXO456');
    await client.readRawStatus('EXO456');
    expect(server.count('/shadow')).toBe(2);
  });

  it('refuses a status read for an unsupported system type', async () => {
    const { client } = make(server);
    const err = (await client.readRawStatus('ZZZ789').catch((e: unknown) => e)) as McpToolError;
    expect(err.message).toMatch(/i2d_robot/);
  });
});

describe('IaqualinkClient — remaining paths', () => {
  it('uses the global fetch and a real timer by default', async () => {
    const server = new FakeIaqualink();
    const original = globalThis.fetch;
    globalThis.fetch = server.fetch as typeof fetch;
    try {
      const client = new IaqualinkClient({ email: 'me@example.com', password: server.password, minIntervalMs: 0 });
      server.failNext(429, { match: /devices/, headers: { 'retry-after': '0' } });
      await expect(client.listSystems()).resolves.toHaveLength(3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('passes a typed transport error (e.g. a timeout) through unchanged', async () => {
    const timeout = new McpToolError('timed out', { kind: 'timeout' });
    const client = new IaqualinkClient({ email: 'a@example.com', password: 'pw', fetchImpl: () => Promise.reject(timeout), minIntervalMs: 0 });
    await expect(client.listSystems()).rejects.toBe(timeout);
  });

  it('reports a refresh that fails for a reason other than 401, without logging in again', async () => {
    const server = new FakeIaqualink();
    const { client } = make(server);
    await client.listSystems();
    server.expireSession();
    server.failNext(503, { match: /refresh/ });
    await expect(client.listSystems()).rejects.toBeInstanceOf(UnreachableError);
    expect(server.count('/users/v1/login')).toBe(1);
  });

  it('reports a replay that fails for a reason other than 401', async () => {
    const server = new FakeIaqualink();
    const { client } = make(server);
    await client.listSystems();
    server.failNext(401, { match: /devices\.json/ });
    server.failNext(502, { match: /devices\.json/ });
    await expect(client.listSystems()).rejects.toBeInstanceOf(UnreachableError);
  });
});

describe('IaqualinkClient — alternate session endpoints (schedule probe)', () => {
  it('lists the candidates in the documented order, current endpoint first', async () => {
    const { SESSION_ENDPOINTS, IAQUA_SESSION_URL, P_API_SESSION_URL, PRM_SESSION_URL } = await import('../src/client.js');
    expect(SESSION_ENDPOINTS.map((e) => [e.id, e.url, e.auth])).toEqual([
      ['r-api-v2', IAQUA_SESSION_URL, 'bearer'],
      ['p-api-v2', P_API_SESSION_URL, 'bearer'],
      ['p-api-v2-bare', P_API_SESSION_URL, 'bare'],
      ['prm-v1', PRM_SESSION_URL, 'bare'],
    ]);
  });

  it('sends the Bearer or bare id token per endpoint, with the api_key header', async () => {
    const { SESSION_ENDPOINTS } = await import('../src/client.js');
    const server = new FakeIaqualink();
    const { client } = make(server);
    for (const e of SESSION_ENDPOINTS) await client.iaquaCommand('IAQ123', 'get_home', {}, e);
    const sent = server.log.filter((r) => r.url.pathname.endsWith('/session.json'));
    expect(sent.map((r) => [r.url.host, r.url.pathname, r.headers.authorization, r.headers.api_key])).toEqual([
      ['r-api.iaqualink.net', '/v2/mobile/session.json', 'Bearer id-tok-1', API_KEY],
      ['p-api.iaqualink.net', '/v2/mobile/session.json', 'Bearer id-tok-1', API_KEY],
      ['p-api.iaqualink.net', '/v2/mobile/session.json', 'id-tok-1', API_KEY],
      ['prm.iaqualink.net', '/v1/mobile/session.json', 'id-tok-1', API_KEY],
    ]);
  });

  it('never re-authenticates on a 401 from an alternate endpoint (reports it instead)', async () => {
    const { SESSION_ENDPOINTS } = await import('../src/client.js');
    const server = new FakeIaqualink();
    const { client } = make(server);
    await client.listSystems();
    server.failNext(401, { match: /p-api/ });
    const err = await client.iaquaCommand('IAQ123', 'get_home', {}, SESSION_ENDPOINTS[1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).status).toBe(401);
    expect((err as McpToolError).kind).toBe('http');
    expect(server.count('/users/v1/')).toBe(1);
  });

  it('scrubs the password and every session token out of text it reports', async () => {
    const server = new FakeIaqualink();
    const { client } = make(server);
    expect(client.scrubText('before sign-in')).toBe('before sign-in');
    await client.listSystems();
    const text = `sess-1 auth-tok id-tok-1 refresh-tok ${server.password} user-123 ok`;
    const out = client.scrubText(text);
    for (const secret of ['sess-1', 'auth-tok', 'id-tok-1', 'refresh-tok', server.password]) expect(out).not.toContain(secret);
    expect(out).toMatch(/ok$/);
  });
});
