import { describe, it, expect } from 'vitest';
import { setup } from '../support/harness.js';

describe('iaqualink_list_onetouch (WebTouch screen 77)', () => {
  it('lists the scenes, 1-based, with their state', async () => {
    const { call, server } = await setup();
    server.webtouch.onetouch[2] = true;
    const r = await call('iaqualink_list_onetouch', { serial: 'IAQ123' });
    expect(r).toMatchObject({ serial: 'IAQ123', source: 'webtouch' });
    expect(r.scenes.slice(0, 3)).toEqual([
      { onetouch: 1, label: 'All OFF', on: false },
      { onetouch: 2, label: 'Spa Mode', on: false },
      { onetouch: 3, label: 'Clean Mode', on: true },
    ]);
  });

  it('is iAqua-only', async () => {
    const { fail } = await setup();
    expect(await fail('iaqualink_list_onetouch', { serial: 'EXO456' })).toMatch(/only on iAqua/);
  });
});

describe('iaqualink_set_onetouch', () => {
  it('previews, then presses 17 + idx once and confirms from the panel', async () => {
    const { confirmed, server } = await setup();
    const { preview, result } = await confirmed('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: 'spa mode', on: true });
    expect(preview.status).toBe('confirmation-required');
    expect(JSON.stringify(preview.preview)).toContain('"command":18');
    expect(result).toMatchObject({ status: 'confirmed', target: 'Spa Mode', previous: false, observed: true });
    expect(server.webtouch.commands.filter((c) => c.command === '18')).toHaveLength(1);
    expect(server.webtouch.onetouch[1]).toBe(true);
  });

  it('finds scenes by number or onetouch_<n>, and sends nothing when already in state', async () => {
    const { call, server } = await setup();
    expect((await call('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: '1', on: false })).status).toBe('unchanged');
    expect((await call('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: 'onetouch_3', on: false })).status).toBe('unchanged');
    expect(server.webtouch.commands.some((c) => ['17', '19'].includes(c.command) && server.webtouch.screen === 77)).toBe(false);
  });

  it('turns a running scene off', async () => {
    const { confirmed, server } = await setup();
    server.webtouch.onetouch[2] = true;
    const { preview, result } = await confirmed('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: 'Clean Mode', on: false });
    expect(JSON.stringify(preview)).toMatch(/scene off/);
    expect(result).toMatchObject({ status: 'confirmed', observed: false });
  });

  it('refuses an unknown scene, listing them', async () => {
    const { fail } = await setup();
    expect(await fail('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: 'party', on: true })).toMatch(/2 \(Spa Mode\)/);
  });

  it('says none when the screen shows no scenes', async () => {
    const { fail, server } = await setup();
    server.webtouch.afterCommand = (c) => {
      if (c === '3') for (let i = 0; i < 6; i++) server.webtouch.emit('24', `${i}||0||1|| ||`);
    };
    expect(await fail('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: '1', on: true })).toMatch(/Scenes: none/);
  });

  it('reports a scene that never changes as an abort with the panel state', async () => {
    const { call, h, server } = await setup();
    const preview = await call('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: '2', on: true });
    server.webtouch.ignore.add('18');
    const res = await h.callTool('iaqualink_set_onetouch', { serial: 'IAQ123', onetouch: '2', on: true, confirmToken: preview.confirmToken });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Spa Mode.* to turn on.*panel left on screen 1/);
  });
});
