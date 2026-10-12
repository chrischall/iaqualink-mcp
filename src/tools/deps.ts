import type { IaqualinkClient } from '../client.js';
import type { WebTouchTiming } from '../webtouch.js';

/** How long a write waits for the change to show up in a re-read. */
export interface VerifyTiming {
  timeoutMs: number;
  intervalMs: number;
  initialDelayMs: number;
}

export interface Deps {
  client: IaqualinkClient;
  /** Per system type. iAqua answers within seconds; eXO applies desired state asynchronously and 429s on fast polling. */
  timing: { iaqua: VerifyTiming; exo: VerifyTiming; webtouch: WebTouchTiming };
}

export const DEFAULT_TIMING: Deps['timing'] = {
  iaqua: { timeoutMs: 15_000, intervalMs: 3_000, initialDelayMs: 1_000 },
  exo: { timeoutMs: 30_000, intervalMs: 10_000, initialDelayMs: 5_000 },
  // A press answers on the stream in 1-3 s; a list's rows follow its screen by up to ~0.9 s (live 2026-10-12).
  webtouch: { stepTimeoutMs: 15_000, quietMs: 2_000 },
};
