import { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
import { IaqualinkClient } from '../../src/client.js';
import { registrars } from '../../src/tools/index.js';
import type { Deps } from '../../src/tools/deps.js';
import { FakeIaqualink } from './fake-server.js';

const FAST = { timeoutMs: 1_000, intervalMs: 0, initialDelayMs: 0 };

export async function setup(opts: { client?: IaqualinkClient; server?: FakeIaqualink } = {}) {
  const server = opts.server ?? new FakeIaqualink();
  const client =
    opts.client ??
    new IaqualinkClient({
      email: 'me@example.com',
      password: server.password,
      fetchImpl: server.fetch,
      minIntervalMs: 0,
      statusCacheMs: 0,
      sleep: async () => {},
    });
  const deps: Deps = { client, timing: { iaqua: FAST, exo: FAST, webtouch: { stepTimeoutMs: 300, quietMs: 3 } } };
  const h = await createTestHarness((s) => {
    for (const r of registrars) r(s, deps);
  });
  /** Call a tool and parse its JSON body (asserting it is not an error). */
  const call = async <T = Record<string, any>>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const res = await h.callTool(name, args);
    if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.content)}`);
    return parseToolResult<T>(res);
  };
  /** Call a tool expecting an error; returns its text. */
  const fail = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const res = await h.callTool(name, args);
    if (!res.isError) throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(res.content)}`);
    return (res.content as Array<{ text: string }>).map((c) => c.text).join('\n');
  };
  /** Drive the two-phase confirm flow: preview, then the token call. */
  const confirmed = async (name: string, args: Record<string, unknown>) => {
    const preview = await call(name, args);
    if (preview.status !== 'confirmation-required') return { preview, result: preview };
    const result = await call(name, { ...args, confirmToken: preview.confirmToken });
    return { preview, result };
  };
  return { server, client, h, call, fail, confirmed };
}
