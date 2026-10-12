/**
 * Pool schedules — parsing and validation, no I/O.
 *
 * Two unrelated mechanisms share the word "schedule":
 *
 *  - **iAqua iQ20 schedules** (Jandy panels behind an iQ20 / iAquaLink 3.0
 *    adapter whose `attached_system_fw_version` is ≥ 3). Read with the
 *    session.json command `get_schedule_list`, written with
 *    `do_schedule_operation` (Add / Edit / Delete). Sources: the iAquaLink iOS
 *    app (krishvios/iAquaLink-Mirror@50e4182 IQ20ApiManager.m:151-231,
 *    IQ20Equipment.m:70-95) and iaqualink-py master (flz/iaqualink-py@eb1cf63
 *    docs/reference/systems/iaqua.md:867-945). NOT verified live.
 *  - **eXO timers**, which live in the device shadow under
 *    `state.reported.schedules.schN` and are written as shadow `desired`
 *    state (benjycov/exo_pool@64b8806 api.py:1173-1219, 759-767;
 *    dje2912/ha-iaqualink_exoiq@85bb2dd systems/exo/system.py:514-548,
 *    780-946).
 *
 * The RS panel's own built-in programs are a third thing, and no cloud API
 * reaches them.
 */
type Json = Record<string, any>;

/**
 * The iQ20 day selectors, as the app's picker sends them
 * (IQ20ScheduleSetupViewController.m:106; Base.lproj "AllDays" = "AllDays").
 * The app sends the LOCALIZED string, so a non-English panel may hold other
 * spellings; iaqualink-py's docs write "All Days". Unverified live.
 */
export const SCHEDULE_DAYS = [
  'AllDays',
  'Weekdays',
  'Weekends',
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
export type ScheduleDay = (typeof SCHEDULE_DAYS)[number];

/** A 24-hour `HH:MM`. */
export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function intIn(v: unknown, max: number): number | null {
  if (typeof v !== 'number' && (typeof v !== 'string' || v.trim() === '')) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/** `9, 5` → `"09:05"`; null unless both parts are in-range integers (or numeric strings). */
export function toHHMM(h: unknown, m: unknown): string | null {
  const H = intIn(h, 23);
  const M = intIn(m, 59);
  if (H === null || M === null) return null;
  return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
}

/** Minutes since midnight of a valid `HH:MM`. */
export function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

const truthy = (v: unknown): boolean => v === true || v === 'true';

/** The `response` text of an `is_error` body, or null when the body is not an error. */
export function scheduleError(body: unknown): string | null {
  const b = body && typeof body === 'object' ? (body as Json) : {};
  return truthy(b.is_error) ? String(b.response ?? '(no response text)') : null;
}

export type ScheduleListRead =
  | { ok: true; list: unknown[]; totalCount: number | null; newAllowed: boolean | null }
  | { ok: false; reason: string };

/** Read a `get_schedule_list` / `do_schedule_operation` body. */
export function readScheduleList(body: unknown): ScheduleListRead {
  const err = scheduleError(body);
  if (err !== null) return { ok: false, reason: `is_error: ${err}` };
  const b = (body ?? {}) as Json;
  if (!Array.isArray(b.scheduleList)) {
    return { ok: false, reason: typeof b.message === 'string' ? `no scheduleList (message: "${b.message}")` : 'no scheduleList' };
  }
  return {
    ok: true,
    list: b.scheduleList,
    totalCount: typeof b.totalCount === 'number' ? b.totalCount : null,
    newAllowed: b.isNewScheduleAllowed === undefined ? null : truthy(b.isNewScheduleAllowed),
  };
}

/** `get_master_device_list` → device id → name. */
export function deviceNames(body: unknown): Map<string, string> {
  const list = (body as Json | undefined)?.deviceList;
  const out = new Map<string, string>();
  for (const d of Array.isArray(list) ? list : []) {
    if (d && d.id !== undefined && typeof d.name === 'string') out.set(String(d.id), d.name);
  }
  return out;
}

export interface Iq20Schedule {
  id: string;
  deviceId: string | null;
  /** The device's name from get_master_device_list, when it lists it. */
  device: string | null;
  start: string | null;
  stop: string | null;
  days: string | null;
  raw: unknown;
}

export function normalizeIq20(item: unknown, names: Map<string, string>): Iq20Schedule {
  const s = (item && typeof item === 'object' ? item : {}) as Json;
  const deviceId = s.deviceId === undefined ? null : String(s.deviceId);
  return {
    id: String(s.id),
    deviceId,
    device: names.get(String(deviceId)) ?? null,
    start: toHHMM(s.startHrs, s.startMins),
    stop: toHHMM(s.stopHrs, s.stopMins),
    days: typeof s.scheduleDays === 'string' ? s.scheduleDays : null,
    raw: item,
  };
}

export interface ExoSchedule {
  /** The shadow key (`sch3`) — what a write addresses. */
  id: string;
  /** The schedule's own id field (`sch_3`). */
  scheduleId: string | null;
  device: string | null;
  endpoint: string | null;
  enabled: boolean;
  active: boolean;
  start: string | null;
  stop: string | null;
  /** eXO timers carry no day selector. */
  days: null;
  rpm?: number;
  raw: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** `state.reported.schedules` → its timers, or null when the shadow has no schedules block. */
export function parseExoSchedules(shadow: unknown): { supported: unknown; programmed: unknown; schedules: ExoSchedule[] } | null {
  const block = (shadow as Json | null)?.state?.reported?.schedules;
  if (!block || typeof block !== 'object') return null;
  const schedules: ExoSchedule[] = [];
  for (const [key, v] of Object.entries(block as Json)) {
    if (!v || typeof v !== 'object') continue;
    const timer = (v.timer ?? {}) as Json;
    const s: ExoSchedule = {
      id: key,
      scheduleId: str(v.id),
      device: str(v.name),
      endpoint: str(v.endpoint),
      enabled: v.enabled === 1,
      active: v.active === 1,
      start: str(timer.start),
      stop: str(timer.end),
      days: null,
      raw: v,
    };
    if (typeof v.rpm === 'number') s.rpm = v.rpm;
    schedules.push(s);
  }
  return { supported: block.supported ?? null, programmed: block.programmed ?? null, schedules };
}

/** Find an eXO timer by shadow key, id, name or endpoint (case-insensitive). */
export function findExoSchedule(list: ExoSchedule[], ref: string): ExoSchedule | undefined {
  const r = ref.trim().toLowerCase();
  return list.find((s) => [s.id, s.scheduleId, s.device, s.endpoint].some((x) => x?.toLowerCase() === r));
}

/**
 * The eXO grouping rule (dje2912 system.py:780-836, 868-895): a chlorinator
 * timer `swc_N` must sit inside the same-index pump timer (`vsp_N` or
 * `ssp_N`), and may only be enabled while that pump timer is. Checks the
 * timer `key` as it would be AFTER the write. Returns why it is refused, or null.
 */
export function checkExoWindow(
  list: ExoSchedule[],
  key: string,
  next: { enabled: boolean; start: string; stop: string },
): string | null {
  const target = list.find((s) => s.id === key);
  const m = /^(swc|vsp|ssp)_(\d+)$/.exec(target?.endpoint ?? '');
  if (!m) return null;
  const n = m[2];
  const label = (s: ExoSchedule) => `"${s.device ?? s.id}" (${s.id})`;
  if (m[1] === 'swc') {
    const pump = list.find((s) => s.endpoint === `vsp_${n}` || s.endpoint === `ssp_${n}`);
    if (!next.enabled || !pump) return null;
    if (!pump.enabled) return `The chlorinator timer can only run while its pump timer ${label(pump)} is enabled, and that one is disabled.`;
    if (next.start < pump.start! || next.stop > pump.stop!) {
      return `The chlorinator window must stay inside the pump timer ${label(pump)}, which runs ${pump.start}–${pump.stop}.`;
    }
    return null;
  }
  const swc = list.find((s) => s.endpoint === `swc_${n}`);
  if (!swc || !swc.enabled) return null;
  if (!next.enabled) return `The chlorinator timer ${label(swc)} is enabled and needs this pump timer; disable ${label(swc)} first.`;
  if (swc.start! < next.start || swc.stop! > next.stop) {
    return `The enabled chlorinator timer ${label(swc)} runs ${swc.start}–${swc.stop}; the pump window must still contain it.`;
  }
  return null;
}
