import { describe, it, expect } from 'vitest';
import { IaqualinkClient } from '../src/client.js';
import { PrintNLParser, WebTouchSession, applyEvent, decodeJs, emptyState, withPanel } from '../src/webtouch.js';
import { FakeIaqualink } from './support/fake-server.js';

const TIMING = { stepTimeoutMs: 300, quietMs: 5 };

function client(server: FakeIaqualink) {
  return new IaqualinkClient({ email: 'me@example.com', password: server.password, fetchImpl: server.fetch, minIntervalMs: 0, statusCacheMs: 0 });
}

describe('PrintNLParser', () => {
  it('parses complete calls and decodes JS escapes, never evaluating', () => {
    const p = new PrintNLParser();
    const evs = p.feed(
      "<script type='text/javascript'>parent.printNL('26','0||1||Pool Light\\t7:00 PM\\t11:00 PM\\tAll')</script>" +
        "<script>parent.printNL('2c', 'it\\'s \\x41\\u0042\\\\')</script>",
    );
    expect(evs).toEqual([
      { code: '26', params: '0||1||Pool Light\t7:00 PM\t11:00 PM\tAll' },
      { code: '2C', params: "it's AB\\" },
    ]);
  });

  it('reassembles calls split across reads, including a split marker', () => {
    const p = new PrintNLParser();
    const call = "<script>parent.printNL('23','40')</script>";
    const out = [];
    for (const c of call) out.push(...p.feed(c));
    expect(out).toEqual([{ code: '23', params: '40' }]);
  });

  it('skips junk, non-code first arguments and code-like expressions', () => {
    const p = new PrintNLParser();
    expect(p.feed("hello parent.printNL('zz','x') parent.printNL(alert(1),'x') parent.printNL('123','x') <b>")).toEqual([]);
    expect(p.feed("parent.printNL('25','1||02:00')")).toEqual([{ code: '25', params: '1||02:00' }]);
  });

  it('drops an unterminated call that grows past the buffer cap', () => {
    const p = new PrintNLParser();
    p.feed("parent.printNL('26','" + 'x'.repeat(300 * 1024));
    expect(p.feed("')parent.printNL('23','1')")).toEqual([{ code: '23', params: '1' }]);
  });

  it('decodes the escapes it knows and passes others through', () => {
    expect(decodeJs('a\\tb\\nc\\rd\\qe\\/')).toBe('a\tb\nc\rdqe/');
  });
});

describe('applyEvent', () => {
  it('tracks screen, title, rows, selection, buttons, texts and dialogs', () => {
    const st = emptyState();
    const ev = (code: string, params: string) => applyEvent(st, { code, params });
    ev('23', '40');
    ev('2D', 'Schedule');
    ev('26', '0||1||Cleaner\t8:00 AM\t8:30 AM\tWkends');
    ev('26', '0||x||junk');
    ev('40', '0||1||1');
    ev('40', '0||2||0');
    ev('40', '0||x||1');
    ev('24', '1||1||1||Edit||');
    ev('24', 'x||1');
    ev('24', '7');
    ev('25', '1||02:00');
    ev('25', 'y||z');
    ev('28', '10||11||26||23||20');
    ev('99', 'ignored');
    ev('2C', '3||1||Are you sure you want to delete this program?.||Ok||Cancel||');
    expect(st).toMatchObject({ screen: '40', title: 'Schedule', selected: 1, dialog: { type: '3', buttons: ['Ok', 'Cancel'] } });
    expect(st.rows.get(1)).toBe('Cleaner\t8:00 AM\t8:30 AM\tWkends');
    expect(st.buttons.get(1)).toEqual({ state: '1', img: '1', label: 'Edit', text: '' });
    expect(st.buttons.get(7)).toEqual({ state: '', img: '', label: '', text: '' });
    expect(st.texts.get(1)).toBe('02:00');
    ev('40', '0||1||0');
    expect(st.selected).toBeNull();
    ev('2C', '0||0|| ');
    expect(st.dialog).toBeNull();
    ev('2C', '0');
    expect(st.dialog).toBeNull();
    ev('23', '40');
    expect(st.rows.size).toBe(1);
    ev('23', '1');
    expect(st).toMatchObject({ screen: '1', title: null, selected: null });
    expect(st.rows.size).toBe(0);
  });
});

describe('WebTouchSession', () => {
  it('opens: init, stream, start-up press on the start actionID, first screen', async () => {
    const server = new FakeIaqualink();
    const s = await WebTouchSession.open(client(server), 'IAQ123', TIMING);
    expect(s.state.screen).toBe('1');
    expect(server.webtouch.commands[0]).toEqual({ actionID: 'START-1', command: '1' });
    await s.press(2, 'Menu', (st) => st.screen === '15');
    expect(server.webtouch.commands[1]).toEqual({ actionID: 'MASTER-1', command: '2' });
    s.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(server.webtouch.streamsOpen).toBe(0);
  });

  it('reassembles split chunks from the live stream', async () => {
    const server = new FakeIaqualink();
    server.webtouch.splitChunks = true;
    const s = await WebTouchSession.open(client(server), 'IAQ123', TIMING);
    expect(s.state.title).toBe('Home');
    s.close();
  });

  it('times out when the panel never shows the expected state', async () => {
    const server = new FakeIaqualink();
    const s = await WebTouchSession.open(client(server), 'IAQ123', TIMING);
    server.webtouch.ignore.add('2');
    await expect(s.press(2, 'the Menu screen', (st) => st.screen === '15')).rejects.toThrow(/timed out waiting for the Menu screen \(panel on screen 1\)/);
    s.close();
  });

  it('fails a wait when the stream ends, or errors', async () => {
    const server = new FakeIaqualink();
    const s = await WebTouchSession.open(client(server), 'IAQ123', TIMING);
    server.webtouch.endStreams();
    await expect(s.waitFor(() => false, 'anything')).rejects.toThrow(/stream ended while waiting for anything\.$/);

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("parent.printNL('23','1')"));
        setTimeout(() => c.error(new Error('reset by peer')), 20);
      },
    });
    const c2 = client(new FakeIaqualink());
    const raw = c2 as unknown as { openWebTouchStream: () => Promise<ReadableStream<Uint8Array>> };
    raw.openWebTouchStream = async () => body;
    const s2 = await WebTouchSession.open(c2, 'IAQ123', TIMING);
    await expect(s2.waitFor(() => false, 'more')).rejects.toThrow(/reset by peer/);
  });

  it('closes the stream when start-up fails', async () => {
    const server = new FakeIaqualink();
    server.webtouch.ignore.add('1');
    await expect(WebTouchSession.open(client(server), 'IAQ123', TIMING)).rejects.toThrow(/first screen/);
    await new Promise((r) => setTimeout(r, 5));
    expect(server.webtouch.streamsOpen).toBe(0);
  });

  it('bounds quiet() by the step timeout on a chattering stream', async () => {
    const server = new FakeIaqualink();
    const s = await WebTouchSession.open(client(server), 'IAQ123', { stepTimeoutMs: 60, quietMs: 40 });
    const t = setInterval(() => server.webtouch.emit('2D', 'tick'), 5);
    const start = Date.now();
    await s.quiet();
    clearInterval(t);
    expect(Date.now() - start).toBeLessThan(200);
    s.close();
  });
});

describe('withPanel', () => {
  it('serializes sessions per system and always closes the stream', async () => {
    const server = new FakeIaqualink();
    const c = client(server);
    const order: string[] = [];
    const a = withPanel(c, 'IAQ123', TIMING, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a-end');
      throw new Error('boom');
    });
    const b = withPanel(c, 'IAQ123', TIMING, async () => {
      order.push('b');
      return server.webtouch.streamsOpen;
    });
    await expect(a).rejects.toThrow('boom');
    expect(await b).toBe(1);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    await new Promise((r) => setTimeout(r, 5));
    expect(server.webtouch.streamsOpen).toBe(0);
  });
});
