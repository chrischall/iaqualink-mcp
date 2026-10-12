/**
 * iAqua (Jandy iAquaLink panel) parsing — a transcription of iaqualink-py
 * 0.7.0's `systems/iaqua/system.py` + `device.py`, minus its object model.
 *
 * Two screens, both fetched over the session.json command channel:
 *  - `get_home` → `home_screen`: rows 0-3 are status / response / system_type
 *    / temp_scale, every later row is a one-key object `{ <device>: <state> }`.
 *  - `get_devices` → `devices_screen`: rows 0-2 are status / response / group,
 *    every later row is `{ aux_<n>: [ {state}, {label}, {icon}, {type}, {subtype} ] }`.
 */
import { McpToolError, type View } from '@chrischall/mcp-utils';
import type { RawStatus } from './client.js';

/** The pump/heater toggles iaqualink-py drives with `set_<name>`. */
export const IAQUA_EQUIPMENT = ['pool_pump', 'spa_pump', 'pool_heater', 'spa_heater', 'solar_heater'] as const;
export type IaquaEquipment = (typeof IAQUA_EQUIPMENT)[number];

const STATE_LABELS: Record<string, string> = { '0': 'off', '1': 'on', '2': 'standby', '3': 'enabled' };

/** iaqualink-py's AqualinkState, as words. Unknown values pass through. */
export function stateLabel(v: string): string {
  return STATE_LABELS[v] ?? v;
}

/** IaquaBinarySensor.is_on: ON, ENABLED or PRESENT. */
export function isOn(v: string | undefined): boolean {
  return v === '1' || v === '3' || v === 'present';
}

export interface ParsedHome {
  online: boolean;
  /** False when the panel answered but has not populated system_type yet. */
  ready: boolean;
  status: string;
  unit: string;
  entries: Record<string, string>;
  /** Rows whose value is an object/array — iaqualink-py ignores these. */
  structured: Record<string, unknown>;
}

function rows(json: unknown, key: string): unknown[] {
  const list = (json as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(list)) {
    throw new McpToolError(`Unexpected iAqua response: no ${key} array.`, { kind: 'http' });
  }
  return list;
}

function field(row: unknown, key: string): unknown {
  return row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined;
}

export function parseHome(json: unknown): ParsedHome {
  const list = rows(json, 'home_screen');
  const status = String(field(list[0], 'status') ?? '');
  const unit = String(field(list[3], 'temp_scale') ?? 'F') || 'F';
  const base = { status, unit, entries: {}, structured: {} };
  if (status === 'Offline') return { ...base, online: false, ready: false };
  if (field(list[2], 'system_type') === '') return { ...base, online: true, ready: false };
  const entries: Record<string, string> = {};
  const structured: Record<string, unknown> = {};
  for (const row of list.slice(4)) {
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (typeof v === 'string') entries[k] = v;
      else structured[k] = v;
    }
  }
  return { ...base, online: true, ready: true, entries, structured };
}

export interface LightModel {
  manufacturer: string;
  model: string;
  effects: Record<string, number>;
}

const names = (...n: string[]): Record<string, number> => Object.fromEntries(n.map((x, i) => [x, i]));

/** iaqualink-py's color-light subtypes (`light_subtype_to_class`) and their effect tables. */
export const COLOR_LIGHTS: Record<string, LightModel> = {
  '1': {
    manufacturer: 'Jandy',
    model: 'Colors Light',
    effects: names('Off', 'Alpine White', 'Sky Blue', 'Cobalt Blue', 'Caribbean Blue', 'Spring Green', 'Emerald Green', 'Emerald Rose', 'Magenta', 'Garnet Red', 'Violet', 'Color Splash'),
  },
  '2': {
    manufacturer: 'Pentair',
    model: 'SAm/SAL Light',
    effects: names('Off', 'White', 'Light Green', 'Green', 'Cyan', 'Blue', 'Lavender', 'Magenta', 'Light Magenta', 'Color Splash'),
  },
  '3': {
    manufacturer: 'Pentair',
    model: 'ColorLogic Light',
    effects: names('Off', 'Voodoo Lounge', 'Deep Blue Sea', 'Afternoon Skies', 'Emerald', 'Sangria', 'Cloud White', 'Twilight', 'Tranquility', 'Gemstone', 'USA!', 'Mardi Gras', 'Cool Cabaret'),
  },
  '4': {
    manufacturer: 'Jandy',
    model: 'LED WaterColors Light',
    effects: names('Off', 'Alpine White', 'Sky Blue', 'Cobalt Blue', 'Caribbean Blue', 'Spring Green', 'Emerald Green', 'Emerald Rose', 'Magenta', 'Violet', 'Slow Splash', 'Fast Splash', 'USA!', 'Fat Tuesday', 'Disco Tech'),
  },
  '5': {
    manufacturer: 'Pentair',
    model: 'Intellibrite Light',
    effects: names('Off', 'SAm', 'Party', 'Romance', 'Caribbean', 'American', 'California Sunset', 'Royal', 'Blue', 'Green', 'Red', 'White', 'Magenta'),
  },
  '6': {
    manufacturer: 'Hayward',
    model: 'Universal Light',
    effects: names('Off', 'Voodoo Lounge', 'Deep Blue Sea', 'Royal Blue', 'Afternoon Skies', 'Aqua Green', 'Emerald', 'Cloud White', 'Warm Red', 'Flamingo', 'Vivid Violet', 'Sangria', 'Twilight', 'Tranquility', 'Gemstone', 'USA!', 'Mardi Gras', 'Cool Cabaret'),
  },
};

/** Dimmable lights only accept 25% steps (IaquaDimmableLight.set_brightness). */
export const BRIGHTNESS_STEPS = [0, 25, 50, 75, 100] as const;

export type AuxKind = 'switch' | 'light' | 'dimmable_light' | 'color_light';

export interface AuxDevice {
  /** The aux number as the API uses it in `set_aux_<n>` and `aux=<n>`. */
  aux: string;
  name: string;
  label: string;
  state: string;
  on: boolean;
  kind: AuxKind;
  type: string;
  subtype: string;
  icon?: string;
  /** Dimmable lights: the level (iaqualink-py reads it from `subtype`). */
  brightness?: number;
  /** Color lights with a known subtype. */
  light?: LightModel;
}

const titleCase = (s: string, sep: string | RegExp): string =>
  s
    .split(sep)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

function classify(type: string, label: string): AuxKind {
  if (type === '2') return 'color_light';
  if (type === '1') return 'dimmable_light';
  if (label.toUpperCase().includes('LIGHT')) return 'light';
  return 'switch';
}

export function parseDevices(json: unknown): { online: boolean; stale: boolean; aux: AuxDevice[] } {
  const list = rows(json, 'devices_screen');
  if (field(list[0], 'status') === 'Offline') return { online: false, stale: false, aux: [] };
  const aux: AuxDevice[] = [];
  for (const row of list.slice(3)) {
    if (!row || typeof row !== 'object') continue;
    const [name, attrs] = Object.entries(row as Record<string, unknown>)[0] ?? [];
    if (!name || !Array.isArray(attrs)) continue;
    const flat: Record<string, string> = {};
    for (const a of attrs) Object.assign(flat, a);
    if (flat.state === 'NaN') return { online: true, stale: true, aux: [] };
    const label = flat.label ? titleCase(flat.label, ' ') : titleCase(name, '_');
    const type = flat.type ?? '0';
    const subtype = flat.subtype ?? '0';
    const kind = classify(type, flat.label ?? '');
    const device: AuxDevice = {
      aux: name.replace('aux_', ''),
      name,
      label,
      state: flat.state ?? '',
      // IaquaAuxSwitch.is_on: only "1".
      on: flat.state === '1',
      kind,
      type,
      subtype,
      icon: flat.icon,
    };
    if (kind === 'dimmable_light') device.brightness = Number(subtype);
    if (kind === 'color_light') device.light = COLOR_LIGHTS[subtype];
    aux.push(device);
  }
  return { online: true, stale: false, aux };
}

/** Normalise a caller's aux reference ("3", "aux_3", "aux3") to the API name. */
export function auxKey(ref: string): string {
  const m = /^(?:aux_?)?(.+)$/i.exec(ref.trim())!;
  return `aux_${m[1]}`;
}

/** Find an aux circuit by number, `aux_<n>` name or (case-insensitive) label. */
export function findAux(aux: AuxDevice[], ref: string): AuxDevice | undefined {
  const key = auxKey(ref).toLowerCase();
  const label = ref.trim().toLowerCase();
  return aux.find((a) => a.name.toLowerCase() === key) ?? aux.find((a) => a.label.toLowerCase() === label);
}

/** IAQUA_TEMP_{FAHRENHEIT,CELSIUS}_{LOW,HIGH}. */
export function tempRange(unit: string): { min: number; max: number } {
  return unit === 'F' ? { min: 34, max: 104 } : { min: 1, max: 40 };
}

/**
 * `set_temps` must carry BOTH set points in one request (IaquaSystem.set_temps):
 * temp1 is the spa when the system has a spa set point, and the pool is then
 * temp2; with no spa, temp1 is the pool. Unrequested ones keep their current value.
 */
export function setTempsParams(
  entries: Record<string, string>,
  want: { pool?: number; spa?: number },
): Record<string, string> {
  const hasSpa = Boolean(entries.spa_set_point);
  if (want.spa !== undefined && !hasSpa) {
    throw new McpToolError('This system reports no spa set point, so the spa temperature cannot be set.');
  }
  if (!entries.pool_set_point) {
    throw new McpToolError('This system reports no pool set point; refusing to send a temperature change.');
  }
  const pool = String(want.pool ?? entries.pool_set_point);
  return hasSpa ? { temp1: String(want.spa ?? entries.spa_set_point), temp2: pool } : { temp1: pool };
}

function reading(v: string | undefined): number | string | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

const CHEMISTRY = ['pool_salinity', 'spa_salinity', 'orp', 'ph'];

/** The status view of an iAqua system. */
export function normalizeIaqua(raw: Extract<RawStatus, { kind: 'iaqua' }>, view: View): Record<string, unknown> {
  const home = parseHome(raw.home);
  const devices = parseDevices(raw.devices);
  const e = home.entries;
  const out: Record<string, unknown> = {
    serial: raw.system.serial_number,
    name: raw.system.name ?? null,
    type: 'iaqua',
    online: home.online && devices.online,
    unit: home.unit,
  };
  if (!home.online) {
    out.note = 'iAqualink reports this system Offline — the panel is not connected to the cloud.';
    return out;
  }
  if (!home.ready || devices.stale) {
    out.note = 'The panel has not reported its state yet (iAqualink returned an empty screen). Try again shortly.';
  }
  const temperatures: Record<string, unknown> = {};
  const setPoints: Record<string, unknown> = {};
  const equipment: Record<string, string> = {};
  const chemistry: Record<string, unknown> = {};
  const other: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) {
    if (k.endsWith('_temp')) temperatures[k.replace(/_temp$/, '')] = reading(v);
    else if (k.endsWith('_set_point')) setPoints[k.replace(/_set_point$/, '')] = reading(v);
    else if (k.endsWith('_pump') || k.endsWith('_heater')) equipment[k] = stateLabel(v);
    else if (k === 'freeze_protection') out.freezeProtection = stateLabel(v);
    else if (CHEMISTRY.includes(k)) {
      if (v !== '') chemistry[k] = reading(v);
    } else other[k] = v;
  }
  Object.assign(out, { temperatures, setPoints, equipment, chemistry });
  out.aux = devices.aux.map((a) => {
    const base: Record<string, unknown> = { aux: a.aux, label: a.label, on: a.on, kind: a.kind };
    if (a.brightness !== undefined) base.brightness = a.brightness;
    if (view === 'compact') return base;
    return {
      ...base,
      state: a.state,
      type: a.type,
      subtype: a.subtype,
      ...(a.light ? { manufacturer: a.light.manufacturer, model: a.light.model, effects: Object.keys(a.light.effects) } : {}),
    };
  });
  out.other = other;
  if (view !== 'compact') {
    out.homeEntries = e;
    out.structured = home.structured;
  }
  return out;
}
