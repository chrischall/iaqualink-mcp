import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import type { IaqualinkClient } from '../client.js';
import type { WebTouchTiming } from '../webtouch.js';
import type { SystemLabel } from './systems.js';

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
  /** The supported systems' labels, listed once at start; undefined when the listing failed (no enum is published). */
  systems?: readonly SystemLabel[];
}

export const DEFAULT_TIMING: Deps['timing'] = {
  iaqua: { timeoutMs: 15_000, intervalMs: 3_000, initialDelayMs: 1_000 },
  exo: { timeoutMs: 30_000, intervalMs: 10_000, initialDelayMs: 5_000 },
  // A press answers on the stream in 1-3 s; a list's rows follow its screen by up to ~0.9 s (live 2026-10-12).
  webtouch: { stepTimeoutMs: 15_000, quietMs: 2_000 },
};

/**
 * The verification timing, with `IAQUALINK_VERIFY_TIMEOUT_MS` (a positive
 * integer) overriding how long a write re-reads before reporting
 * "sent-unconfirmed", for both iAqua and eXO. A caller with its own deadline
 * (a voice assistant's ~25 s per call) sets it below that budget. Unset or
 * malformed keeps the defaults, as `IAQUALINK_STATUS_CACHE_SECONDS` does.
 */
export function timingFromEnv(env: EnvSource = process.env): Deps['timing'] {
  const raw = readEnvVar('IAQUALINK_VERIFY_TIMEOUT_MS', { env });
  if (!raw || !/^[1-9]\d*$/.test(raw)) return DEFAULT_TIMING;
  const timeoutMs = Number(raw);
  return {
    iaqua: { ...DEFAULT_TIMING.iaqua, timeoutMs },
    exo: { ...DEFAULT_TIMING.exo, timeoutMs },
    webtouch: DEFAULT_TIMING.webtouch,
  };
}
