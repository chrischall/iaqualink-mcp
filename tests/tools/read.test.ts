import { describe, it, expect } from 'vitest';
import { IaqualinkClient } from '../../src/client.js';
import { FakeIaqualink } from '../support/fake-server.js';
import { setup } from '../support/harness.js';

describe('iaqualink_list_systems', () => {
  it('lists systems compactly by default, flagging unsupported types', async () => {
    const { call } = await setup();
    expect(await call('iaqualink_list_systems')).toEqual([
      { serial: 'IAQ123', name: 'Pool', type: 'iaqua', supported: true },
      { serial: 'EXO456', name: 'Salt', type: 'exo', supported: true },
      { serial: 'ZZZ789', name: 'Robot', type: 'i2d_robot', supported: false },
    ]);
  });

  it('adds the record in full and returns it untouched in raw', async () => {
    const { call } = await setup();
    const full = await call<any[]>('iaqualink_list_systems', { view: 'full' });
    expect(full[0]).toMatchObject({ serial: 'IAQ123', created_at: '2017-09-23T01:00:08.000Z' });
    const raw = await call<any[]>('iaqualink_list_systems', { view: 'raw' });
    expect(raw[0]).not.toHaveProperty('serial');
    expect(raw[0].serial_number).toBe('IAQ123');
  });

  it('names a nameless system null', async () => {
    const server = new FakeIaqualink();
    server.devices = [{ serial_number: 'A1', device_type: 'iaqua' }];
    const { call } = await setup({ server });
    expect(await call('iaqualink_list_systems')).toEqual([{ serial: 'A1', name: null, type: 'iaqua', supported: true }]);
  });
});

describe('iaqualink_get_status', () => {
  it('returns the normalized iAqua status', async () => {
    const { call } = await setup();
    const s = await call('iaqualink_get_status', { serial: 'IAQ123' });
    expect(s).toMatchObject({ type: 'iaqua', temperatures: { pool: 80 }, equipment: { pool_pump: 'on' } });
    expect(s).not.toHaveProperty('homeEntries');
  });

  it('returns the normalized eXO status', async () => {
    const { call } = await setup();
    const s = await call('iaqualink_get_status', { serial: 'EXO456' });
    expect(s).toMatchObject({ type: 'exo', chlorinator: { outputPercent: 50 } });
  });

  it('honours full and raw', async () => {
    const { call } = await setup();
    expect(await call('iaqualink_get_status', { serial: 'IAQ123', view: 'full' })).toHaveProperty('homeEntries');
    const raw = await call('iaqualink_get_status', { serial: 'IAQ123', view: 'raw' });
    expect(Object.keys(raw)).toEqual(['home', 'devices']);
    expect(raw.home.home_screen[0]).toEqual({ status: 'Online' });
    const exo = await call('iaqualink_get_status', { serial: 'EXO456', view: 'raw' });
    expect(exo.shadow.deviceId).toBe('123');
  });

  it('refuses a malformed serial before any request', async () => {
    const { fail, server } = await setup();
    expect(await fail('iaqualink_get_status', { serial: '../x' })).toMatch(/serial/);
    expect(server.log).toHaveLength(0);
  });

  it('surfaces an unknown serial with the remedy', async () => {
    const { fail } = await setup();
    expect(await fail('iaqualink_get_status', { serial: 'NOPE' })).toMatch(/iaqualink_list_systems/);
  });
});

describe('iaqualink_healthcheck', () => {
  it('reports ok with the credential source and never the value', async () => {
    const { call, server } = await setup();
    const r = await call('iaqualink_healthcheck');
    expect(r.ok).toBe(true);
    expect(r.credential.source).toBe('IAQUALINK_EMAIL + IAQUALINK_PASSWORD');
    expect(JSON.stringify(r)).not.toContain(server.password);
  });

  it('skips the probe without a credential', async () => {
    const server = new FakeIaqualink();
    const { call } = await setup({ server, client: new IaqualinkClient({ env: {}, fetchImpl: server.fetch }) });
    const r = await call('iaqualink_healthcheck');
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('no_credential');
    expect(server.log).toHaveLength(0);
  });

  it('reports a rejected password', async () => {
    const server = new FakeIaqualink();
    const client = new IaqualinkClient({ email: 'me@example.com', password: 'wrong', fetchImpl: server.fetch, minIntervalMs: 0 });
    const { call } = await setup({ server, client });
    const r = await call('iaqualink_healthcheck');
    expect(r.ok).toBe(false);
    expect(r.error.kind).toBe('credential_rejected');
    expect(r.hint).toMatch(/will not retry/);
  });
});
