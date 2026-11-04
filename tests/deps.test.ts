import { describe, it, expect } from 'vitest';
import { DEFAULT_TIMING, timingFromEnv } from '../src/tools/deps.js';

describe('write verification timing', () => {
  it('polls an eXO no faster than every 10 s — iaqualink-py saw 429s at 15 s polling', () => {
    expect(DEFAULT_TIMING.exo.intervalMs).toBeGreaterThanOrEqual(10_000);
    expect(DEFAULT_TIMING.exo.timeoutMs).toBeGreaterThan(DEFAULT_TIMING.exo.intervalMs);
    expect(DEFAULT_TIMING.iaqua.timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it("waits out the panel's pause between a screen and its list rows", () => {
    // Live 2026-10-12: Schedule screen (23 "40") at +0 ms, first row (26) at +889 ms.
    expect(DEFAULT_TIMING.webtouch.quietMs).toBeGreaterThanOrEqual(1_500);
    expect(DEFAULT_TIMING.webtouch.stepTimeoutMs).toBeGreaterThan(DEFAULT_TIMING.webtouch.quietMs);
  });
});

describe('IAQUALINK_VERIFY_TIMEOUT_MS', () => {
  it('leaves today’s timing alone when unset', () => {
    expect(timingFromEnv({})).toEqual(DEFAULT_TIMING);
  });

  it('overrides the verify deadline for both panel kinds and nothing else', () => {
    const t = timingFromEnv({ IAQUALINK_VERIFY_TIMEOUT_MS: '4000' });
    expect(t.iaqua).toEqual({ ...DEFAULT_TIMING.iaqua, timeoutMs: 4_000 });
    expect(t.exo).toEqual({ ...DEFAULT_TIMING.exo, timeoutMs: 4_000 });
    expect(t.webtouch).toEqual(DEFAULT_TIMING.webtouch);
  });

  it('ignores anything that is not a positive integer', () => {
    for (const v of ['0', '-5', '1.5', 'soon', '', ' ']) {
      expect(timingFromEnv({ IAQUALINK_VERIFY_TIMEOUT_MS: v }), v).toEqual(DEFAULT_TIMING);
    }
  });

  it('never mutates the defaults', () => {
    timingFromEnv({ IAQUALINK_VERIFY_TIMEOUT_MS: '1' });
    expect(DEFAULT_TIMING.iaqua.timeoutMs).toBe(15_000);
    expect(DEFAULT_TIMING.exo.timeoutMs).toBe(30_000);
  });
});
