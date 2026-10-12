/**
 * eXO (Zodiac salt chlorinator) parsing and write shapes — a transcription of
 * iaqualink-py 0.7.0's `systems/exo/system.py` + `device.py`.
 *
 * Everything lives in one AWS-IoT-style device shadow:
 * `GET /devices/v1/<serial>/shadow` → `state.reported.{equipment.swc_0, heating, aws}`;
 * a write POSTs `{"state":{"desired":{…}}}` and the device applies it
 * asynchronously, so a write is only proven by a later `reported` read.
 */
import { McpToolError, type View } from '@chrischall/mcp-utils';
import type { RawStatus } from './client.js';

/** Switchable eXO equipment, by the name iaqualink-py routes each through. */
export const EXO_EQUIPMENT = ['filter_pump', 'production', 'boost', 'low', 'heating'] as const;
export type ExoEquipment = (typeof EXO_EQUIPMENT)[number];

type Json = Record<string, any>;

export interface ParsedShadow {
  connection: string | null;
  swc: Json;
  heating: Json | undefined;
  sensors: Array<{ key: string; type: string; on: boolean; value: unknown }>;
  aux: Array<{ aux: string; name: string; on: boolean; type: unknown; mode: unknown; color: unknown }>;
}

export function parseShadow(json: unknown): ParsedShadow {
  const reported = (json as Json | null)?.state?.reported;
  const swc = reported?.equipment?.swc_0;
  if (!swc || typeof swc !== 'object') {
    throw new McpToolError('Unexpected eXO shadow: no state.reported.equipment.swc_0 block.', { kind: 'http' });
  }
  const sensors: ParsedShadow['sensors'] = [];
  const aux: ParsedShadow['aux'] = [];
  for (const [k, v] of Object.entries(swc as Json)) {
    if (k.startsWith('sns_') && v && typeof v === 'object') {
      const on = v.state === 1;
      sensors.push({ key: k, type: String(v.sensor_type), on, value: on ? v.value : null });
    } else if (k.startsWith('aux_') && v && typeof v === 'object') {
      aux.push({ aux: k.replace('aux_', ''), name: k, on: v.state === 1, type: v.type, mode: v.mode, color: v.color });
    }
  }
  return { connection: reported.aws?.status ?? null, swc, heating: reported.heating, sensors, aux };
}

const onOff = (v: unknown): string => (v === 1 ? 'on' : 'off');

/** The status view of an eXO system. */
export function normalizeExo(raw: Extract<RawStatus, { kind: 'exo' }>, view: View): Record<string, unknown> {
  const p = parseShadow(raw.shadow);
  const s = p.swc;
  const sensor = (type: string) => p.sensors.find((x) => x.type.toLowerCase() === type)?.value ?? null;
  const out: Record<string, unknown> = {
    serial: raw.system.serial_number,
    name: raw.system.name ?? null,
    type: 'exo',
    // iaqualink-py treats eXO as Celsius only.
    unit: 'C',
    connection: p.connection,
    online: p.connection === null ? null : p.connection === 'connected',
    temperatures: { pool: sensor('water temp') },
    setPoints: p.heating ? { pool: p.heating.sp } : {},
  };
  if (p.heating) {
    out.heating = {
      enabled: onOff(p.heating.enabled),
      heater: onOff(p.heating.state),
      setPoint: p.heating.sp,
      min: p.heating.sp_min,
      max: p.heating.sp_max,
    };
  }
  out.chlorinator = {
    production: onOff(s.production),
    outputPercent: s.swc,
    boost: onOff(s.boost),
    boostTime: s.boost_time,
    low: onOff(s.low),
  };
  // As reported. The sample shadow pairs ph 75 with ph_sp 74, i.e. pH appears scaled ×10.
  out.chemistry = { ph: sensor('ph'), phSetPoint: s.ph_sp, orp: sensor('orp'), orpSetPoint: s.orp_sp };
  out.equipment = s.filter_pump ? { filter_pump: onOff(s.filter_pump.state) } : {};
  out.aux = p.aux.map((a) => ({ aux: a.aux, on: a.on, type: a.type }));
  out.errors = { code: s.error_code, state: s.error_state };
  if (view !== 'compact') {
    out.equipmentRaw = s;
    out.heatingRaw = p.heating;
  }
  return out;
}

export type ExoWrite =
  | { kind: 'equipment'; name: ExoEquipment; on: boolean }
  | { kind: 'aux'; name: string; on: boolean }
  | { kind: 'set_point'; value: number }
  | { kind: 'chlorinator'; value: number };

/** The `desired` block for a write — the shapes ExoSystem.set_heating/set_aux/set_toggle/set_filter_pump send. */
export function exoDesired(w: ExoWrite): Json {
  switch (w.kind) {
    case 'set_point':
      return { heating: { sp: w.value } };
    case 'chlorinator':
      // NOT in iaqualink-py: inferred from the reported `swc` field and the set_toggle shape.
      return { equipment: { swc_0: { swc: w.value } } };
    case 'aux':
      return { equipment: { swc_0: { [w.name]: { state: w.on ? 1 : 0 } } } };
    case 'equipment': {
      const n = w.on ? 1 : 0;
      if (w.name === 'heating') return { heating: { enabled: n } };
      if (w.name === 'filter_pump') return { equipment: { swc_0: { filter_pump: { state: n } } } };
      return { equipment: { swc_0: { [w.name]: n } } };
    }
  }
}

/** The reported value a write is proven by (undefined when the shadow lacks it). */
export function exoObserved(p: ParsedShadow, w: ExoWrite): unknown {
  switch (w.kind) {
    case 'set_point':
      return p.heating?.sp;
    case 'chlorinator':
      return p.swc.swc;
    case 'aux':
      return p.swc[w.name]?.state;
    case 'equipment':
      if (w.name === 'heating') return p.heating?.enabled;
      if (w.name === 'filter_pump') return p.swc.filter_pump?.state;
      return p.swc[w.name];
  }
}
