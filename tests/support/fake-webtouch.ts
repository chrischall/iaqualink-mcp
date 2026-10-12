/**
 * An in-memory AquaLink RS panel behind WebTouch, emulating what the live
 * capture recorded (scratchpad CAPTURE.md, 2026-10-11, page v1.5-RS): the
 * printNL stream, the screens (1 home, 15 menu, 40 schedule list, 41 time
 * keypad, 56 device picker, 77 OneTouch), the command ids, the edit-mode
 * guard, the delete confirmation and Save. Behaviour the capture did not
 * record (e.g. picker selection echo, PageDown past the end) is marked.
 *
 * Seen live 2026-10-12 (an add aborted mid-way, then recovered by hand):
 *  - back from the keypad the panel sends only the screen id and the changed
 *    row — no selection, no Edit state (netlink.js keeps the hidden screen's
 *    elements and shows them again);
 *  - Save sends only the Edit-off state and the changed row;
 *  - in Edit mode a row press answers "Press SAVE to store program changes.";
 *  - the start-up press of a new session, in Edit mode, only raises "Program
 *    changes must be saved…" (no screen); with a dialog open it closes it.
 */

export interface PanelSchedule {
  circuit: string;
  start: string;
  stop: string;
  days: string;
}

/** The owner's live schedules, as captured. */
export const WT_SCHEDULES: PanelSchedule[] = [
  { circuit: 'Filter Pump', start: '1:01 PM', stop: '1:00 PM', days: 'All' },
  { circuit: 'Cleaner', start: '8:00 AM', stop: '8:30 AM', days: 'Wkends' },
  { circuit: 'Cleaner', start: '2:00 PM', stop: '2:30 PM', days: 'Wkdays' },
  { circuit: 'Pool Light', start: '7:00 PM', stop: '11:00 PM', days: 'All' },
];

/** Screen 56 device picker, pages as captured. */
export const WT_DEVICES = [
  'Filter Pump', 'Spa', 'VSP1 Spd Adj', 'Pool Heat', 'Spa Heat', 'Cleaner', 'Air Blower',
  'Pool Light', 'Not Used', 'Not Used', 'Extra Aux', 'Spa Mode', 'Clean Mode',
];

export const WT_ONETOUCH = ['All OFF', 'Spa Mode', 'Clean Mode', 'OneTouch 4', 'OneTouch 5', 'OneTouch 6'];

/** Run-day buttons, dynamic idx 6..15 = commands 23..32. */
const DAYS = ['All', 'M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su', 'Wkdays', 'Wkends'];

export const WT_INIT = {
  label: 'Pool',
  serverConnection: 'https://prm.iaqualink.net/v2/webtouch/stream?session=abc',
  actionIdMasterId: 'MASTER-1',
  actionIdMasterStart: 'START-1',
  actionIdMasterSTB: 'STB-1',
  actionIdMasteReset: 'RESET-1',
  systemType: 'RS',
};

/** JS single-quoted string literal escaping, as the panel's stream uses (\t inside row text). */
function jsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\t/g, '\\t');
}

const PAGE = 7;

export class FakeWebTouch {
  screen = 1;
  /** What the panel has stored (Save and Delete write here). */
  saved: PanelSchedule[] = structuredClone(WT_SCHEDULES);
  /** The list being shown/edited on screen 40. */
  working: PanelSchedule[] = structuredClone(WT_SCHEDULES);
  page = 0;
  selected: number | null = null;
  edit = false;
  dialog: 'delete' | 'mustSave' | 'pressSave' | null = null;
  keypad: { field: 'start' | 'stop'; time: string; mer: string } | null = null;
  pickerPage = 0;
  pickerSelected: number | null = null;
  onetouch: boolean[] = WT_ONETOUCH.map(() => false);
  /** Commands the panel silently ignores (to test timeouts). */
  ignore = new Set<string>();
  /** When true, the picker echoes no row selection (code 40) — the capture did not record one. */
  pickerSilent = false;
  /** Split every emitted chunk in two, to exercise reassembly. */
  splitChunks = false;
  /** Called with each command after it is applied. */
  afterCommand: ((cmd: string) => void) | undefined;
  readonly commands: Array<{ actionID: string; command: string; text?: string }> = [];
  streamsOpened = 0;
  streamsOpen = 0;
  private controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  private readonly enc = new TextEncoder();

  /** A new long-lived stream response. */
  stream(signal: AbortSignal | undefined): Response {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctl = c;
      },
      cancel: () => this.drop(ctl),
    });
    this.controllers.push(ctl);
    this.streamsOpened++;
    this.streamsOpen++;
    signal?.addEventListener('abort', () => {
      this.drop(ctl);
      try {
        ctl.error(new Error('aborted'));
      } catch {
        /* already closed */
      }
    });
    queueMicrotask(() => this.emit('28', '10||11||26||23||20'));
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  }

  /** End every open stream from the server side. */
  endStreams(): void {
    for (const c of [...this.controllers]) {
      this.drop(c);
      c.close();
    }
  }

  private drop(c: ReadableStreamDefaultController<Uint8Array>): void {
    const i = this.controllers.indexOf(c);
    if (i >= 0) {
      this.controllers.splice(i, 1);
      this.streamsOpen--;
    }
  }

  /** Emit raw text (for parser tests: junk, partial calls). */
  raw(text: string): void {
    for (const c of this.controllers) c.enqueue(this.enc.encode(text));
  }

  emit(code: string, params: string): void {
    const chunk = `<script type='text/javascript'>parent.printNL('${code}','${jsEscape(params)}')</script>\n`;
    if (this.splitChunks) {
      const mid = Math.floor(chunk.length / 2);
      this.raw(chunk.slice(0, mid));
      this.raw(chunk.slice(mid));
    } else {
      this.raw(chunk);
    }
  }

  // ── painting ────────────────────────────────────────────────────────────

  private go(screen: number): void {
    this.screen = screen;
    this.emit('23', String(screen));
    this.paint();
  }

  private rowText(s: PanelSchedule | undefined): string {
    return s ? `${s.circuit}\t${s.start}\t${s.stop}\t${s.days}` : '';
  }

  private paintRows(): void {
    for (let n = 1; n <= PAGE; n++) {
      const i = this.page * PAGE + n - 1;
      this.emit('26', `0||${n}||${this.rowText(this.working[i])}`);
      this.emit('40', `0||${n}||${this.selected === i ? 1 : 0}`);
    }
  }

  private paintDays(): void {
    const days = this.selected === null ? undefined : this.working[this.selected]?.days;
    DAYS.forEach((d, k) => this.emit('24', `${k + 6}||${d === days ? 1 : 0}||1||${d}||`));
  }

  private paint(): void {
    switch (this.screen) {
      case 1:
        this.emit('2D', 'Home');
        ['Filter Pump', 'Spa', 'Pool Heat'].forEach((l, i) => this.emit('24', `${i}||0||1||${l}||OFF`));
        break;
      case 15:
        this.emit('2D', 'Menu');
        break;
      case 40:
        this.emit('2D', 'Schedule');
        this.emit('24', `1||${this.edit ? 1 : 0}||1||Edit||`);
        this.paintRows();
        this.paintDays();
        break;
      case 41:
        this.emit('25', `1||${this.keypad!.time}`);
        this.emit('25', `2||${this.keypad!.mer}`);
        break;
      case 56:
        this.emit('26', '0||0||Select Device');
        for (let n = 1; n <= PAGE; n++) this.emit('26', `0||${n}||${WT_DEVICES[this.pickerPage * PAGE + n - 1] ?? ''}`);
        break;
      case 77:
        WT_ONETOUCH.forEach((l, i) => this.emit('24', `${i}||${this.onetouch[i] ? 1 : 0}||1||${l}||${this.onetouch[i] ? 'ON' : 'OFF'}`));
        break;
    }
  }

  private openDialog(kind: 'delete' | 'mustSave' | 'pressSave'): void {
    this.dialog = kind;
    if (kind === 'delete') this.emit('2C', '3||1||Are you sure you want to delete this program?.||Ok||Cancel||');
    else if (kind === 'mustSave') this.emit('2C', '0||1||Program changes must be saved before exiting this screen.||Ok');
    else this.emit('2C', '0||1||Press SAVE to store program changes.||Ok');
  }

  private closeDialog(): void {
    this.dialog = null;
    this.emit('2C', '0||0|| ');
  }

  // ── commands ────────────────────────────────────────────────────────────

  command(actionID: string, command: string, text?: string): void {
    this.commands.push({ actionID, command, ...(text !== undefined ? { text } : {}) });
    if (this.ignore.has(command)) return;
    if (actionID === WT_INIT.actionIdMasterStart && command === '1') this.start();
    else if (actionID === WT_INIT.actionIdMasterSTB && command === '128') this.enter(text ?? '');
    else if (actionID === WT_INIT.actionIdMasterId) this.press(Number(command));
    this.afterCommand?.(command);
  }

  private start(): void {
    if (this.dialog) return this.closeDialog();
    if (this.screen === 40 && this.edit) return this.openDialog('mustSave');
    this.go(this.screen);
  }

  private leave(to: number): void {
    if (this.screen === 40 && this.edit) return this.openDialog('mustSave');
    if (to === 40) {
      this.working = structuredClone(this.saved);
      this.page = 0;
      this.selected = null;
      this.edit = false;
    }
    this.go(to);
  }

  private press(cmd: number): void {
    if (this.dialog) {
      const kind = this.dialog;
      if (cmd === 1 && kind === 'delete') {
        this.working.splice(this.selected!, 1);
        this.saved = structuredClone(this.working);
        this.selected = null;
        this.closeDialog();
        this.paintRows();
        return;
      }
      if (cmd === 1 || cmd === 2) this.closeDialog();
      return;
    }
    if (cmd === 1) return this.leave(1);
    if (cmd === 2) return this.leave(15);
    if (cmd === 3) return this.leave(77);
    if (cmd === 5) return this.leave(({ 15: 1, 40: 15, 56: 40, 77: 1 } as Record<number, number>)[this.screen] ?? 1);
    switch (this.screen) {
      case 15:
        if (cmd === 17) this.leave(40);
        return;
      case 40:
        return this.schedulePress(cmd);
      case 41:
        if (cmd === 17) {
          this.keypad!.mer = this.keypad!.mer === 'AM' ? 'PM' : 'AM';
          this.emit('25', `2||${this.keypad!.mer}`);
        }
        return;
      case 56:
        return this.pickerPress(cmd);
      case 77:
        if (cmd >= 17 && cmd <= 22) {
          const i = cmd - 17;
          this.onetouch[i] = !this.onetouch[i];
          this.emit('24', `${i}||${this.onetouch[i] ? 1 : 0}||1||${WT_ONETOUCH[i]}||${this.onetouch[i] ? 'ON' : 'OFF'}`);
        }
        return;
    }
  }

  private schedulePress(cmd: number): void {
    const sel = this.selected === null ? undefined : this.working[this.selected];
    if (cmd === 17) {
      this.pickerPage = 0;
      this.pickerSelected = null;
      return this.go(56);
    }
    if (cmd === 18 && sel) {
      this.edit = !this.edit;
      this.emit('24', `1||${this.edit ? 1 : 0}||1||Edit||`);
      if (!this.edit && JSON.stringify(this.working) !== JSON.stringify(this.saved)) this.openDialog('pressSave');
      return;
    }
    if (cmd === 19 && sel) return this.openDialog('delete');
    if (cmd === 20 && (this.page + 1) * PAGE < this.working.length) {
      this.page++;
      return this.paintRows();
    }
    if (cmd === 21 && this.page > 0) {
      this.page--;
      return this.paintRows();
    }
    if (cmd === 22) {
      // A Save with nothing changed is a no-op on the panel, but it still turns Edit off (captured).
      this.saved = structuredClone(this.working);
      this.edit = false;
      this.emit('24', '1||0||1||Edit||');
      return this.paintSelectedRow();
    }
    if (cmd >= 23 && cmd <= 32 && this.edit && sel) {
      sel.days = DAYS[cmd - 23]!;
      this.paintDays();
      return this.paintRows();
    }
    if ((cmd === 33 || cmd === 34) && this.edit && sel) {
      const [time, mer] = (cmd === 33 ? sel.start : sel.stop).split(' ');
      const [h, m] = time!.split(':');
      this.keypad = { field: cmd === 33 ? 'start' : 'stop', time: `${h!.padStart(2, '0')}:${m}`, mer: mer! };
      return this.go(41);
    }
    if (cmd >= 35 && cmd <= 41) {
      const i = this.page * PAGE + cmd - 35;
      if (this.edit) return this.openDialog('pressSave');
      if (!this.working[i]) return;
      this.selected = i;
      this.paintRows();
      this.paintDays();
    }
  }

  private pickerPress(cmd: number): void {
    if (cmd === 17 && this.pickerPage > 0) this.pickerPage--;
    else if (cmd === 18 && (this.pickerPage + 1) * PAGE < WT_DEVICES.length) this.pickerPage++;
    else if (cmd >= 20 && cmd <= 26) {
      const i = this.pickerPage * PAGE + cmd - 20;
      if (WT_DEVICES[i] === undefined) return;
      this.pickerSelected = i;
      if (!this.pickerSilent) {
        for (let n = 1; n <= PAGE; n++) this.emit('40', `0||${n}||${n === cmd - 19 ? 1 : 0}`);
      }
      return;
    } else if (cmd === 19 && this.pickerSelected !== null) {
      this.working.push({ circuit: WT_DEVICES[this.pickerSelected]!, start: '1:00 PM', stop: '1:00 PM', days: 'All' });
      this.selected = this.working.length - 1;
      this.page = Math.floor(this.selected / PAGE);
      this.edit = true;
      return this.go(40);
    } else return;
    this.paint();
  }

  private enter(text: string): void {
    if (this.screen !== 41) return;
    const [h, m] = text.split(':');
    const value = `${Number(h)}:${m} ${this.keypad!.mer}`;
    const sel = this.working[this.selected!]!;
    if (this.keypad!.field === 'start') sel.start = value;
    else sel.stop = value;
    this.keypad = null;
    this.screen = 40;
    this.emit('23', '40');
    this.paintSelectedRow();
  }

  private paintSelectedRow(): void {
    if (this.selected === null) return;
    this.emit('26', `0||${this.selected - this.page * PAGE + 1}||${this.rowText(this.working[this.selected])}`);
  }
}
