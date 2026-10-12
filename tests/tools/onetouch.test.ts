import { describe, it, expect } from 'vitest';
import { FakeIaqualink } from '../support/fake-server.js';
import { setup } from '../support/harness.js';

const toggles = (server: FakeIaqualink) => server.commands().filter((c) => c.startsWith('set_onetouch'));

describe('iaqualink_list_onetouch', () => {
  it('lists the scenes with their on state', async () => {
    const { call } = await setup();
    const r = await call('iaqualink_list_onetouch', { serial: 'IAQ123' });
    expect(r).toMatchObject({ serial: 'IAQ123', supported: true, online: true });
    expect(r.scenes[1]).toEqual({ onetouch: '2', label: 'Spa Mode', enabled: true, on: false });
    expect(r.scenes[3]).toMatchObject({ onetouch: '4', enabled: false });
  });

  it('says unsupported when the panel reports OneTouch disabled', async () => {
    const server = new FakeIaqualink();
    server.homeExtras.onetouch = 'false';
    const { call } = await setup({ server });
    expect(await call('iaqualink_list_onetouch', { serial: 'IAQ123' })).toMatchObject({ supported: false });
    expect(server.commands()).not.toContain('get_onetouch');
  });

  it('reports an offline OneTouch screen', async () => {
    const server = new FakeIaqualink();
    server.onetouchStatus = 'Offline';
    const { call } = await setup({ server });
    expect(await call('iaqualink_list_onetouch', { serial: 'IAQ123' })).toMatchObject({ online: false, scenes: [], note: expect.stringMatching(/Offline/) });
  });

  it('is iAqua-only', async () => {
    const { fail } = await setup();
    expect(await fail('iaqualink_list_onetouch', { serial: 'EXO456' })).toMatch(/only on iAqua/);
  });
});

describe('iaqualink_set_onetouch', () => {
  it('toggles a scene found by label and confirms it', async () => {
    const { confirmed, server } = await setup();
    const { preview, result } = await confirmed('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: 'spa mode', on: true });
    expect(JSON.stringify(preview.preview)).toContain('set_onetouch_2');
    expect(result).toMatchObject({ status: 'confirmed', target: 'onetouch_2', previous: false, observed: true });
    expect(toggles(server)).toEqual(['set_onetouch_2']);
  });

  it('sends nothing when already in the requested state', async () => {
    const { call, server } = await setup();
    expect((await call('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: '1', on: false })).status).toBe('unchanged');
    expect(toggles(server)).toEqual([]);
  });

  it('reports a toggle the panel did not apply', async () => {
    const { confirmed, server } = await setup();
    server.iaquaIgnoresCommands = true;
    const { result } = await confirmed('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: 'onetouch_3', on: true });
    expect(result.status).toBe('sent-unconfirmed');
    expect(result.note).toMatch(/toggle/);
  });

  it('refuses unknown or unconfigured scenes, and an offline screen', async () => {
    const { fail, server } = await setup();
    expect(await fail('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: '4', on: true })).toMatch(/1 \(All OFF\)/);
    expect(await fail('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: 'party', on: true })).toMatch(/no configured OneTouch/);
    server.onetouch = {};
    expect(await fail('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: '1', on: true })).toMatch(/Scenes: none/);
    server.onetouchStatus = 'Service';
    expect(await fail('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: '1', on: true })).toMatch(/Service/);
    expect(await fail('iaqualink_set_onetouch', { serial: 'EXO456', onetouch: '1', on: true })).toMatch(/only on iAqua/);
  });
});
