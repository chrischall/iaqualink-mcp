import { describe, it, expect } from 'vitest';
import { setup } from '../support/harness.js';

describe('iaqualink_list_pump_speeds', () => {
  it('lists the named speeds, their RPM and which one runs', async () => {
    const { call } = await setup();
    const r = await call('iaqualink_list_pump_speeds', { serial: 'IAQ123' });
    expect(r).toMatchObject({ serial: 'IAQ123', source: 'webtouch', pump: 'VSP1 Spd', active: 'Pool' });
    expect(r.speeds[0]).toEqual({ speed: 'Pool', rpm: 2850, active: true });
    expect(r.speeds).toHaveLength(8);
  });

  it('is iAqua-only', async () => {
    const { fail } = await setup();
    expect(await fail('iaqualink_list_pump_speeds', { serial: 'EXO456' })).toMatch(/only on iAqua/);
  });
});

describe('iaqualink_set_pump_speed', () => {
  it('previews the switch, then runs the pump at the named speed and re-reads', async () => {
    const { confirmed, server } = await setup();
    const { preview, result } = await confirmed('iaqualink_set_pump_speed', { serial: 'IAQ123', speed: 'spa' });
    expect(preview.status).toBe('confirmation-required');
    expect(preview.preview).toMatchObject({ current: 'Pool (2850 rpm)', requested: 'Spa (3450 rpm)' });
    expect(result).toMatchObject({ status: 'confirmed', active: 'Spa' });
    expect(server.webtouch.vspActive).toBe(1);
  });

  it('reports unchanged when that speed already runs, and names the speeds for an unknown one', async () => {
    const { call, fail, server } = await setup();
    expect((await call('iaqualink_set_pump_speed', { serial: 'IAQ123', speed: 'Pool' })).status).toBe('unchanged');
    expect(server.webtouch.commands.some((c) => c.command === '17')).toBe(false);
    expect(await fail('iaqualink_set_pump_speed', { serial: 'IAQ123', speed: 'Turbo' })).toMatch(/no pump speed "Turbo".*Pool \(2850\).*In Floor/s);
  });

  it('says sent-unconfirmed when the re-read shows another speed running', async () => {
    const { confirmed, server } = await setup();
    let presses = 0;
    server.webtouch.afterCommand = (c) => {
      if (c === '18' && server.webtouch.screen === 30 && ++presses === 1) server.webtouch.vspActive = 0;
    };
    // The button echo arrives before the fake reverts, so the switch step passes; the re-read sees Pool.
    const { result } = await confirmed('iaqualink_set_pump_speed', { serial: 'IAQ123', speed: 'Spa' });
    expect(result.status).toBe('sent-unconfirmed');
    expect(result.active).toBe('Pool');
  });
});

describe('iaqualink_set_pump_speed_rpm', () => {
  it('previews old → new RPM, stores it, keeps the running speed, re-reads', async () => {
    const { confirmed, server } = await setup();
    const { preview, result } = await confirmed('iaqualink_set_pump_speed_rpm', { serial: 'IAQ123', speed: 'Speed4', rpm: 2400 });
    expect(preview.preview).toMatchObject({ speed: 'Speed4', current: 2750, requested: 2400, running: 'Pool' });
    expect(preview.preview.note).toMatch(/runs at "Speed4" for a few seconds/);
    expect(result).toMatchObject({ status: 'confirmed', speed: 'Speed4', rpm: 2400, active: 'Pool' });
    expect(server.webtouch.vsp[3]!.rpm).toBe(2400);
  });

  it('reports unchanged at the same RPM, and refuses out-of-range values', async () => {
    const { call, h } = await setup();
    expect((await call('iaqualink_set_pump_speed_rpm', { serial: 'IAQ123', speed: 'Pool', rpm: 2850 })).status).toBe('unchanged');
    for (const rpm of [599, 3451, 2500.5]) {
      expect((await h.callTool('iaqualink_set_pump_speed_rpm', { serial: 'IAQ123', speed: 'Pool', rpm })).isError).toBe(true);
    }
  });

  it('says sent-unconfirmed when the re-read RPM differs', async () => {
    const { confirmed, server } = await setup();
    server.webtouch.afterCommand = (c) => {
      if (c === '128') server.webtouch.vsp[0]!.rpm = 2700;
    };
    const { result } = await confirmed('iaqualink_set_pump_speed_rpm', { serial: 'IAQ123', speed: 'Pool', rpm: 2600 });
    expect(result).toMatchObject({ status: 'sent-unconfirmed', rpm: 2700 });
  });

  it('refuses a token once the speeds have changed', async () => {
    const { call, h, server } = await setup();
    const args = { serial: 'IAQ123', speed: 'Pool', rpm: 2600 };
    const preview = await call('iaqualink_set_pump_speed_rpm', args);
    server.webtouch.vsp[0]!.rpm = 2900;
    const res = await h.callTool('iaqualink_set_pump_speed_rpm', { ...args, confirmToken: preview.confirmToken });
    expect(JSON.stringify(res.content)).toMatch(/DRAFT_CHANGED/);
    expect(server.webtouch.commands.some((c) => c.command === '128')).toBe(false);
  });
});

describe('pump speeds with none marked running', () => {
  it('lists, previews and sets without a running speed', async () => {
    const { call, confirmed, server } = await setup();
    server.webtouch.vspActive = -1;
    expect((await call('iaqualink_list_pump_speeds', { serial: 'IAQ123' })).active).toBeNull();
    const sw = await confirmed('iaqualink_set_pump_speed', { serial: 'IAQ123', speed: 'Spa' });
    expect(sw.preview.preview.current).toBeNull();
    expect(sw.result).toMatchObject({ status: 'confirmed', previous: null });
    server.webtouch.vspActive = -1;
    const rpm = await confirmed('iaqualink_set_pump_speed_rpm', { serial: 'IAQ123', speed: 'Spa', rpm: 3000 });
    expect(rpm.preview.preview).toMatchObject({ running: null });
    expect(rpm.preview.preview.note).toBeUndefined();
    expect(rpm.result.status).toBe('confirmed');
  });
});
