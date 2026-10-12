/**
 * WebTouch — iAqualink's browser emulation of an AquaLink RS panel's
 * touchscreen, and the only cloud route to an RS panel's own schedules and
 * OneTouch scenes.
 *
 * Shape (live capture 2026-10-11 on an RS panel, page v1.5-RS; the page's
 * client script netlink.js; ejc3/iaqualink-webtouch@42c4d65):
 *  - `webtouch/init` returns a display-stream URL and three actionIDs;
 *  - the stream is a long-lived GET emitting
 *    `<script …>parent.printNL('<code>','<a||b||c>')</script>` chunks — the
 *    panel's display, as deltas. They are parsed here with a strict regex and
 *    NEVER evaluated;
 *  - a press is `POST webtouch/command {actionID, command, dt}`; the panel
 *    answers on the stream, not in the response.
 *
 * One session per system at a time (`withPanel` serializes them): two
 * sessions would be two people pressing the same panel.
 */
import { McpToolError } from '@chrischall/mcp-utils';
import type { IaqualinkClient, WebTouchInit } from './client.js';

export interface PrintNL {
  code: string;
  params: string;
}

/** One complete `parent.printNL('code','params')` call; both arguments single-quoted JS strings. */
const CALL = /parent\.printNL\('((?:[^'\\\n]|\\.)*)'\s*,\s*'((?:[^'\\\n]|\\.)*)'\)/g;
const MARK = 'parent.printNL(';
const MAX_BUFFER = 256 * 1024;

/** Decode the JS string escapes the stream uses (\t inside row text, \' …). No evaluation. */
export function decodeJs(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (_, e: string) => {
    if (e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ t: '\t', n: '\n', r: '\r' } as Record<string, string>)[e] ?? e;
  });
}

/** Incremental printNL parser: calls split across reads are reassembled; junk is skipped. */
export class PrintNLParser {
  private buf = '';

  feed(text: string): PrintNL[] {
    this.buf += text;
    const out: PrintNL[] = [];
    let end = 0;
    for (const m of this.buf.matchAll(CALL)) {
      const code = decodeJs(m[1]!).toUpperCase();
      if (/^[0-9A-F]{2}$/.test(code)) out.push({ code, params: decodeJs(m[2]!) });
      end = m.index + m[0].length;
    }
    const rest = this.buf.slice(end);
    const start = rest.lastIndexOf(MARK);
    // Keep an unfinished call, or a tail that may be the start of the marker.
    this.buf = start >= 0 ? rest.slice(start) : rest.slice(-(MARK.length - 1));
    if (this.buf.length > MAX_BUFFER) this.buf = '';
    return out;
  }
}

export interface PanelButton {
  state: string;
  img: string;
  label: string;
  text: string;
}

export interface PanelState {
  /** Code 23. */
  screen: string | null;
  /** Code 2D. */
  title: string | null;
  /** Code 26 `list||row||text`, by row. */
  rows: Map<number, string>;
  /** Code 40 `list||row||1` — the highlighted row. */
  selected: number | null;
  /** Code 24 `idx||state||img||label||stateText`. */
  buttons: Map<number, PanelButton>;
  /** Code 25 `idx||text`. */
  texts: Map<number, string>;
  /** Code 2C `type||buttons||message||btn1||btn2…`; a blank message closes it. */
  dialog: { type: string; message: string; buttons: string[] } | null;
}

export function emptyState(): PanelState {
  return { screen: null, title: null, rows: new Map(), selected: null, buttons: new Map(), texts: new Map(), dialog: null };
}

const int = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);

/** Apply one printNL event to the panel state (netlink.js printNL, 1688-2430). */
export function applyEvent(st: PanelState, ev: PrintNL): void {
  const p = ev.params.split('||');
  switch (ev.code) {
    case '23':
      // netlink.js cleans the screen only when the id changes.
      if (ev.params !== st.screen) Object.assign(st, emptyState(), { screen: ev.params });
      return;
    case '2D':
      st.title = ev.params;
      return;
    case '24': {
      const idx = int(p[0]);
      if (idx !== null) st.buttons.set(idx, { state: p[1] ?? '', img: p[2] ?? '', label: p[3] ?? '', text: p[4] ?? '' });
      return;
    }
    case '25': {
      const idx = int(p[0]);
      if (idx !== null) st.texts.set(idx, p.slice(1).join('||'));
      return;
    }
    case '26': {
      const row = int(p[1]);
      if (row !== null) st.rows.set(row, p.slice(2).join('||'));
      return;
    }
    case '40': {
      const row = int(p[1]);
      if (row === null) return;
      if (p[2] === '1') st.selected = row;
      else if (st.selected === row) st.selected = null;
      return;
    }
    case '2C':
      st.dialog = (p[2] ?? '').trim() === '' ? null : { type: p[0]!, message: p[2]!, buttons: p.slice(3).filter((b) => b.trim() !== '') };
      return;
  }
}

export interface WebTouchTiming {
  /** How long to wait for the panel to show the expected state after a press. */
  stepTimeoutMs: number;
  /** A press is complete once the stream has been quiet this long. */
  quietMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A live panel session: the stream reader plus press/enterText. */
export class WebTouchSession {
  readonly state = emptyState();
  private readonly parser = new PrintNLParser();
  private readonly waiters = new Set<() => void>();
  private lastEventAt = Date.now();
  private closed = false;
  private failure: unknown;

  private constructor(
    private readonly client: IaqualinkClient,
    private readonly init: WebTouchInit,
    private readonly abort: AbortController,
    private readonly timing: WebTouchTiming,
  ) {}

  /** init → open the stream → the start-up press (netlink.js:2925) → wait for a first screen. */
  static async open(client: IaqualinkClient, serial: string, timing: WebTouchTiming): Promise<WebTouchSession> {
    const init = await client.webtouchInit(serial);
    const abort = new AbortController();
    const body = await client.openWebTouchStream(init.serverConnection, abort.signal);
    const s = new WebTouchSession(client, init, abort, timing);
    void s.pump(body);
    try {
      await client.webtouchCommand(init.start, 1);
      await s.waitFor((st) => st.screen !== null, 'the panel to show its first screen');
      await s.quiet();
      return s;
    } catch (err) {
      s.close();
      throw err;
    }
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of this.parser.feed(dec.decode(value, { stream: true }))) {
          applyEvent(this.state, ev);
          // The once-a-minute clock (28) is not a reaction to a press.
          if (ev.code !== '28') this.lastEventAt = Date.now();
        }
        this.notify();
      }
    } catch (err) {
      if (!this.abort.signal.aborted) this.failure = err;
    } finally {
      this.closed = true;
      this.notify();
    }
  }

  private notify(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Resolve once `pred(state)` holds; reject after stepTimeoutMs or if the stream ends. */
  waitFor(pred: (st: PanelState) => boolean, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (err) reject(err);
        else resolve();
      };
      const check = () => {
        if (pred(this.state)) return done();
        if (this.closed) {
          const why = this.failure ? `: ${(this.failure as Error).message}` : '';
          done(new McpToolError(`WebTouch: the display stream ended while waiting for ${what}${why}.`, { kind: 'transport' }));
        }
      };
      const timer = setTimeout(
        () => done(new McpToolError(`WebTouch: timed out waiting for ${what} (panel on screen ${this.state.screen}).`, { kind: 'timeout' })),
        this.timing.stepTimeoutMs,
      );
      this.waiters.add(check);
      check();
    });
  }

  /** Wait until the stream has been quiet for quietMs (bounded by stepTimeoutMs). */
  async quiet(): Promise<void> {
    const until = Date.now() + this.timing.stepTimeoutMs;
    for (;;) {
      const idle = Date.now() - this.lastEventAt;
      if (idle >= this.timing.quietMs || Date.now() >= until) return;
      await sleep(this.timing.quietMs - idle);
    }
  }

  /** Press a button (actionIdMasterId), then wait for `until` and for the stream to settle. */
  async press(command: number, what: string, until: (st: PanelState) => boolean): Promise<void> {
    this.lastEventAt = Date.now();
    await this.client.webtouchCommand(this.init.master, command);
    await this.waitFor(until, what);
    await this.quiet();
  }

  /** Submit the keypad (command 128 + text on actionIdMasterSTB, netlink.js:1411), then wait as `press` does. */
  async enterText(text: string, what: string, until: (st: PanelState) => boolean): Promise<void> {
    this.lastEventAt = Date.now();
    await this.client.webtouchCommand(this.init.stb, 128, text);
    await this.waitFor(until, what);
    await this.quiet();
  }

  close(): void {
    this.abort.abort();
  }
}

const locks = new Map<string, Promise<unknown>>();

/** Run `fn` with this system's panel session; sessions for one serial never overlap. The stream is always closed. */
export function withPanel<T>(
  client: IaqualinkClient,
  serial: string,
  timing: WebTouchTiming,
  fn: (s: WebTouchSession) => Promise<T>,
): Promise<T> {
  // Every stored tail is already caught, so a failed session never blocks the next.
  const prev = locks.get(serial) ?? Promise.resolve();
  const run = prev.then(async () => {
    const s = await WebTouchSession.open(client, serial, timing);
    try {
      return await fn(s);
    } finally {
      s.close();
    }
  });
  const tail = run.catch(() => undefined);
  locks.set(serial, tail);
  void tail.then(() => {
    if (locks.get(serial) === tail) locks.delete(serial);
  });
  return run;
}
