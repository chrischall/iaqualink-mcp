import { describe, it, expect } from 'vitest';
import { FakeIaqualink } from '../support/fake-server.js';
import { setup } from '../support/harness.js';

const sets = (server: FakeIaqualink) => server.commands().filter((c) => c.startsWith('set_'));
const shadowPosts = (server: FakeIaqualink) => server.log.filter((r) => r.method === 'POST' && r.url.pathname.endsWith('/shadow'));

describe('confirmation gate', () => {
  it('previews without sending, binds the account, then sends exactly once on the token call', async () => {
    const { call, server } = await setup();
    const preview = await call('iaqualink_set_equipment', { serial: 'IAQ123', equipment: 'pool_pump', on: false });
    expect(preview.status).toBe('confirmation-required');
    expect(JSON.stringify(preview.preview)).toContain('set_pool_pump');
    expect(preview.preview.current).toBe(true);
    expect(sets(server)).toEqual([]);
    const result = await call('iaqualink_set_equipment', {
      serial: 'IAQ123',
      equipment: 'pool_pump',
      on: false,
      confirmToken: preview.confirmToken,
    });
    expect(result).toMatchObject({ status: 'confirmed', previous: true, requested: false, observed: false });
    expect(sets(server)).toEqual(['set_pool_pump']);
  });

  it('a toggle whose connection drops after sending says the outcome is unknown, and the next read is fresh (fleet-audit#1268)', async () => {
    const { call, fail, server, client } = await setup();
    // A status cache the failed write must not leave stale.
    (client as unknown as { statusCacheMs: number }).statusCacheMs = 60_000;
    const preview = await call('iaqualink_set_equipment', { serial: 'IAQ123', equipment: 'pool_pump', on: false });
    server.dropAfterApply = /command=set_pool_pump/;
    const text = await fail('iaqualink_set_equipment', {
      serial: 'IAQ123',
      equipment: 'pool_pump',
      on: false,
      confirmToken: preview.confirmToken,
    });
    expect(text).toMatch(/may already have been applied/);
    expect(text).toContain('iaqualink_get_status');
    expect(text).not.toMatch(/Check the network/);
    expect(server.home.pool_pump).toBe('0'); // it did land
    const status = await call('iaqualink_get_status', { serial: 'IAQ123' });
    expect(JSON.stringify(status)).toMatch(/"pool_pump":(false|"off"|0)/);
  });

  it('sends nothing when the state already changed to the request between preview and confirm (toggle safety)', async () => {
    const { call, server } = await setup();
    const preview = await call('iaqualink_set_equipment', { serial: 'IAQ123', equipment: 'pool_pump', on: false });
    server.home.pool_pump = '0';
    const result = await call('iaqualink_set_equipment', {
      serial: 'IAQ123',
      equipment: 'pool_pump',
      on: false,
      confirmToken: preview.confirmToken,
    });
    expect(result.status).toBe('unchanged');
    expect(sets(server)).toEqual([]);
  });

  it('refuses a token whose planned-against state has moved', async () => {
    const { call, h, server } = await setup();
    const preview = await call('iaqualink_set_temperature', { serial: 'IAQ123', pool: 86 });
    server.home.pool_set_point = '84';
    const res = await h.callTool('iaqualink_set_temperature', { serial: 'IAQ123', pool: 86, confirmToken: preview.confirmToken });
    expect(JSON.stringify(res.content)).toMatch(/DRAFT_CHANGED/);
    expect(sets(server)).toEqual([]);
  });
});

describe('iaqualink_set_equipment', () => {
  it('reports unchanged without a gate or a command when already in state', async () => {
    const { call, server } = await setup();
    const r = await call('iaqualink_set_equipment', { serial: 'IAQ123', equipment: 'pool_pump', on: true });
    expect(r).toMatchObject({ status: 'unchanged', previous: true });
    expect(sets(server)).toEqual([]);
  });

  it('treats an enabled heater as on, and turns it off with its toggle', async () => {
    const { confirmed, server } = await setup();
    const { result } = await confirmed('iaqualink_set_equipment', { serial: 'IAQ123', equipment: 'pool_heater', on: false });
    expect(result).toMatchObject({ status: 'confirmed', observed: false });
    expect(server.home.pool_heater).toBe('0');
  });

  it('reports a command iAqualink accepted but did not apply, warning against a blind retry', async () => {
    const { confirmed, server } = await setup();
    server.iaquaIgnoresCommands = true;
    const { result } = await confirmed('iaqualink_set_equipment', { serial: 'IAQ123', equipment: 'spa_pump', on: true });
    expect(result.status).toBe('sent-unconfirmed');
    expect(result.verification.outcome).toBe('timeout');
    expect(result.note).toMatch(/toggle/);
  });

  it('reports a failed verification read without failing the write', async () => {
    const { confirmed, server } = await setup();
    server.afterWrite = () => server.failNext(500, { match: /get_home/ });
    const { result } = await confirmed('iaqualink_set_equipment', { serial: 'IAQ123', equipment: 'spa_pump', on: true });
    expect(result.status).toBe('sent-unconfirmed');
    expect(result.verification.outcome).toBe('read_failed');
    expect(result.readError).toMatch(/500/);
  });

  it('refuses equipment the system does not report, listing what it has', async () => {
    const server = new FakeIaqualink();
    delete server.home.solar_heater;
    const { fail } = await setup({ server });
    expect(await fail('iaqualink_set_equipment', { serial: 'IAQ123', equipment: 'solar_heater', on: true })).toMatch(
      /pool_pump/,
    );
    expect(await fail('iaqualink_set_equipment', { serial: 'IAQ123', equipment: 'filter_pump', on: true })).toMatch(/no "filter_pump"/);
  });

  it('says "none" when an iAqua system reports no switchable equipment', async () => {
    const server = new FakeIaqualink();
    server.home = { pool_temp: '80' };
    const { fail } = await setup({ server });
    expect(await fail('iaqualink_set_equipment', { serial: 'IAQ123', equipment: 'pool_pump', on: true })).toMatch(/It reports: none/);
  });

  it('switches eXO equipment through the shadow', async () => {
    const { confirmed, server } = await setup();
    const { result } = await confirmed('iaqualink_set_equipment', { serial: 'EXO456', equipment: 'production', on: false });
    expect(result).toMatchObject({ status: 'confirmed', previous: 1, requested: 0, observed: 0 });
    expect(shadowPosts(server).map((r) => r.body)).toEqual([{ state: { desired: { equipment: { swc_0: { production: 0 } } } } }]);
  });

  it('turns eXO heating on via the heating block', async () => {
    const { confirmed, server } = await setup();
    await confirmed('iaqualink_set_equipment', { serial: 'EXO456', equipment: 'heating', on: true });
    expect(shadowPosts(server)[0]!.body).toEqual({ state: { desired: { heating: { enabled: 1 } } } });
  });

  it('reports an eXO change that has not been reported back yet', async () => {
    const { confirmed, server } = await setup();
    server.exoLag = true;
    const { result } = await confirmed('iaqualink_set_equipment', { serial: 'EXO456', equipment: 'boost', on: true });
    expect(result.status).toBe('sent-unconfirmed');
    expect(result.note).toMatch(/asynchronously/);
  });

  it('refuses iAqua equipment on an eXO, and equipment the shadow lacks', async () => {
    const server = new FakeIaqualink();
    delete server.shadow.state.reported.equipment.swc_0.low;
    const { fail } = await setup({ server });
    expect(await fail('iaqualink_set_equipment', { serial: 'EXO456', equipment: 'pool_pump', on: true })).toMatch(/eXO equipment/);
    expect(await fail('iaqualink_set_equipment', { serial: 'EXO456', equipment: 'low', on: true })).toMatch(/does not report/);
  });
});

describe('iaqualink_set_aux', () => {
  it('toggles a plain aux found by label', async () => {
    const { confirmed, server } = await setup();
    const { result } = await confirmed('iaqualink_set_aux', { serial: 'IAQ123', aux: 'cleaner', on: true });
    expect(result).toMatchObject({ status: 'confirmed', target: 'aux_1', observed: true });
    expect(sets(server)).toEqual(['set_aux_1']);
  });

  it('turns a dimmable light on at 100% and a color light off with effect 0, as iaqualink-py does', async () => {
    const { confirmed, server } = await setup();
    await confirmed('iaqualink_set_aux', { serial: 'IAQ123', aux: '3', on: true });
    await confirmed('iaqualink_set_aux', { serial: 'IAQ123', aux: 'aux_2', on: false });
    const lights = server.log.filter((r) => r.url.searchParams.get('command') === 'set_light');
    expect(lights.map((r) => [r.url.searchParams.get('aux'), r.url.searchParams.get('light'), r.url.searchParams.get('subtype')])).toEqual([
      ['3', '100', null],
      ['2', '0', '4'],
    ]);
  });

  it('turns a color light on with its first effect', async () => {
    const server = new FakeIaqualink();
    server.aux.aux_2!.state = '0';
    const { confirmed } = await setup({ server });
    await confirmed('iaqualink_set_aux', { serial: 'IAQ123', aux: '2', on: true });
    expect(server.log.find((r) => r.url.searchParams.get('command') === 'set_light')!.url.searchParams.get('light')).toBe('1');
  });

  it('refuses an unknown aux with the list', async () => {
    const { fail } = await setup();
    expect(await fail('iaqualink_set_aux', { serial: 'IAQ123', aux: 'waterfall', on: true })).toMatch(/1 \(Cleaner\)/);
    expect(await fail('iaqualink_set_aux', { serial: 'EXO456', aux: '7', on: true })).toMatch(/Available: 1, 2/);
  });

  it('reports no aux at all as none', async () => {
    const server = new FakeIaqualink();
    server.aux = {};
    const { fail } = await setup({ server });
    expect(await fail('iaqualink_set_aux', { serial: 'IAQ123', aux: '1', on: true })).toMatch(/Available: none/);
  });

  it('reports an eXO aux already off as unchanged', async () => {
    const { call } = await setup();
    expect((await call('iaqualink_set_aux', { serial: 'EXO456', aux: '1', on: false })).status).toBe('unchanged');
  });

  it('turns a dimmable light off at 0%', async () => {
    const server = new FakeIaqualink();
    server.aux.aux_3 = { ...server.aux.aux_3!, state: '1', subtype: '75' };
    const { confirmed } = await setup({ server });
    const { result } = await confirmed('iaqualink_set_aux', { serial: 'IAQ123', aux: '3', on: false });
    expect(result.status).toBe('confirmed');
    expect(server.log.find((r) => r.url.searchParams.get('command') === 'set_light')!.url.searchParams.get('light')).toBe('0');
  });

  it('switches an eXO aux through the shadow', async () => {
    const { confirmed, server } = await setup();
    const { result } = await confirmed('iaqualink_set_aux', { serial: 'EXO456', aux: 'aux_2', on: true });
    expect(result.status).toBe('confirmed');
    expect(shadowPosts(server)[0]!.body).toEqual({ state: { desired: { equipment: { swc_0: { aux_2: { state: 1 } } } } } });
  });
});

describe('iaqualink_set_light', () => {
  it('dims a dimmable light and confirms the level', async () => {
    const { confirmed } = await setup();
    const { result } = await confirmed('iaqualink_set_light', { serial: 'IAQ123', aux: 'spa light', brightness: 50 });
    expect(result).toMatchObject({ status: 'confirmed', previous: 0, observed: 50 });
  });

  it('reports an unchanged brightness without sending', async () => {
    const { call } = await setup();
    expect((await call('iaqualink_set_light', { serial: 'IAQ123', aux: '3', brightness: 0 })).status).toBe('unchanged');
  });

  it('sets a color effect by name or number, confirming only the on state', async () => {
    const { confirmed, server } = await setup();
    const { result } = await confirmed('iaqualink_set_light', { serial: 'IAQ123', aux: '2', effect: 'sky blue' });
    expect(result).toMatchObject({ status: 'confirmed', requested: { effect: 'Sky Blue', on: true }, observed: { on: true } });
    expect(result.caveat).toMatch(/does not report which color/);
    await confirmed('iaqualink_set_light', { serial: 'IAQ123', aux: '2', effect: '3' });
    const lights = server.log.filter((r) => r.url.searchParams.get('command') === 'set_light');
    expect(lights.map((r) => r.url.searchParams.get('light'))).toEqual(['2', '3']);
  });

  it('refuses bad requests with the reason', async () => {
    const server = new FakeIaqualink();
    server.aux.aux_5 = { state: '0', label: 'ODD LIGHT', type: '2', subtype: '99' };
    const { fail } = await setup({ server });
    expect(await fail('iaqualink_set_light', { serial: 'IAQ123', aux: '3' })).toMatch(/exactly one/);
    expect(await fail('iaqualink_set_light', { serial: 'IAQ123', aux: '3', brightness: 50, effect: 'x' })).toMatch(/exactly one/);
    expect(await fail('iaqualink_set_light', { serial: 'IAQ123', aux: '3', brightness: 30 })).toMatch(/25/);
    expect(await fail('iaqualink_set_light', { serial: 'IAQ123', aux: '1', brightness: 50 })).toMatch(/not a dimmable light \(it is a switch\)/);
    expect(await fail('iaqualink_set_light', { serial: 'IAQ123', aux: '1', effect: 'Blue' })).toMatch(/not a color light/);
    expect(await fail('iaqualink_set_light', { serial: 'IAQ123', aux: '5', effect: 'Blue' })).toMatch(/not a color light/);
    expect(await fail('iaqualink_set_light', { serial: 'IAQ123', aux: '2', effect: 'Plaid' })).toMatch(/Effects: Off, Alpine White/);
    expect(await fail('iaqualink_set_light', { serial: 'IAQ123', aux: '2', effect: '99' })).toMatch(/isn't an effect/);
    expect(await fail('iaqualink_set_light', { serial: 'IAQ123', aux: 'nope', brightness: 50 })).toMatch(/no aux circuit/);
    expect(await fail('iaqualink_set_light', { serial: 'EXO456', aux: '1', brightness: 50 })).toMatch(/only available on iAqua/);
  });
});

describe('iaqualink_set_temperature', () => {
  it('sends both set points in one set_temps, spa first, and confirms the pool change', async () => {
    const { confirmed, server } = await setup();
    const { preview, result } = await confirmed('iaqualink_set_temperature', { serial: 'IAQ123', pool: 86 });
    expect(preview.preview.requested).toEqual({ pool: 86 });
    expect(result).toMatchObject({ status: 'confirmed', previous: { pool: 85 }, observed: { pool: 86 } });
    const cmd = server.log.find((r) => r.url.searchParams.get('command') === 'set_temps')!;
    expect([cmd.url.searchParams.get('temp1'), cmd.url.searchParams.get('temp2')]).toEqual(['102', '86']);
  });

  it('sets the spa alone', async () => {
    const { confirmed } = await setup();
    const { result } = await confirmed('iaqualink_set_temperature', { serial: 'IAQ123', spa: 100 });
    expect(result).toMatchObject({ status: 'confirmed', observed: { spa: 100 } });
  });

  it('reports an unchanged set point and validates ranges', async () => {
    const { call, fail } = await setup();
    expect((await call('iaqualink_set_temperature', { serial: 'IAQ123', pool: 85, spa: 102 })).status).toBe('unchanged');
    expect(await fail('iaqualink_set_temperature', { serial: 'IAQ123', pool: 120 })).toMatch(/34–104°F/);
    expect(await fail('iaqualink_set_temperature', { serial: 'IAQ123', spa: 20 })).toMatch(/spa temperature/);
    expect(await fail('iaqualink_set_temperature', { serial: 'IAQ123' })).toMatch(/pool and\/or spa/);
  });

  it('uses the Celsius range on a Celsius panel', async () => {
    const server = new FakeIaqualink();
    server.scale = 'C';
    const { fail } = await setup({ server });
    expect(await fail('iaqualink_set_temperature', { serial: 'IAQ123', pool: 50 })).toMatch(/1–40°C/);
  });

  it('sets the eXO heating set point within its reported range', async () => {
    const { confirmed, fail, server } = await setup();
    const { result } = await confirmed('iaqualink_set_temperature', { serial: 'EXO456', pool: 30 });
    expect(result).toMatchObject({ status: 'confirmed', previous: 28, observed: 30 });
    expect(shadowPosts(server)[0]!.body).toEqual({ state: { desired: { heating: { sp: 30 } } } });
    expect(await fail('iaqualink_set_temperature', { serial: 'EXO456', pool: 41 })).toMatch(/1–40°C/);
    expect(await fail('iaqualink_set_temperature', { serial: 'EXO456', spa: 30 })).toMatch(/single/);
  });

  it('refuses an eXO without heating control', async () => {
    const server = new FakeIaqualink();
    delete server.shadow.state.reported.heating;
    const { fail } = await setup({ server });
    expect(await fail('iaqualink_set_temperature', { serial: 'EXO456', pool: 30 })).toMatch(/no heating control/);
  });
});

describe('iaqualink_set_chlorinator', () => {
  it('sets the eXO output percentage and carries the inferred-shape caveat', async () => {
    const { confirmed, server } = await setup();
    const { preview, result } = await confirmed('iaqualink_set_chlorinator', { serial: 'EXO456', percent: 60 });
    expect(preview.preview.note).toMatch(/inferred/);
    expect(result).toMatchObject({ status: 'confirmed', previous: 50, observed: 60 });
    expect(result.caveat).toMatch(/inferred/);
    expect(shadowPosts(server)[0]!.body).toEqual({ state: { desired: { equipment: { swc_0: { swc: 60 } } } } });
  });

  it('is eXO-only', async () => {
    const { fail } = await setup();
    expect(await fail('iaqualink_set_chlorinator', { serial: 'IAQ123', percent: 60 })).toMatch(/only settable on eXO/);
  });
});
