import { describe, it, expect } from 'vitest';
import { setup } from '../support/harness.js';
import { WT_SCHEDULES } from '../support/fake-webtouch.js';

const cleanerWkends = { serial: 'IAQ123', page: 1, row: 2, circuit: 'Cleaner', start: '08:00', stop: '08:30', days: 'Wkends' };

describe('iaqualink_add_schedule', () => {
  it('previews before/after without pressing anything that changes the panel, then adds, saves and verifies', async () => {
    const { confirmed, server } = await setup();
    const args = { serial: 'IAQ123', circuit: 'Pool Light', start: '06:30', stop: '07:00', days: 'Wkdays' };
    const { preview, result } = await confirmed('iaqualink_add_schedule', args);
    expect(preview.status).toBe('confirmation-required');
    expect(preview.preview.before).toHaveLength(4);
    expect(preview.preview.after.at(-1)).toEqual({ circuit: 'Pool Light', start: '6:30 AM', stop: '7:00 AM', days: 'Wkdays' });
    expect(result.status).toBe('confirmed');
    expect(result.verified.at(-1)).toMatchObject({ circuit: 'Pool Light', start: '06:30', stop: '07:00', days: 'Wkdays', page: 1, row: 5 });
    expect(server.webtouch.saved).toHaveLength(5);
  });

  it('reports unchanged when the exact program already exists, and refuses a zero-length one', async () => {
    const { call, fail, server } = await setup();
    const r = await call('iaqualink_add_schedule', { serial: 'IAQ123', circuit: 'cleaner', start: '08:00', stop: '08:30', days: 'Wkends' });
    expect(r.status).toBe('unchanged');
    expect(server.webtouch.commands.some((c) => c.command === '22')).toBe(false);
    expect(await fail('iaqualink_add_schedule', { serial: 'IAQ123', circuit: 'Spa', start: '08:00', stop: '08:00', days: 'All' })).toMatch(/same time/);
  });

  it('says sent-unconfirmed when the re-read list differs from what was expected', async () => {
    const { confirmed, server } = await setup();
    let saves = 0;
    server.webtouch.afterCommand = (c) => {
      if (c === '22' && ++saves === 1) server.webtouch.saved.at(-1)!.days = 'M';
    };
    const { result } = await confirmed('iaqualink_add_schedule', { serial: 'IAQ123', circuit: 'Spa', start: '09:00', stop: '10:00', days: 'All' });
    expect(result.status).toBe('sent-unconfirmed');
    expect(result.note).toMatch(/does not match/);
  });

  it('is iAqua-only', async () => {
    const { fail } = await setup();
    expect(await fail('iaqualink_add_schedule', { serial: 'EXO456', circuit: 'Spa', start: '09:00', stop: '10:00', days: 'All' })).toMatch(/only on iAqua.*iaqualink_set_schedule/s);
  });

  it('refuses a token once the panel list has changed', async () => {
    const { call, h, server } = await setup();
    const args = { serial: 'IAQ123', circuit: 'Spa', start: '09:00', stop: '10:00', days: 'All' };
    const preview = await call('iaqualink_add_schedule', args);
    server.webtouch.saved.pop();
    const res = await h.callTool('iaqualink_add_schedule', { ...args, confirmToken: preview.confirmToken });
    expect(JSON.stringify(res.content)).toMatch(/DRAFT_CHANGED/);
    expect(server.webtouch.commands.some((c) => c.command === '22')).toBe(false);
  });
});

describe('iaqualink_edit_schedule', () => {
  it('changes only what differs and verifies', async () => {
    const { confirmed, server } = await setup();
    const { preview, result } = await confirmed('iaqualink_edit_schedule', { ...cleanerWkends, newStop: '09:00', newDays: 'Wkends' });
    expect(preview.preview.after[1]).toEqual({ circuit: 'Cleaner', start: '8:00 AM', stop: '9:00 AM', days: 'Wkends' });
    expect(result.status).toBe('confirmed');
    expect(server.webtouch.saved[1]).toEqual({ circuit: 'Cleaner', start: '8:00 AM', stop: '9:00 AM', days: 'Wkends' });
    expect(server.webtouch.commands.some((c) => c.command === '33' || c.command === '32')).toBe(false);
  });

  it('edits start and days', async () => {
    const { confirmed, server } = await setup();
    await confirmed('iaqualink_edit_schedule', { ...cleanerWkends, newStart: '07:45', newDays: 'Sa' });
    expect(server.webtouch.saved[1]).toEqual({ circuit: 'Cleaner', start: '7:45 AM', stop: '8:30 AM', days: 'Sa' });
  });

  it('refuses a stale identity with the current list, nothing to change, or a zero-length result', async () => {
    const { fail, call } = await setup();
    expect(await fail('iaqualink_edit_schedule', { ...cleanerWkends, row: 3, newStart: '09:00' })).toMatch(/No schedule .*p1 r2 Cleaner 08:00–08:30 Wkends/s);
    expect(await fail('iaqualink_edit_schedule', cleanerWkends)).toMatch(/at least one/);
    expect(await fail('iaqualink_edit_schedule', { ...cleanerWkends, newStop: '08:00' })).toMatch(/same time/);
    expect((await call('iaqualink_edit_schedule', { ...cleanerWkends, newStart: '08:00' })).status).toBe('unchanged');
  });

  it('says so when the panel has no schedules', async () => {
    const { fail, server } = await setup();
    server.webtouch.saved = [];
    expect(await fail('iaqualink_edit_schedule', { ...cleanerWkends, newStart: '09:00' })).toMatch(/no schedules/);
  });
});

describe('iaqualink_delete_schedule', () => {
  it('previews the list without the program, deletes on confirm and verifies', async () => {
    const { confirmed, server } = await setup();
    const { preview, result } = await confirmed('iaqualink_delete_schedule', cleanerWkends);
    expect(preview.preview.after).toHaveLength(3);
    expect(result.status).toBe('confirmed');
    expect(result.verified.map((s: any) => s.circuit)).toEqual(['Filter Pump', 'Cleaner', 'Pool Light']);
    expect(server.webtouch.saved).toEqual([WT_SCHEDULES[0], WT_SCHEDULES[2], WT_SCHEDULES[3]]);
  });

  it('surfaces an aborted delete with the state left', async () => {
    const { call, h, server } = await setup();
    const preview = await call('iaqualink_delete_schedule', cleanerWkends);
    server.webtouch.ignore.add('19');
    const res = await h.callTool('iaqualink_delete_schedule', { ...cleanerWkends, confirmToken: preview.confirmToken });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Deleting the schedule aborted.*delete confirmation.*panel left on screen 1/);
    expect(server.webtouch.saved).toHaveLength(4);
  });
});
