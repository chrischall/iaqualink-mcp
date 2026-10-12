import { describe, it, expect } from 'vitest';
import { setup } from '../support/harness.js';

const masterPresses = (server: { webtouch: { commands: Array<{ actionID: string }> } }) =>
  server.webtouch.commands.filter((c) => c.actionID !== 'START-1');

describe('iaqualink_check_panel', () => {
  it('reports an online system with a responsive panel, pressing nothing but the start-up press', async () => {
    const { call, server } = await setup();
    const r = await call('iaqualink_check_panel', { serial: 'IAQ123' });
    expect(r).toMatchObject({ serial: 'IAQ123', online: true, panel: { state: 'ready', screen: '1', screenName: 'Home', dialog: null, editMode: false } });
    expect(r.hint).toMatch(/schedule and OneTouch tools can run/i);
    expect(server.webtouch.commands).toEqual([{ actionID: 'START-1', command: '1' }]);
  });

  it('names a panel stuck in schedule Edit mode with unsaved changes (live 2026-10-12)', async () => {
    const { call, server } = await setup();
    Object.assign(server.webtouch, { screen: 40, edit: true, selected: 0 });
    const r = await call('iaqualink_check_panel', { serial: 'IAQ123' });
    expect(r.panel).toMatchObject({ state: 'edit_unsaved', screen: null, dialog: { message: expect.stringMatching(/must be saved before exiting/) } });
    expect(r.hint).toMatch(/Edit mode with unsaved changes.*Save or discard/s);
    expect(masterPresses(server)).toEqual([]);
    expect(server.webtouch.edit).toBe(true);
  });

  it('also recognises Edit mode shown on the schedule screen itself', async () => {
    const { call, server } = await setup();
    server.webtouch.screen = 40;
    server.webtouch.afterCommand = () => server.webtouch.emit('24', '1||1||1||Edit||');
    const r = await call('iaqualink_check_panel', { serial: 'IAQ123' });
    expect(r.panel).toMatchObject({ state: 'edit_unsaved', screen: '40', screenName: 'Schedule', editMode: true, dialog: null });
  });

  it('reports any other open dialog as is', async () => {
    const { call, server } = await setup();
    server.webtouch.afterCommand = () => server.webtouch.emit('2C', '3||1||Are you sure you want to delete this program?.||Ok||Cancel||');
    const r = await call('iaqualink_check_panel', { serial: 'IAQ123' });
    expect(r.panel).toMatchObject({ state: 'dialog', dialog: { message: 'Are you sure you want to delete this program?.', buttons: ['Ok', 'Cancel'] } });
    expect(r.hint).toMatch(/dialog is open/);
  });

  it('does not open a panel session when iAqualink reports the system offline', async () => {
    const { call, server } = await setup();
    server.homeStatus = 'Offline';
    const r = await call('iaqualink_check_panel', { serial: 'IAQ123' });
    expect(r).toMatchObject({ online: false, panel: null });
    expect(r.hint).toMatch(/Offline/);
    expect(server.webtouch.commands).toEqual([]);
  });

  it('says so when the cloud reports online but the panel does not answer', async () => {
    const { call, server } = await setup();
    server.webtouch.ignore.add('1');
    const r = await call('iaqualink_check_panel', { serial: 'IAQ123' });
    expect(r).toMatchObject({ online: true, panel: { state: 'no_answer' } });
    expect(r.hint).toMatch(/did not answer/);
  });

  it('passes other session failures through, and is iAqua-only', async () => {
    const { fail, server } = await setup();
    server.failNext(500, { match: /webtouch\/init/ });
    expect(await fail('iaqualink_check_panel', { serial: 'IAQ123' })).toMatch(/500/);
    expect(await fail('iaqualink_check_panel', { serial: 'EXO456' })).toMatch(/only on iAqua/);
  });
});
