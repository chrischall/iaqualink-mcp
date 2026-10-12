import { describe, it, expect } from 'vitest';
import { IaqualinkClient } from '../src/client.js';
import {
  PanelOp,
  addSchedule,
  deleteSchedule,
  editSchedule,
  from12,
  parseRow,
  pickerRows,
  readOneTouch,
  readSchedules,
  sameList,
  setOneTouch,
  to12,
  type PanelSchedule,
} from '../src/rs-panel.js';
import { WebTouchSession, emptyState, withPanel } from '../src/webtouch.js';
import { FakeIaqualink } from './support/fake-server.js';
import { WT_SCHEDULES } from './support/fake-webtouch.js';

const TIMING = { stepTimeoutMs: 200, quietMs: 3 };

function panel(server = new FakeIaqualink()) {
  const client = new IaqualinkClient({ email: 'me@example.com', password: server.password, fetchImpl: server.fetch, minIntervalMs: 0, statusCacheMs: 0 });
  const use = <T>(fn: (s: WebTouchSession) => Promise<T>) => withPanel(client, 'IAQ123', TIMING, fn);
  const pressed = () => server.webtouch.commands.filter((c) => c.actionID !== 'START-1').map((c) => (c.text ? `${c.command}:${c.text}` : c.command));
  return { server, wt: server.webtouch, use, pressed };
}

describe('time and row helpers', () => {
  it('converts between the panel\'s 12-hour text and 24-hour HH:MM', () => {
    expect(['1:00 PM', '12:00 AM', '12:30 PM', '8:05 am', '11:59 PM'].map(from12)).toEqual(['13:00', '00:00', '12:30', '08:05', '23:59']);
    expect(['13:00', '', '0:00 PM', '13:00 PM', '1:60 PM'].map(from12)).toEqual([null, null, null, null, null]);
    expect(to12('00:30')).toEqual({ text: '12:30', mer: 'AM', display: '12:30 AM' });
    expect(to12('12:00')).toEqual({ text: '12:00', mer: 'PM', display: '12:00 PM' });
    expect(to12('20:05')).toEqual({ text: '08:05', mer: 'PM', display: '8:05 PM' });
  });

  it('splits a row and treats a blank one as empty', () => {
    expect(parseRow('Cleaner\t8:00 AM\t8:30 AM\tWkends')).toEqual({ circuit: 'Cleaner', start: '8:00 AM', stop: '8:30 AM', days: 'Wkends' });
    expect(parseRow('Spa')).toEqual({ circuit: 'Spa', start: '', stop: '', days: '' });
    expect(parseRow('')).toBeNull();
    expect(parseRow(undefined)).toBeNull();
  });

  it('reads picker rows, blank where not painted', () => {
    const st = emptyState();
    st.rows.set(2, ' Spa ');
    expect(pickerRows(st)).toEqual(['', 'Spa', '', '', '', '', '']);
  });

  it('compares lists by the panel text, ignoring order and position', () => {
    const a = { circuit: 'A', display: { start: '1:00 PM', stop: '2:00 PM' }, days: 'All' };
    const b = { circuit: 'B', display: { start: '1:00 PM', stop: '2:00 PM' }, days: 'All' };
    expect(sameList([a, b], [b, a])).toBe(true);
    expect(sameList([a], [b])).toBe(false);
  });
});

describe('PanelOp.expect', () => {
  const op = (patch: Partial<ReturnType<typeof emptyState>>) => {
    const state = { ...emptyState(), ...patch };
    return new PanelOp({ state } as unknown as WebTouchSession);
  };
  it('names each mismatch', () => {
    expect(() => op({ screen: '1' }).expect('40')).toThrow(/screen 1, expected 40/);
    expect(() => op({ screen: '40', dialog: { type: '0', message: 'hi', buttons: [] } }).expect('40')).toThrow(/dialog is open \("hi"\)/);
    expect(() => op({ screen: '40', selected: 2 }).expect('40', { row: 3 })).toThrow(/row 2 is selected, expected row 3/);
    expect(() => op({ screen: '40' }).expect('40', { edit: true })).toThrow(/Edit mode is off, expected on/);
    const on = op({ screen: '40', buttons: new Map([[1, { state: '1', img: '', label: 'Edit', text: '' }]]) });
    expect(() => on.expect('40', { edit: false })).toThrow(/Edit mode is on, expected off/);
    expect(() => on.expect('40', { edit: true })).not.toThrow();
  });
});

describe('readSchedules', () => {
  it('reads the schedule list via Menu(2) → Schedule(17) and returns Home(1)', async () => {
    const { use, pressed, wt } = panel();
    const list = await use(readSchedules);
    expect(list.map((s) => [s.page, s.row, s.circuit, s.start, s.stop, s.days])).toEqual([
      [1, 1, 'Filter Pump', '13:01', '13:00', 'All'],
      [1, 2, 'Cleaner', '08:00', '08:30', 'Wkends'],
      [1, 3, 'Cleaner', '14:00', '14:30', 'Wkdays'],
      [1, 4, 'Pool Light', '19:00', '23:00', 'All'],
    ]);
    expect(list[0]!.display).toEqual({ start: '1:01 PM', stop: '1:00 PM' });
    expect(pressed()).toEqual(['2', '17', '1']);
    expect(wt.screen).toBe(1);
  });

  it('pages down while pages are full, stopping when the next page does not change', async () => {
    const { use, wt, pressed } = panel();
    const extra = Array.from({ length: 5 }, (_, i) => ({ circuit: `Aux ${i}`, start: '1:00 AM', stop: '2:00 AM', days: 'M' }));
    wt.saved = [...WT_SCHEDULES, ...extra];
    const list = await use(readSchedules);
    expect(list).toHaveLength(9);
    expect(list.at(-1)).toMatchObject({ page: 2, row: 2, circuit: 'Aux 4' });

    wt.saved = wt.saved.slice(0, 7);
    expect(await use(readSchedules)).toHaveLength(7);
    expect(pressed().slice(-4)).toEqual(['2', '17', '20', '1']);
  });

  it('starts from the Menu screen without pressing Menu again', async () => {
    const { use, wt, pressed } = panel();
    wt.screen = 15;
    await use(async (s) => {
      const op = new PanelOp(s);
      await op.enterSchedule();
      return op.readPages();
    });
    expect(pressed()).toEqual(['17']);
  });

  it('presses nothing on a panel left in Edit mode with unsaved changes, and says so', async () => {
    const { use, wt, pressed } = panel();
    Object.assign(wt, { screen: 40, edit: true, selected: 0 });
    // The real panel answers the start-up press with only this dialog (live 2026-10-12).
    await expect(use(readSchedules)).rejects.toThrow(
      /dialog is open \("Program changes must be saved.*panel left on an unknown screen.*schedule Edit mode with UNSAVED changes/,
    );
    expect(pressed()).toEqual([]);
    expect(wt.edit).toBe(true);
  });

  it('refuses to go on when the panel turns out to be in someone else\'s Edit mode', async () => {
    const { use, wt, pressed } = panel();
    Object.assign(wt, { screen: 40, selected: 0 });
    wt.afterCommand = () => {
      wt.afterCommand = undefined;
      wt.edit = true;
      wt.emit('24', '1||1||1||Edit||');
    };
    await expect(use(readSchedules)).rejects.toThrow(/already in schedule Edit mode .*panel left on screen 40 in Edit mode with UNSAVED/);
    expect(pressed()).toEqual([]);
  });

  it('refuses a panel showing a dialog', async () => {
    const p2 = panel();
    p2.wt.dialog = 'pressSave';
    p2.wt.afterCommand = (c) => {
      if (c === '1') p2.wt.emit('2C', '0||1||Press SAVE to store program changes.||Ok');
    };
    await expect(p2.use(readSchedules)).rejects.toThrow(/dialog is open/);
  });
});

async function planned(p: ReturnType<typeof panel>): Promise<PanelSchedule[]> {
  return p.use(readSchedules);
}

describe('addSchedule — the captured Add sequence', () => {
  it('Add → picker (paging to Pool Light) → Select → Start/AM → Stop → Wkdays → Save → Home, then verifies', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.commands.length = 0;
    const verified = await p.use((s) => addSchedule(s, { circuit: 'pool light', start: '08:00', stop: '09:30', days: 'Wkdays' }, before));
    expect(p.pressed()).toEqual(['2', '17', '17', '18', '20', '19', '33', '17', '128:08:00', '34', '17', '128:09:30', '31', '22', '1', '2', '17', '1']);
    expect(p.wt.commands.find((c) => c.command === '128')!.actionID).toBe('STB-1');
    expect(p.wt.saved.at(-1)).toEqual({ circuit: 'Pool Light', start: '8:00 AM', stop: '9:30 AM', days: 'Wkdays' });
    expect(verified.at(-1)).toMatchObject({ circuit: 'Pool Light', start: '08:00', stop: '09:30', days: 'Wkdays' });
  });

  it('skips times and days that already match the new row\'s defaults (1:00 PM, All)', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.commands.length = 0;
    await p.use((s) => addSchedule(s, { circuit: 'Spa', start: '13:00', stop: '15:00', days: 'All' }, before));
    expect(p.pressed().slice(3, 10)).toEqual(['21', '19', '34', '128:03:00', '22', '1', '2']);
  });

  it('aborts before pressing Add when the list changed since the preview', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.saved.pop();
    p.wt.commands.length = 0;
    await expect(p.use((s) => addSchedule(s, { circuit: 'Spa', start: '09:00', stop: '10:00', days: 'All' }, before))).rejects.toThrow(
      /changed since it was previewed.*panel left on screen 1\./,
    );
    expect(p.pressed()).toEqual(['2', '17', '1']);
  });

  it('aborts on an unknown device and goes Home from the picker', async () => {
    const p = panel();
    const before = await planned(p);
    await expect(p.use((s) => addSchedule(s, { circuit: 'Waterfall', start: '09:00', stop: '10:00', days: 'All' }, before))).rejects.toThrow(
      /no "Waterfall".*panel left on screen 1/,
    );
    expect(p.wt.saved).toEqual(WT_SCHEDULES);
  });

  it('aborts when the picker does not echo the row selection', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.pickerSilent = true;
    await expect(p.use((s) => addSchedule(s, { circuit: 'Spa', start: '09:00', stop: '10:00', days: 'All' }, before))).rejects.toThrow(
      /timed out waiting for device row 2 to be selected/,
    );
  });

  it('aborts if the new row is a different circuit, leaving the unsaved row reported', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.afterCommand = (c) => {
      if (c === '19' && p.wt.screen === 40) {
        p.wt.working.at(-1)!.circuit = 'Surprise';
        p.wt.emit('26', `0||5||Surprise\t1:00 PM\t1:00 PM\tAll`);
      }
    };
    await expect(p.use((s) => addSchedule(s, { circuit: 'Spa', start: '09:00', stop: '10:00', days: 'All' }, before))).rejects.toThrow(
      /new row 5 is not "Spa".*Edit mode with UNSAVED changes/,
    );
  });
});

describe('clean-up after a failed add', () => {
  it('never presses Home over unsaved changes, even when the Edit state was not seen', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.commands.length = 0;
    p.wt.afterCommand = (c) => {
      // Back on the list after the start time, the display wrongly shows Edit off.
      if (c === '128') p.wt.emit('24', '1||0||1||Edit||');
    };
    await expect(p.use((s) => addSchedule(s, { circuit: 'Spa', start: '03:00', stop: '03:01', days: 'Su' }, before))).rejects.toThrow(
      /Edit mode is off, expected on.*panel left on screen 40 with UNSAVED changes/,
    );
    expect(p.pressed().at(-1)).toBe('128:03:00');
    expect(p.wt.dialog).toBeNull();
  });
});

describe('editSchedule', () => {
  it('selects the row, Edit, changes start + days, Save, Home, verifies', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.commands.length = 0;
    const verified = await p.use((s) => editSchedule(s, { page: 1, row: 2 }, { start: '09:00', days: 'Su' }, before));
    expect(p.pressed()).toEqual(['2', '17', '36', '18', '33', '128:09:00', '30', '22', '1', '2', '17', '1']);
    expect(p.wt.saved[1]).toEqual({ circuit: 'Cleaner', start: '9:00 AM', stop: '8:30 AM', days: 'Su' });
    expect(verified[1]).toMatchObject({ start: '09:00', days: 'Su' });
  });

  it('sets the stop time, toggling PM → AM', async () => {
    const p = panel();
    const before = await planned(p);
    await p.use((s) => editSchedule(s, { page: 1, row: 4 }, { stop: '01:15' }, before));
    expect(p.wt.saved[3]!.stop).toBe('1:15 AM');
  });

  it('pages back up to a target on an earlier page', async () => {
    const p = panel();
    p.wt.saved = [...WT_SCHEDULES, ...WT_SCHEDULES, ...WT_SCHEDULES.slice(0, 1)];
    const before = await planned(p);
    p.wt.commands.length = 0;
    await p.use((s) => editSchedule(s, { page: 1, row: 2 }, { days: 'M' }, before));
    expect(p.pressed().slice(0, 5)).toEqual(['2', '17', '20', '21', '36']);
  });

  it('aborts when the row no longer shows the planned schedule', async () => {
    const p = panel();
    const before = await planned(p);
    const moved = before.map((x) => (x.row === 2 ? { ...x, row: 3 } : x.row === 3 ? { ...x, row: 2 } : x));
    await expect(p.use((s) => editSchedule(s, { page: 1, row: 2 }, { start: '09:00' }, moved))).rejects.toThrow(/row 2 does not show the expected schedule/);
    p.wt.saved[1] = { ...p.wt.saved[1]!, circuit: 'X' };
    const b2 = await planned(p);
    p.wt.saved[1] = { ...p.wt.saved[1]!, circuit: 'Y' };
    await expect(p.use((s) => editSchedule(s, { page: 1, row: 2 }, { start: '09:00' }, b2))).rejects.toThrow(/changed since/);
    p.wt.saved.splice(1, 1);
    const b3 = (await planned(p)).map((x) => (x.row === 4 ? { ...x, row: 5 } : x));
    b3.push({ ...b3[0]!, row: 4 });
    await expect(p.use((s) => editSchedule(s, { page: 1, row: 4 }, {}, b3))).rejects.toThrow();
  });

  it('with Edit on and nothing entered, a failed step exits with a no-op Save and goes Home', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.ignore.add('33');
    p.wt.commands.length = 0;
    await expect(p.use((s) => editSchedule(s, { page: 1, row: 1 }, { start: '09:00' }, before))).rejects.toThrow(
      /start time keypad.*panel left on screen 1\./,
    );
    expect(p.pressed().slice(-2)).toEqual(['22', '1']);
    expect(p.wt.saved).toEqual(WT_SCHEDULES);
  });

  it('reports a panel stuck on the keypad mid-entry', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.ignore.add('128');
    await expect(p.use((s) => editSchedule(s, { page: 1, row: 1 }, { start: '09:00' }, before))).rejects.toThrow(/on the time keypad, mid-entry/);
  });

  it('reports unsaved changes when Save does not take', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.ignore.add('22');
    await expect(p.use((s) => editSchedule(s, { page: 1, row: 2 }, { days: 'M' }, before))).rejects.toThrow(/Save to turn Edit off.*UNSAVED changes/);
  });

  it('aborts when the AM/PM toggle does not take', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.afterCommand = (c) => {
      if (c === '33') p.wt.ignore.add('17');
    };
    await expect(p.use((s) => editSchedule(s, { page: 1, row: 1 }, { start: '09:00' }, before))).rejects.toThrow(/keypad to show AM/);
  });
});

describe('deleteSchedule', () => {
  it('selects, Delete, confirms Ok — persisted without Save — Home, verifies', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.commands.length = 0;
    const verified = await p.use((s) => deleteSchedule(s, { page: 1, row: 3 }, before));
    expect(p.pressed()).toEqual(['2', '17', '37', '19', '1', '1', '2', '17', '1']);
    expect(verified.map((x) => x.circuit)).toEqual(['Filter Pump', 'Cleaner', 'Pool Light']);
    expect(p.wt.saved).toHaveLength(3);
  });

  it('cancels the confirmation when Ok does not take', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.afterCommand = (c) => {
      if (c === '19') p.wt.ignore.add('1');
      if (c === '2') p.wt.ignore.delete('1');
    };
    await expect(p.use((s) => deleteSchedule(s, { page: 1, row: 3 }, before))).rejects.toThrow(/confirmation to close.*panel left on screen 1\./);
    expect(p.wt.saved).toEqual(WT_SCHEDULES);
  });

  it('waits for a confirmation that arrives late', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.ignore.add('19');
    const t = setInterval(() => {
      if (p.wt.commands.some((c) => c.command === '19')) {
        clearInterval(t);
        setTimeout(() => {
          p.wt.ignore.delete('19');
          p.wt.command('MASTER-1', '19');
        }, 20);
      }
    }, 2);
    await p.use((s) => deleteSchedule(s, { page: 1, row: 3 }, before));
    expect(p.wt.saved).toHaveLength(3);
  });

  it('reports a dialog it could not close', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.afterCommand = (c) => {
      if (c === '19') ['1', '2'].forEach((x) => p.wt.ignore.add(x));
    };
    await expect(p.use((s) => deleteSchedule(s, { page: 1, row: 3 }, before))).rejects.toThrow(/with the dialog "Are you sure/);
  });

  it('closes a non-delete dialog with Ok during clean-up', async () => {
    const p = panel();
    const before = await planned(p);
    p.wt.afterCommand = (c) => {
      if (c === '37') {
        p.wt.dialog = 'pressSave';
        p.wt.emit('2C', '0||1||Press SAVE to store program changes.||Ok');
      }
    };
    await expect(p.use((s) => deleteSchedule(s, { page: 1, row: 3 }, before))).rejects.toThrow(/dialog is open.*panel left on screen 1\./);
  });
});

describe('OneTouch (screen 77)', () => {
  it('reads the scenes and returns Home', async () => {
    const p = panel();
    const scenes = await p.use(readOneTouch);
    expect(scenes.map((s) => [s.index, s.label, s.on])).toEqual([
      [0, 'All OFF', false],
      [1, 'Spa Mode', false],
      [2, 'Clean Mode', false],
      [3, 'OneTouch 4', false],
      [4, 'OneTouch 5', false],
      [5, 'OneTouch 6', false],
    ]);
    expect(p.pressed()).toEqual(['3', '1']);
  });

  it('presses 17 + index only when the state differs', async () => {
    const p = panel();
    const after = await p.use((s) => setOneTouch(s, 1, true));
    expect(after[1]!.on).toBe(true);
    expect(p.pressed()).toEqual(['3', '18', '1']);
    await p.use((s) => setOneTouch(s, 1, true));
    expect(p.pressed().slice(3)).toEqual(['3', '1']);
    await p.use((s) => setOneTouch(s, 1, false));
    expect(p.wt.onetouch[1]).toBe(false);
  });

  it('aborts for a scene the screen does not show', async () => {
    const p = panel();
    await expect(p.use((s) => setOneTouch(s, 9, true))).rejects.toThrow(/no scene 9/);
  });
});
