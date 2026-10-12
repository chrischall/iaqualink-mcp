import { describe, it, expect } from 'vitest';
import { IaqualinkClient } from '../../src/client.js';
import { FakeIaqualink } from '../support/fake-server.js';
import { setup } from '../support/harness.js';

const scheduleCalls = (server: FakeIaqualink) =>
  server.log.filter((r) => r.url.searchParams.get('command') === 'get_schedule_list').map((r) => `${r.url.host}|${r.headers.authorization?.startsWith('Bearer') ? 'bearer' : 'bare'}`);
const shadowPosts = (server: FakeIaqualink) => server.log.filter((r) => r.method === 'POST' && r.url.pathname.endsWith('/shadow'));

describe('iaqualink_list_schedules — iAqua iQ20 probe', () => {
  it('falls back from the current host to the one that answers, and reports every attempt', async () => {
    const { call, server } = await setup();
    const r = await call('iaqualink_list_schedules', { serial: 'IAQ123' });
    expect(r).toMatchObject({ serial: 'IAQ123', type: 'iaqua', supported: true, firmware: '3.0', count: 2, totalCount: 2, isNewScheduleAllowed: true });
    expect(r.probe.answeredBy).toMatchObject({ id: 'p-api-v2', url: 'https://p-api.iaqualink.net/v2/mobile/session.json', auth: 'bearer' });
    expect(r.probe.attempts.map((a: any) => [a.endpoint, a.outcome, a.reason])).toEqual([
      ['r-api-v2', 'refused', 'no scheduleList (message: "unknown command")'],
      ['p-api-v2', 'answered', undefined],
    ]);
    expect(r.probe.attempts[1].body).toContain('scheduleList');
    expect(r.schedules.map((s: any) => [s.id, s.deviceId, s.device, s.start, s.stop, s.days])).toEqual([
      ['1', '2', 'Pool Light', '09:00', '17:00', 'AllDays'],
      ['2', '5', null, '19:30', '22:05', 'Weekends'],
    ]);
    expect(r.note).toMatch(/RS panel/);
    const list = server.log.find((x) => x.url.searchParams.get('command') === 'get_master_device_list')!;
    expect([list.url.host, list.url.searchParams.get('listType'), list.url.searchParams.get('pageNum')]).toEqual(['p-api.iaqualink.net', '1', '1']);
    expect(JSON.stringify(r)).not.toMatch(/id-tok|sess-1/);
  });

  it('tries the endpoint that answered last time first', async () => {
    const { call, server } = await setup();
    await call('iaqualink_list_schedules', { serial: 'IAQ123' });
    await call('iaqualink_list_schedules', { serial: 'IAQ123' });
    expect(scheduleCalls(server)).toEqual(['r-api.iaqualink.net|bearer', 'p-api.iaqualink.net|bearer', 'p-api.iaqualink.net|bearer']);
  });

  it('records a failing endpoint (status kept) and moves on, trying each exactly once', async () => {
    const server = new FakeIaqualink();
    server.scheduleEndpoint = 'prm-v1';
    server.failNext(404, { match: /p-api.*get_schedule_list/ });
    const { call } = await setup({ server });
    const r = await call('iaqualink_list_schedules', { serial: 'IAQ123' });
    expect(r.probe.attempts.map((a: any) => [a.endpoint, a.outcome, a.status])).toEqual([
      ['r-api-v2', 'refused', undefined],
      ['p-api-v2', 'failed', 404],
      ['p-api-v2-bare', 'refused', undefined],
      ['prm-v1', 'answered', undefined],
    ]);
  });

  it('says unsupported, with every attempt, when no endpoint answers — and forgets a stale endpoint', async () => {
    const server = new FakeIaqualink();
    const { call } = await setup({ server });
    await call('iaqualink_list_schedules', { serial: 'IAQ123' });
    server.scheduleEndpoint = null;
    const r = await call('iaqualink_list_schedules', { serial: 'IAQ123' });
    expect(r).toMatchObject({ supported: false, probe: { answeredBy: null } });
    expect(r.probe.attempts.map((a: any) => a.endpoint)).toEqual(['p-api-v2', 'r-api-v2', 'p-api-v2-bare', 'prm-v1']);
    expect(r.note).toMatch(/built-in programs/);
    server.scheduleEndpoint = 'p-api-v2';
    const again = await call('iaqualink_list_schedules', { serial: 'IAQ123' });
    expect(again.probe.attempts[0].endpoint).toBe('r-api-v2');
  });

  it('reports an is_error answer as refused', async () => {
    const server = new FakeIaqualink();
    server.scheduleEndpoint = 'r-api-v2';
    server.scheduleError = 'Schedules not supported';
    const { call } = await setup({ server });
    const r = await call('iaqualink_list_schedules', { serial: 'IAQ123' });
    expect(r.supported).toBe(false);
    expect(r.probe.attempts[0]).toMatchObject({ outcome: 'refused', reason: 'is_error: Schedules not supported' });
  });

  it('does not probe when the adapter firmware is below 3', async () => {
    const server = new FakeIaqualink();
    server.homeExtras.attached_system_fw_version = '2.0';
    const { call } = await setup({ server });
    const r = await call('iaqualink_list_schedules', { serial: 'IAQ123' });
    expect(r).toMatchObject({ supported: false, firmware: '2.0' });
    expect(r.reason).toMatch(/firmware 2\.0/);
    expect(scheduleCalls(server)).toEqual([]);
  });

  it('probes when the firmware is unknown or empty', async () => {
    for (const fw of [undefined, '']) {
      const server = new FakeIaqualink();
      server.homeExtras = fw === undefined ? {} : { attached_system_fw_version: fw };
      const { call } = await setup({ server });
      const r = await call('iaqualink_list_schedules', { serial: 'IAQ123' });
      expect(r.supported).toBe(true);
      expect(r.firmware).toBe(fw ?? null);
    }
  });

  it('still lists schedules when the device list fails, saying why names are missing', async () => {
    const server = new FakeIaqualink();
    server.failNext(400, { match: /get_master_device_list/, body: { message: 'nope' } });
    const { call } = await setup({ server });
    const r = await call('iaqualink_list_schedules', { serial: 'IAQ123' });
    expect(r.schedules[0].device).toBeNull();
    expect(r.deviceListError).toMatch(/400/);
  });

  it('stops the probe on a rate limit or a refused sign-in', async () => {
    const server = new FakeIaqualink();
    for (let i = 0; i < 3; i++) server.failNext(429, { match: /get_schedule_list/ });
    const { fail } = await setup({ server });
    expect(await fail('iaqualink_list_schedules', { serial: 'IAQ123' })).toMatch(/rate/i);
    expect(scheduleCalls(server)).toHaveLength(3);

    const bad = new FakeIaqualink();
    const client = new IaqualinkClient({ email: 'me@example.com', password: 'wrong', fetchImpl: bad.fetch, minIntervalMs: 0, statusCacheMs: 0 });
    const s2 = await setup({ server: bad, client });
    expect(await s2.fail('iaqualink_list_schedules', { serial: 'IAQ123' })).toMatch(/rejected/);
  });
});

describe('iaqualink_list_schedules — eXO', () => {
  it('lists the shadow timers', async () => {
    const { call } = await setup();
    const r = await call('iaqualink_list_schedules', { serial: 'EXO456' });
    expect(r).toMatchObject({ type: 'exo', supported: true, slots: 6, programmed: 2 });
    expect(r.schedules.find((s: any) => s.id === 'sch3')).toMatchObject({ device: 'Filter Pump 1', start: '08:00', stop: '18:00', enabled: true });
  });

  it('says unsupported when the shadow has no schedules', async () => {
    const server = new FakeIaqualink();
    delete server.shadow.state.reported.schedules;
    const { call } = await setup({ server });
    expect(await call('iaqualink_list_schedules', { serial: 'EXO456' })).toMatchObject({ supported: false });
  });
});

describe('iaqualink_set_schedule (eXO)', () => {
  it('sets a timer window and confirms it from the shadow', async () => {
    const { confirmed, server } = await setup();
    const { preview, result } = await confirmed('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'filter pump 1', start: '07:00', stop: '19:00' });
    expect(preview.preview.current).toEqual({ enabled: true, start: '08:00', stop: '18:00' });
    expect(result).toMatchObject({ status: 'confirmed', observed: { enabled: true, start: '07:00', stop: '19:00' } });
    expect(result.caveat).toMatch(/unverified/);
    expect(shadowPosts(server)[0]!.body).toEqual({ state: { desired: { schedules: { sch3: { enabled: 1, timer: { start: '07:00', end: '19:00' } } } } } });
  });

  it('sets rpm on a variable-speed pump timer, keeping rpm when not given', async () => {
    const { confirmed, server } = await setup();
    const { result } = await confirmed('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'vsp_2', start: '08:00', stop: '09:00', rpm: 2000 });
    expect(result).toMatchObject({ status: 'confirmed', observed: { rpm: 2000 } });
    expect((shadowPosts(server)[0]!.body as any).state.desired.schedules.sch4.rpm).toBe(2000);
    const second = await confirmed('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch4', start: '08:00', stop: '10:00' });
    expect(second.result).toMatchObject({ status: 'confirmed', requested: { rpm: 2000 } });
    expect((shadowPosts(server)[1]!.body as any).state.desired.schedules.sch4).not.toHaveProperty('rpm');
  });

  it('disables a timer by clearing it to 00:00–00:00', async () => {
    const { confirmed, server } = await setup();
    await confirmed('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch1', enabled: false });
    expect(shadowPosts(server)[0]!.body).toEqual({ state: { desired: { schedules: { sch1: { enabled: 0, timer: { start: '00:00', end: '00:00' } } } } } });
  });

  it('reports an unchanged timer without sending', async () => {
    const { call, server } = await setup();
    expect((await call('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch3', start: '08:00', stop: '18:00' })).status).toBe('unchanged');
    expect(shadowPosts(server)).toEqual([]);
  });

  it('reports a change the eXO has not reported back', async () => {
    const { confirmed, server } = await setup();
    server.exoLag = true;
    const { result } = await confirmed('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch3', start: '07:00', stop: '18:00' });
    expect(result.status).toBe('sent-unconfirmed');
  });

  it('refuses bad requests with the reason', async () => {
    const server = new FakeIaqualink();
    server.shadow.state.reported.schedules.sch5 = { id: 'sch_5', timer: { start: '00:00', end: '00:00' }, enabled: 0 };
    const { fail } = await setup({ server });
    expect(await fail('iaqualink_set_schedule', { serial: 'IAQ123', schedule: '1', start: '09:00', stop: '10:00' })).toMatch(/only supported on eXO/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'nope', start: '09:00', stop: '10:00' })).toMatch(/sch3 \(Filter Pump 1\)/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch3', start: '09:00', stop: '10:00', rpm: 1500 })).toMatch(/not a variable-speed/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch5', start: '09:00', stop: '10:00', rpm: 1500 })).toMatch(/sch5 is not a variable-speed/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch3', start: '09:00' })).toMatch(/both start and stop/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch3', stop: '09:00' })).toMatch(/both start and stop/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch3', start: '10:00', stop: '09:00' })).toMatch(/after the start/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch3', start: '25:00', stop: '26:00' })).toMatch(/HH:MM/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch9', enabled: false, start: '01:00' })).toMatch(/takes no start/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch9', enabled: false, stop: '01:00' })).toMatch(/takes no start/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch4', enabled: false, rpm: 1000 })).toMatch(/takes no start/);
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch1', start: '07:00', stop: '12:00' })).toMatch(/inside the pump timer/);
  });

  it('names a nameless timer by its key, and reports one that vanished on re-read', async () => {
    const server = new FakeIaqualink();
    server.shadow.state.reported.schedules.sch5 = { id: 'sch_5', timer: { start: '01:00', end: '02:00' }, enabled: 1 };
    const { confirmed } = await setup({ server });
    const on = await confirmed('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch5', start: '03:00', stop: '04:00' });
    expect(on.preview.summary ?? JSON.stringify(on.preview)).toMatch(/sch5 \(sch5\)/);
    server.afterWrite = () => {
      delete server.shadow.state.reported.schedules.sch5;
    };
    const off = await confirmed('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch5', enabled: false });
    expect(JSON.stringify(off.preview)).toMatch(/Disable sch5 \(sch5\)/);
    expect(off.result).toMatchObject({ status: 'sent-unconfirmed' });
    expect(off.result.observed).toBeUndefined();
  });

  it('lists none when the shadow has no timers', async () => {
    const server = new FakeIaqualink();
    delete server.shadow.state.reported.schedules;
    const { fail } = await setup({ server });
    expect(await fail('iaqualink_set_schedule', { serial: 'EXO456', schedule: 'sch1', enabled: false })).toMatch(/Timers: none/);
  });
});
