import { describe, it, expect } from 'vitest';
import { DEFAULT_TIMING } from '../src/tools/deps.js';

describe('write verification timing', () => {
  it('polls an eXO no faster than every 10 s — iaqualink-py saw 429s at 15 s polling', () => {
    expect(DEFAULT_TIMING.exo.intervalMs).toBeGreaterThanOrEqual(10_000);
    expect(DEFAULT_TIMING.exo.timeoutMs).toBeGreaterThan(DEFAULT_TIMING.exo.intervalMs);
    expect(DEFAULT_TIMING.iaqua.timeoutMs).toBeLessThanOrEqual(30_000);
  });
});
