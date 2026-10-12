/**
 * Pool schedules.
 *
 * - `iaqualink_list_schedules` (read): eXO timers from the device shadow; on
 *   iAqua, the iQ20 schedule list — which doubles as a live PROBE, because
 *   the sources disagree on which host serves it (see SESSION_ENDPOINTS). It
 *   tries each candidate once, in order, and reports which one answered and
 *   what every attempt got back (scrubbed of tokens).
 * - `iaqualink_set_schedule` (write): eXO timers only. iQ20 schedule writes
 *   (`do_schedule_operation`) are on hold, unbuilt: they reach only iQ20
 *   schedules, never an AquaLink RS panel's own programs, and no live
 *   account has confirmed the protocol yet.
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CONFIRM_FLOW_SENTENCE,
  McpToolError,
  RateLimitError,
  confirmTokenParam,
  messageOf,
  minifiedResult,
  toolAnnotations,
} from '@chrischall/mcp-utils';
import { SESSION_ENDPOINTS, type IaqualinkClient, type RawStatus, type SessionEndpoint } from '../client.js';
import {
  HHMM_PATTERN,
  checkExoWindow,
  deviceNames,
  findExoSchedule,
  minutes,
  normalizeIq20,
  parseExoSchedules,
  readScheduleList,
  type ExoSchedule,
} from '../schedules.js';
import { execute, exoRequest, type Plan } from './control.js';
import { serialArg } from './read.js';
import type { Deps } from './deps.js';

type Exo = Extract<RawStatus, { kind: 'exo' }>;

const RS_NOTE =
  'The AquaLink RS panel’s own built-in programs are stored in the panel and are not reachable through the iAqualink cloud API; only iQ20 (adapter firmware ≥ 3) schedules are.';

/** iQ20 schedules need adapter firmware ≥ 3 — the app hides Schedules below it (IQ20Device.m:19,119; IQ20CogMenuVC.m:67-73). */
const IQ20_MIN_FW = 3;

const FATAL_KINDS = ['no_credential', 'credential_rejected', 'session_expired'];

/** Per client, per serial: the session endpoint that last answered get_schedule_list. */
const resolved = new WeakMap<IaqualinkClient, Map<string, SessionEndpoint>>();

interface Attempt {
  endpoint: string;
  url: string;
  auth: string;
  outcome: 'answered' | 'refused' | 'failed';
  reason?: string;
  status?: number;
  body?: string;
}

/**
 * Ask each candidate endpoint for the schedule list — the last one that worked
 * first, then the rest in SESSION_ENDPOINTS order — each exactly once. A rate
 * limit or a broken sign-in stops the probe (they would fail everywhere).
 */
async function probeScheduleList(client: IaqualinkClient, serial: string) {
  let bySerial = resolved.get(client);
  if (!bySerial) resolved.set(client, (bySerial = new Map()));
  const cached = bySerial.get(serial);
  const order = cached ? [cached, ...SESSION_ENDPOINTS.filter((e) => e !== cached)] : [...SESSION_ENDPOINTS];
  const attempts: Attempt[] = [];
  for (const e of order) {
    const base = { endpoint: e.id, url: e.url, auth: e.auth };
    let body: unknown;
    try {
      body = await client.iaquaCommand(serial, 'get_schedule_list', { pageNum: '1' }, e);
    } catch (err) {
      if (err instanceof RateLimitError || FATAL_KINDS.includes(String((err as { kind?: unknown }).kind))) throw err;
      attempts.push({ ...base, outcome: 'failed', status: (err as { status?: number }).status, reason: client.scrubText(messageOf(err), 500) });
      continue;
    }
    const read = readScheduleList(body);
    const scrubbed = client.scrubText(JSON.stringify(body));
    if (!read.ok) {
      attempts.push({ ...base, outcome: 'refused', reason: read.reason, body: scrubbed });
      continue;
    }
    attempts.push({ ...base, outcome: 'answered', body: scrubbed });
    bySerial.set(serial, e);
    return { endpoint: e, read, attempts };
  }
  bySerial.delete(serial);
  return { endpoint: undefined, attempts };
}

async function listIq20(client: IaqualinkClient, raw: Extract<RawStatus, { kind: 'iaqua' }>) {
  const serial = raw.system.serial_number;
  const fw = (raw.home as { attached_system_fw_version?: unknown } | null)?.attached_system_fw_version ?? null;
  const out: Record<string, unknown> = { serial, type: 'iaqua', firmware: fw };
  if (fw !== null && fw !== '' && Number(fw) < IQ20_MIN_FW) {
    return { ...out, supported: false, reason: `The iAquaLink adapter reports firmware ${String(fw)}; iQ20 schedules need ${IQ20_MIN_FW} or later (the app hides Schedules below it).`, note: RS_NOTE };
  }
  const probe = await probeScheduleList(client, serial);
  if (!probe.endpoint) {
    return {
      ...out,
      supported: false,
      reason: 'No candidate endpoint returned a schedule list (see probe.attempts for each answer).',
      probe: { answeredBy: null, attempts: probe.attempts },
      note: RS_NOTE,
    };
  }
  const e = probe.endpoint;
  let names = new Map<string, string>();
  let deviceListError: string | undefined;
  try {
    names = deviceNames(await client.iaquaCommand(serial, 'get_master_device_list', { listType: '1', pageNum: '1' }, e));
  } catch (err) {
    deviceListError = client.scrubText(messageOf(err), 300);
  }
  const schedules = probe.read.list.map((s) => normalizeIq20(s, names));
  return {
    ...out,
    supported: true,
    count: schedules.length,
    totalCount: probe.read.totalCount,
    isNewScheduleAllowed: probe.read.newAllowed,
    schedules,
    ...(deviceListError ? { deviceListError } : {}),
    probe: { answeredBy: { id: e.id, url: e.url, auth: e.auth, source: e.source }, attempts: probe.attempts },
    note: `Read-only: changing iQ20 schedules is not built yet. ${RS_NOTE}`,
  };
}

function listExo(raw: Exo) {
  const parsed = parseExoSchedules(raw.shadow);
  const out = { serial: raw.system.serial_number, type: 'exo' };
  if (!parsed) return { ...out, supported: false, reason: 'This eXO’s shadow has no schedules block.' };
  return { ...out, supported: true, slots: parsed.supported, programmed: parsed.programmed, schedules: parsed.schedules };
}

const hhmm = z.string().regex(HHMM_PATTERN, '24-hour HH:MM');

/** The fields an eXO timer write is proven by. */
function exoState(s: ExoSchedule | undefined) {
  if (!s) return undefined;
  return { enabled: s.enabled, start: s.start, stop: s.stop, ...(s.rpm !== undefined ? { rpm: s.rpm } : {}) };
}

export function registerScheduleTools(server: McpServer, deps: Deps): void {
  const { client } = deps;

  server.registerTool(
    'iaqualink_list_schedules',
    {
      description:
        'List a pool system’s schedules (timers). eXO salt chlorinators: the pump, chlorinator and aux timers from the device (name, start/stop, enabled, rpm for variable-speed pumps). iAqua (Jandy iAquaLink) panels: the iQ20 schedule list (device, start/stop, days) — only on adapters with firmware 3+, and never the AquaLink RS panel’s own built-in programs, which the cloud API cannot reach. Unverified on live hardware: because sources disagree on which iAqualink host serves iQ20 schedules, this tries each candidate host once and reports which answered (`probe`), with each raw answer scrubbed of tokens. Returns `supported: false` with the reason when there are none to read.',
      annotations: toolAnnotations({ title: 'List pool schedules', readOnly: true, openWorld: true }),
      inputSchema: z.object({ serial: serialArg }),
    },
    async ({ serial }) => {
      const raw = await client.readRawStatus(serial);
      return minifiedResult(raw.kind === 'iaqua' ? await listIq20(client, raw) : listExo(raw));
    },
  );

  server.registerTool(
    'iaqualink_set_schedule',
    {
      description:
        'Change one eXO timer (pump, chlorinator or aux): set its start and stop time (24-hour HH:MM) and enable it, set rpm on a variable-speed pump timer, or disable it (enabled: false clears it to 00:00–00:00, as the app does). Identify the timer by its key (sch3), id (sch_3), name or endpoint (ssp_1) from iaqualink_list_schedules. A chlorinator timer must stay inside its pump timer’s window. eXO systems only — iAqua/iQ20 schedule changes are not supported. The eXO applies changes asynchronously; the result says whether a re-read confirmed it. Unverified on live hardware (shape from community Home Assistant integrations). ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Set an eXO timer', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        schedule: z.string().min(1).max(64).describe('Timer key (sch3), id (sch_3), name or endpoint (ssp_1)'),
        enabled: z.boolean().default(true).describe('false = disable and clear the timer'),
        start: hhmm.optional().describe('Start time, 24-hour HH:MM (required to enable)'),
        stop: hhmm.optional().describe('Stop time, 24-hour HH:MM, after start (required to enable)'),
        rpm: z.number().int().min(1).max(10_000).optional().describe('Pump speed — variable-speed pump (vsp_*) timers only'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, schedule, enabled, start, stop, rpm, confirmToken }, ctx: ServerContext) => {
      const raw = await client.readRawStatus(serial, { fresh: confirmToken !== undefined });
      if (raw.kind !== 'exo') {
        throw new McpToolError('Schedule changes are only supported on eXO systems.', {
          hint: 'iAqua iQ20 schedule writes are not built, and an AquaLink RS panel’s own programs are not reachable through the cloud API.',
        });
      }
      const list = parseExoSchedules(raw.shadow)?.schedules ?? [];
      const s = findExoSchedule(list, schedule);
      if (!s) {
        throw new McpToolError(`System ${serial} has no timer "${schedule}".`, {
          hint: `Timers: ${list.map((x) => `${x.id} (${x.device ?? x.endpoint})`).join(', ') || 'none'}.`,
        });
      }
      if (rpm !== undefined && !s.endpoint?.startsWith('vsp_')) {
        throw new McpToolError(`${s.device ?? s.id} is not a variable-speed pump timer, so it takes no rpm.`);
      }
      let next: { enabled: boolean; start: string; stop: string };
      if (enabled) {
        if (!start || !stop) throw new McpToolError('Give both start and stop (HH:MM) to enable a timer.');
        if (minutes(stop) <= minutes(start)) throw new McpToolError(`The stop time (${stop}) must be after the start time (${start}).`);
        next = { enabled: true, start, stop };
      } else {
        if (start || stop || rpm !== undefined) throw new McpToolError('Disabling a timer takes no start, stop or rpm.');
        next = { enabled: false, start: '00:00', stop: '00:00' };
      }
      const refusal = checkExoWindow(list, s.id, next);
      if (refusal) throw new McpToolError(refusal);

      const keepRpm = rpm ?? s.rpm;
      const requested = { ...next, ...(keepRpm !== undefined ? { rpm: keepRpm } : {}) };
      const desired = {
        schedules: {
          [s.id]: { enabled: next.enabled ? 1 : 0, timer: { start: next.start, end: next.stop }, ...(rpm !== undefined ? { rpm } : {}) },
        },
      };
      const previous = exoState(s);
      const plan: Plan = {
        tool: 'iaqualink_set_schedule',
        action: 'iaqualink.schedule.set',
        summary: next.enabled
          ? `Run ${s.device ?? s.id} (${s.id}) ${next.start}–${next.stop}${rpm !== undefined ? ` at ${rpm} rpm` : ''} on ${serial}`
          : `Disable ${s.device ?? s.id} (${s.id}) on ${serial}`,
        target: s.id,
        previous,
        requested,
        unchanged: JSON.stringify(previous) === JSON.stringify(requested),
        request: exoRequest(serial, desired),
        send: () => client.setExoDesired(serial, desired),
        observe: (r) => exoState(parseExoSchedules((r as Exo).shadow)?.schedules.find((x) => x.id === s.id)),
        note: 'eXO timer writes are taken from community Home Assistant integrations and unverified on live hardware.',
      };
      return execute(ctx, deps, serial, 'exo', plan, { serial, schedule, enabled, start, stop, rpm }, confirmToken);
    },
  );
}
