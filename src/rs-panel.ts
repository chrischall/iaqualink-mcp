/**
 * AquaLink RS panel operations over WebTouch — schedules and OneTouch.
 *
 * Every screen id, command id and stream shape here is from the live capture
 * of 2026-10-11 on an RS panel (page v1.5-RS), cross-checked with the page's
 * netlink.js element table (`nl_element[40]`, `[41]`, `[56]`, `[77]`):
 *
 *   bottom bar   1 Home (also dialog Ok) · 2 Menu (dialog Cancel) · 3 OneTouch · 5 Back
 *   menu    15   17 Schedule
 *   sched   40   17 Add · 18 Edit toggle · 19 Delete · 20 PageDown · 21 PageUp · 22 Save
 *                23..32 run days (All, M, Tu, W, Th, F, Sa, Su, Wkdays, Wkends = button idx 6..15)
 *                33 Start Time · 34 Stop Time · 35..41 rows 1..7 (34 + row)
 *   keypad  41   17 AM/PM · text 25 "1||hh:mm", "2||AM|PM" · Enter = 128 + text "hh:mm" on actionIdMasterSTB
 *   picker  56   17 PageUp · 18 PageDown · 19 Select · 20..26 rows 1..7 (19 + row)
 *   onetouch 77  17 + idx toggles scene idx (0..5)
 *
 * Every press is preceded by a check that the panel is on the expected screen
 * (and row); any mismatch aborts. On abort the panel is put back as safely as
 * the capture allows and the result says exactly what state was left.
 */
import { McpToolError, messageOf } from '@chrischall/mcp-utils';
import type { PanelState, WebTouchSession } from './webtouch.js';

export const SCREEN = { home: '1', menu: '15', schedule: '40', keypad: '41', picker: '56', onetouch: '77' } as const;
const SCREEN_NAMES: Record<string, string> = { 1: 'Home', 15: 'Menu', 40: 'Schedule', 41: 'Time keypad', 56: 'Device picker', 77: 'OneTouch' };
const CMD = {
  home: 1,
  menu: 2,
  onetouch: 3,
  menuSchedule: 17,
  add: 17,
  edit: 18,
  del: 19,
  pageDown: 20,
  pageUp: 21,
  save: 22,
  day0: 23,
  startTime: 33,
  stopTime: 34,
  row0: 34,
  ampm: 17,
  pickerPageDown: 18,
  pickerSelect: 19,
  pickerRow0: 19,
  dialogOk: 1,
  dialogCancel: 2,
} as const;
/** Run-day buttons in panel order (button idx 6 + k, command 23 + k). */
export const PANEL_DAYS = ['All', 'M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su', 'Wkdays', 'Wkends'] as const;
export type PanelDay = (typeof PANEL_DAYS)[number];
const PAGE_ROWS = 7;
const MAX_PAGES = 10;

export interface PanelSchedule {
  /** 1-based page of the schedule list it was read on. */
  page: number;
  /** 1..7 — the row on that page. */
  row: number;
  circuit: string;
  /** 24-hour HH:MM, or null if the panel's text could not be read. */
  start: string | null;
  stop: string | null;
  days: string;
  /** The panel's own text. */
  display: { start: string; stop: string };
}

/** "1:05 PM" → "13:05". */
export function from12(display: string): string | null {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(display.trim());
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) > 59) return null;
  const h = (Number(m[1]) % 12) + (m[3]!.toUpperCase() === 'PM' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** "13:05" → keypad text "01:05", meridiem "PM", panel display "1:05 PM". */
export function to12(hhmm: string): { text: string; mer: 'AM' | 'PM'; display: string } {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const mer = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const mm = String(m).padStart(2, '0');
  return { text: `${String(h12).padStart(2, '0')}:${mm}`, mer, display: `${h12}:${mm} ${mer}` };
}

/** Split a code-26 schedule row. Blank rows (no circuit) are null. */
export function parseRow(text: string | undefined): { circuit: string; start: string; stop: string; days: string } | null {
  const [circuit = '', start = '', stop = '', days = ''] = (text ?? '').split('\t').map((c) => c.trim());
  return circuit ? { circuit, start, stop, days } : null;
}

function pageRows(st: PanelState, page: number): PanelSchedule[] {
  const out: PanelSchedule[] = [];
  for (let row = 1; row <= PAGE_ROWS; row++) {
    const r = parseRow(st.rows.get(row));
    if (r) out.push({ page, row, circuit: r.circuit, start: from12(r.start), stop: from12(r.stop), days: r.days, display: { start: r.start, stop: r.stop } });
  }
  return out;
}

/** Identity used to compare lists (the panel's text, order-insensitive). */
export function sameList(a: Array<Pick<PanelSchedule, 'circuit' | 'display' | 'days'>>, b: Array<Pick<PanelSchedule, 'circuit' | 'display' | 'days'>>): boolean {
  const key = (l: typeof a) => l.map((s) => `${s.circuit.toLowerCase()}\t${s.display.start}\t${s.display.stop}\t${s.days}`).sort().join('\n');
  return key(a) === key(b);
}

const editOn = (st: PanelState) => st.buttons.get(1)?.state === '1';
const dayOn = (st: PanelState, d: PanelDay) => st.buttons.get(6 + PANEL_DAYS.indexOf(d))?.state === '1';

class Abort extends Error {}

const UNSAVED = 'UNSAVED changes (open WebTouch or the panel and Save or discard them)';
/** The panel's answers to leaving, or pressing anything but Save, while in schedule Edit mode. */
const EDIT_DIALOG = /must be saved before exiting|press save to store program changes/i;

/** What the panel is showing, as the panel check reports it. */
export interface PanelCheck {
  /** ready: no dialog, not in schedule Edit · edit_unsaved: schedule Edit with unsaved changes · dialog: another dialog is open. */
  state: 'ready' | 'edit_unsaved' | 'dialog';
  /** null when the panel answered with only a dialog. */
  screen: string | null;
  screenName: string | null;
  dialog: { message: string; buttons: string[] } | null;
  /** null when the screen is unknown and no dialog says. */
  editMode: boolean | null;
}

export function describePanel(st: PanelState): PanelCheck {
  const editDialog = st.dialog !== null && EDIT_DIALOG.test(st.dialog.message);
  const editMode = editDialog || (st.screen === SCREEN.schedule && editOn(st)) ? true : st.screen === null ? null : false;
  return {
    state: editMode ? 'edit_unsaved' : st.dialog ? 'dialog' : 'ready',
    screen: st.screen,
    screenName: st.screen === null ? null : (SCREEN_NAMES[st.screen] ?? `screen ${st.screen}`),
    dialog: st.dialog && { message: st.dialog.message, buttons: st.dialog.buttons },
    editMode,
  };
}

/** One panel operation: guarded presses, a dirty flag, and clean-up on abort. */
export class PanelOp {
  /** Something has been entered that a Save would store. */
  dirty = false;
  /** This operation turned Edit mode on (so an empty Save to leave it is ours to press). */
  ownsEdit = false;
  private readonly pressesBefore: number;

  constructor(readonly s: WebTouchSession) {
    this.pressesBefore = s.presses;
  }

  get st(): PanelState {
    return this.s.state;
  }

  /** Abort unless the panel is on `screen` with no dialog (and, if given, `row` selected / edit mode as stated). */
  expect(screen: string, opts: { row?: number; edit?: boolean } = {}): void {
    const st = this.st;
    const bad =
      st.screen !== screen
        ? `the panel is on screen ${st.screen}, expected ${screen}`
        : st.dialog
          ? `a dialog is open ("${st.dialog.message}")`
          : opts.row !== undefined && st.selected !== opts.row
            ? `row ${st.selected} is selected, expected row ${opts.row}`
            : opts.edit !== undefined && editOn(st) !== opts.edit
              ? `Edit mode is ${editOn(st) ? 'on' : 'off'}, expected ${opts.edit ? 'on' : 'off'}`
              : null;
    if (bad) throw new Abort(bad);
  }

  /** From Home (or Menu): Menu → Schedule, page 1. */
  async enterSchedule(): Promise<void> {
    if (this.st.screen !== SCREEN.menu) {
      this.expect(SCREEN.home);
      await this.s.press(CMD.menu, 'the Menu screen', (st) => st.screen === SCREEN.menu);
    }
    this.expect(SCREEN.menu);
    await this.s.press(CMD.menuSchedule, 'the Schedule screen', (st) => st.screen === SCREEN.schedule);
  }

  /** Read every page from page 1 (PageDown while a page is full and the next differs). Leaves the panel on the last page read. */
  async readPages(): Promise<{ list: PanelSchedule[]; pages: number }> {
    let page = 1;
    let rows = pageRows(this.st, page);
    const list = [...rows];
    while (rows.length === PAGE_ROWS && page < MAX_PAGES) {
      this.expect(SCREEN.schedule, { edit: false });
      const before = JSON.stringify(rows.map((r) => [r.circuit, r.display, r.days]));
      await this.s.press(CMD.pageDown, 'the next schedule page', () => true);
      const next = pageRows(this.st, page + 1);
      if (JSON.stringify(next.map((r) => [r.circuit, r.display, r.days])) === before) break;
      page++;
      rows = next;
      list.push(...rows);
    }
    return { list, pages: page };
  }

  async home(): Promise<void> {
    if (this.st.dialog) throw new Abort(`a dialog is open ("${this.st.dialog.message}")`);
    if (this.st.screen === SCREEN.schedule && editOn(this.st) && !this.ownsEdit) {
      throw new Abort('the panel is already in schedule Edit mode — someone may be editing at the panel');
    }
    if (this.st.screen === SCREEN.home) return;
    await this.s.press(CMD.home, 'the Home screen', (st) => st.screen === SCREEN.home);
  }

  /** Home → Menu → Schedule, read all pages, Home. */
  async readSchedules(): Promise<PanelSchedule[]> {
    await this.home();
    await this.enterSchedule();
    const { list } = await this.readPages();
    await this.home();
    return list;
  }

  /** From the last page read, PageUp to `page`. */
  async goToPage(page: number, from: number): Promise<void> {
    for (let p = from; p > page; p--) {
      this.expect(SCREEN.schedule, { edit: false });
      await this.s.press(CMD.pageUp, 'the previous schedule page', () => true);
    }
  }

  async selectRow(row: number): Promise<void> {
    this.expect(SCREEN.schedule, { edit: false });
    await this.s.press(CMD.row0 + row, `row ${row} to be selected`, (st) => st.selected === row);
  }

  /** Set the selected row's start or stop time through the keypad (AM/PM toggled to match first). */
  async setTime(which: 'start' | 'stop', hhmm: string, row: number): Promise<void> {
    const want = to12(hhmm);
    const cell = (st: PanelState) => parseRow(st.rows.get(row))?.[which];
    if (cell(this.st) === want.display) return;
    this.expect(SCREEN.schedule, { row, edit: true });
    await this.s.press(which === 'start' ? CMD.startTime : CMD.stopTime, `the ${which} time keypad`, (st) => st.screen === SCREEN.keypad);
    if (this.st.texts.get(2) !== want.mer) {
      this.expect(SCREEN.keypad);
      await this.s.press(CMD.ampm, `the keypad to show ${want.mer}`, (st) => st.texts.get(2) === want.mer);
    }
    this.expect(SCREEN.keypad);
    this.dirty = true;
    await this.s.enterText(want.text, `the ${which} time to read ${want.display}`, (st) => st.screen === SCREEN.schedule && cell(st) === want.display);
  }

  async setDays(days: PanelDay, row: number): Promise<void> {
    if (dayOn(this.st, days)) return;
    this.expect(SCREEN.schedule, { row, edit: true });
    this.dirty = true;
    await this.s.press(CMD.day0 + PANEL_DAYS.indexOf(days), `the ${days} run-day button to light`, (st) => dayOn(st, days));
  }

  async save(): Promise<void> {
    this.expect(SCREEN.schedule, { edit: true });
    await this.s.press(CMD.save, 'Save to turn Edit off', (st) => !editOn(st));
    this.dirty = false;
  }

  /**
   * After an abort: close a dialog, leave edit mode if nothing was entered
   * (a Save then is a no-op — owner-verified), go Home where that is safe.
   * A panel this operation never pressed is left exactly as found. Home is
   * never pressed over unsaved changes (it only raises "must be saved").
   * Returns a description of the state the panel was left in.
   */
  async cleanUp(): Promise<string> {
    const step = async (cmd: number, what: string, until: (st: PanelState) => boolean) => {
      try {
        await this.s.press(cmd, what, until);
      } catch {
        /* report the state below */
      }
    };
    if (this.s.presses > this.pressesBefore) {
      if (this.st.dialog) {
        const isDelete = /delete this program/i.test(this.st.dialog.message);
        await step(isDelete ? CMD.dialogCancel : CMD.dialogOk, 'the dialog to close', (st) => st.dialog === null);
      }
      if (!this.st.dialog && this.st.screen === SCREEN.schedule && editOn(this.st) && this.ownsEdit && !this.dirty) {
        await step(CMD.save, 'Save (no-op) to turn Edit off', (st) => !editOn(st));
      }
      const stuck =
        this.dirty || this.st.dialog || this.st.screen === null || this.st.screen === SCREEN.keypad || (this.st.screen === SCREEN.schedule && editOn(this.st));
      if (!stuck) await step(CMD.home, 'the Home screen', (st) => st.screen === SCREEN.home);
    }
    const st = this.st;
    const parts = [st.screen === null ? 'panel left on an unknown screen' : `panel left on screen ${st.screen}`];
    if (st.screen === SCREEN.schedule && editOn(st)) parts.push(`in Edit mode with ${UNSAVED}`);
    else if (this.dirty) parts.push(`with ${UNSAVED}`);
    if (st.screen === SCREEN.keypad) parts.push('on the time keypad, mid-entry');
    if (st.dialog) parts.push(`with the dialog "${st.dialog.message}" open`);
    if (st.dialog && EDIT_DIALOG.test(st.dialog.message)) parts.push(`(the panel is in schedule Edit mode with ${UNSAVED})`);
    return parts.join(' ');
  }

  /** Run `body`; on any failure clean up and rethrow with the state left. */
  async run<T>(what: string, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (err) {
      const left = await this.cleanUp();
      throw new McpToolError(`${what} aborted: ${messageOf(err)} — ${left}.`, {
        hint: err instanceof Abort ? 'The panel was not in the state this step expected, so nothing further was pressed.' : undefined,
      });
    }
  }
}

/** The list the change was planned against no longer matches what is on the panel. */
function assertUnchanged(now: PanelSchedule[], planned: PanelSchedule[]): void {
  if (!sameList(now, planned)) throw new Abort('the schedule list changed since it was previewed; nothing was pressed');
}

export async function readSchedules(s: WebTouchSession): Promise<PanelSchedule[]> {
  const op = new PanelOp(s);
  return op.run('Reading the schedules', () => op.readSchedules());
}

/** The picker's rows 1..7 as trimmed text ('' when blank or not yet painted). */
export function pickerRows(st: PanelState): string[] {
  return [...Array(PAGE_ROWS).keys()].map((i) => (st.rows.get(i + 1) ?? '').trim());
}

/** Find a device on the picker (screen 56) by label, paging down; returns its row. */
async function pickDevice(op: PanelOp, label: string): Promise<number> {
  const want = label.trim().toLowerCase();
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = pickerRows(op.st);
    const i = rows.findIndex((r) => r.toLowerCase() === want);
    if (i >= 0) return i + 1;
    op.expect(SCREEN.picker);
    const before = rows.join('\n');
    await op.s.press(CMD.pickerPageDown, 'the next device page', () => true);
    if (pickerRows(op.st).join('\n') === before) break;
  }
  throw new Abort(`the panel's device list has no "${label}"`);
}

export interface AddRequest {
  circuit: string;
  start: string;
  stop: string;
  days: PanelDay;
}

/** Add(17) → picker → Select(19) → Start(33) → Stop(34) → day → Save(22) → Home, then verify from a fresh entry. */
export async function addSchedule(s: WebTouchSession, req: AddRequest, planned: PanelSchedule[]): Promise<PanelSchedule[]> {
  const op = new PanelOp(s);
  await op.run('Adding the schedule', async () => {
    await op.home();
    await op.enterSchedule();
    assertUnchanged((await op.readPages()).list, planned);
    op.expect(SCREEN.schedule, { edit: false });
    await s.press(CMD.add, 'the device picker', (st) => st.screen === SCREEN.picker);
    const n = await pickDevice(op, req.circuit);
    op.expect(SCREEN.picker);
    await s.press(CMD.pickerRow0 + n, `device row ${n} to be selected`, (st) => st.selected === n);
    op.expect(SCREEN.picker, { row: n });
    op.dirty = true;
    op.ownsEdit = true;
    await s.press(CMD.pickerSelect, 'the new schedule row (Edit on)', (st) => st.screen === SCREEN.schedule && editOn(st) && st.selected !== null);
    const row = s.state.selected!;
    if (parseRow(s.state.rows.get(row))?.circuit.toLowerCase() !== req.circuit.trim().toLowerCase()) {
      throw new Abort(`the new row ${row} is not "${req.circuit}"`);
    }
    await op.setTime('start', req.start, row);
    await op.setTime('stop', req.stop, row);
    await op.setDays(req.days, row);
    await op.save();
    await op.home();
  });
  return readSchedules(s);
}

export interface Target {
  page: number;
  row: number;
}

/** Navigate to the target row (verified against the planned list) and select it. */
async function selectTarget(op: PanelOp, t: Target, planned: PanelSchedule[]): Promise<void> {
  await op.home();
  await op.enterSchedule();
  const { list, pages } = await op.readPages();
  assertUnchanged(list, planned);
  await op.goToPage(t.page, pages);
  const want = planned.find((p) => p.page === t.page && p.row === t.row)!;
  const have = parseRow(op.st.rows.get(t.row));
  if (!have || have.circuit !== want.circuit || have.start !== want.display.start || have.stop !== want.display.stop || have.days !== want.days) {
    throw new Abort(`page ${t.page} row ${t.row} does not show the expected schedule`);
  }
  await op.selectRow(t.row);
}

export interface EditRequest {
  start?: string;
  stop?: string;
  days?: PanelDay;
}

/** Select row → Edit(18) → times/days → Save(22) → Home, then verify. */
export async function editSchedule(s: WebTouchSession, t: Target, req: EditRequest, planned: PanelSchedule[]): Promise<PanelSchedule[]> {
  const op = new PanelOp(s);
  await op.run('Editing the schedule', async () => {
    await selectTarget(op, t, planned);
    op.expect(SCREEN.schedule, { row: t.row, edit: false });
    op.ownsEdit = true;
    await s.press(CMD.edit, 'Edit mode', editOn);
    if (req.start) await op.setTime('start', req.start, t.row);
    if (req.stop) await op.setTime('stop', req.stop, t.row);
    if (req.days) await op.setDays(req.days, t.row);
    await op.save();
    await op.home();
  });
  return readSchedules(s);
}

/** Select row → Delete(19) → "delete this program" → Ok(1) (persists without Save) → Home, then verify. */
export async function deleteSchedule(s: WebTouchSession, t: Target, planned: PanelSchedule[]): Promise<PanelSchedule[]> {
  const op = new PanelOp(s);
  await op.run('Deleting the schedule', async () => {
    await selectTarget(op, t, planned);
    op.expect(SCREEN.schedule, { row: t.row, edit: false });
    await s.press(CMD.del, 'the delete confirmation', (st) => /delete this program/i.test(st.dialog?.message ?? ''));
    await s.press(CMD.dialogOk, 'the confirmation to close', (st) => st.dialog === null);
    await op.home();
  });
  return readSchedules(s);
}

export interface PanelScene {
  /** 0..5 — the scene's button index (command 17 + index). */
  index: number;
  label: string;
  on: boolean;
}

function scenes(st: PanelState): PanelScene[] {
  return [...st.buttons.entries()]
    .filter(([i, b]) => i <= 5 && b.label.trim() !== '')
    .sort(([a], [b]) => a - b)
    .map(([index, b]) => ({ index, label: b.label, on: b.state === '1' }));
}

/** OneTouch(3) → screen 77, read the scenes, Home. */
export async function readOneTouch(s: WebTouchSession): Promise<PanelScene[]> {
  const op = new PanelOp(s);
  return op.run('Reading OneTouch', async () => {
    await op.home();
    op.expect(SCREEN.home);
    await s.press(CMD.onetouch, 'the OneTouch screen', (st) => st.screen === SCREEN.onetouch);
    const out = scenes(s.state);
    await op.home();
    return out;
  });
}

/** Press 17 + index only if the scene is not already `on`; returns the scenes re-read after. */
export async function setOneTouch(s: WebTouchSession, index: number, on: boolean): Promise<PanelScene[]> {
  const op = new PanelOp(s);
  return op.run('Switching the OneTouch scene', async () => {
    await op.home();
    op.expect(SCREEN.home);
    await s.press(CMD.onetouch, 'the OneTouch screen', (st) => st.screen === SCREEN.onetouch);
    const scene = scenes(s.state).find((x) => x.index === index);
    if (!scene) throw new Abort(`the OneTouch screen shows no scene ${index}`);
    if (scene.on !== on) {
      op.expect(SCREEN.onetouch);
      await s.press(17 + index, `"${scene.label}" to turn ${on ? 'on' : 'off'}`, (st) => (st.buttons.get(index)?.state === '1') === on);
    }
    const after = scenes(s.state);
    await op.home();
    return after;
  });
}
