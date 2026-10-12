/**
 * Confirm-gated equipment control.
 *
 * Every tool here follows the same five steps:
 *  1. read the system's current state (fresh on the confirming call);
 *  2. if it is already in the requested state, say so and send NOTHING — the
 *     iAqua pump/heater/aux commands are TOGGLES, so sending one blind would
 *     flip whatever the state happens to be;
 *  3. gate on the user's confirmation (`confirmWrite`), binding the request
 *     and the state it was planned against, so a state change between preview
 *     and confirmation is refused rather than toggled the wrong way;
 *  4. send;
 *  5. re-read until the field the write REQUESTED shows the requested value
 *     (or a deadline passes) and report what was observed — a 200 from
 *     iAqualink only means the command was accepted.
 *
 * Annotations, by the inverse test: every write here has an inverse in this
 * same tool set (on/off, a set point back to its old value), and none reaches
 * another person or spends anything single-use, so none is destructive.
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CONFIRM_FLOW_SENTENCE,
  McpToolError,
  confirmTokenParam,
  confirmWrite,
  messageOf,
  minifiedResult,
  toolAnnotations,
  verifyAfterWrite,
  type ConfirmWriteRequest,
} from '@chrischall/mcp-utils';
import type { RawStatus } from '../client.js';
import {
  BRIGHTNESS_STEPS,
  IAQUA_EQUIPMENT,
  findAux,
  isOn,
  parseDevices,
  parseHome,
  setTempsParams,
  tempRange,
  type AuxDevice,
} from '../iaqua.js';
import { EXO_EQUIPMENT, exoDesired, exoObserved, parseShadow, type ExoWrite } from '../exo.js';
import { serialArg } from './read.js';
import type { Deps } from './deps.js';

type Iaqua = Extract<RawStatus, { kind: 'iaqua' }>;
type Exo = Extract<RawStatus, { kind: 'exo' }>;

interface Plan {
  tool: string;
  action: string;
  summary: string;
  target: string;
  /** The current value of what the write changes — bound as the revision and reported. */
  previous: unknown;
  requested: unknown;
  /** Already in the requested state: nothing is sent. */
  unchanged: boolean;
  request: ConfirmWriteRequest;
  send: () => Promise<unknown>;
  /** Read the value this write is proven by, from a fresh status. */
  observe: (raw: RawStatus) => unknown;
  /** Whether an observed value proves the write. Defaults to deep equality with `requested`. */
  settled?: (observed: unknown) => boolean;
  note?: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function iaquaRequest(serial: string, command: string, params: Record<string, string> = {}): ConfirmWriteRequest {
  // The session id is added at send time and is deliberately not part of the preview.
  return { method: 'GET', path: '/v2/mobile/session.json', query: { ...params, actionID: 'command', command, serial } };
}

function exoRequest(serial: string, desired: Record<string, unknown>): ConfirmWriteRequest {
  return { method: 'POST', path: `/devices/v1/${serial}/shadow`, body: { state: { desired } } };
}

async function execute(
  ctx: ServerContext,
  deps: Deps,
  serial: string,
  kind: RawStatus['kind'],
  plan: Plan,
  args: Record<string, unknown>,
  confirmToken: string | undefined,
) {
  const base = { serial, target: plan.target, requested: plan.requested, previous: plan.previous };
  if (plan.unchanged) {
    return minifiedResult({ status: 'unchanged', ...base, note: 'Already in the requested state — nothing was sent.' });
  }
  const gate = await confirmWrite(ctx, {
    tool: plan.tool,
    action: plan.action,
    summary: plan.summary,
    account: deps.client.account,
    target: `${serial}:${plan.target}`,
    revision: JSON.stringify(plan.previous),
    request: plan.request,
    preview: { system: serial, current: plan.previous, requested: plan.requested, ...(plan.note ? { note: plan.note } : {}) },
    args,
    confirmToken,
  });
  if (gate) return gate;

  await plan.send();
  deps.client.invalidate(serial);

  const settled = plan.settled ?? ((v: unknown) => same(v, plan.requested));
  const v = await verifyAfterWrite({
    read: async () => plan.observe(await deps.client.readRawStatus(serial, { fresh: true })),
    isSettled: settled,
    ...deps.timing[kind],
  });
  const result: Record<string, unknown> = {
    status: v.settled ? 'confirmed' : 'sent-unconfirmed',
    ...base,
    observed: v.snapshot,
    verification: { outcome: v.outcome, reads: v.attempts, elapsedMs: v.elapsedMs },
  };
  if (v.outcome === 'read_failed') result.readError = messageOf(v.error);
  if (!v.settled) {
    result.note =
      kind === 'exo'
        ? 'iAqualink accepted the change, but the eXO had not reported it yet when this stopped checking (it applies changes asynchronously). Check again with iaqualink_get_status in a minute before retrying.'
        : 'iAqualink accepted the command, but a re-read did not show the change yet. Check again with iaqualink_get_status before retrying — these commands are toggles, so a blind retry could undo it.';
  }
  if (plan.note) result.caveat = plan.note;
  return minifiedResult(result);
}

function exoPlan(serial: string, w: ExoWrite, raw: Exo, meta: Pick<Plan, 'tool' | 'action' | 'summary' | 'target' | 'note'>, requested: number, deps: Deps): Plan {
  const previous = exoObserved(parseShadow(raw.shadow), w);
  const desired = exoDesired(w);
  return {
    ...meta,
    previous,
    requested,
    unchanged: previous === requested,
    request: exoRequest(serial, desired),
    send: () => deps.client.setExoDesired(serial, desired),
    observe: (r) => exoObserved(parseShadow((r as Exo).shadow), w),
  };
}

const onArg = z.boolean().describe('true = turn on, false = turn off');

function unknownAux(serial: string, ref: string, available: string[]): McpToolError {
  return new McpToolError(`System ${serial} has no aux circuit "${ref}".`, {
    hint: `Available: ${available.join(', ') || 'none'}. Use the number, aux_<n>, or the label from iaqualink_get_status.`,
  });
}

export function registerControlTools(server: McpServer, deps: Deps): void {
  const { client } = deps;
  const read = (serial: string, confirmToken: string | undefined) =>
    client.readRawStatus(serial, { fresh: confirmToken !== undefined });

  // ── pumps, heaters, chlorinator toggles ──────────────────────────────────
  server.registerTool(
    'iaqualink_set_equipment',
    {
      description:
        'Turn pool equipment on or off. iAqua (Jandy iAquaLink) systems: pool_pump, spa_pump, pool_heater, spa_heater, solar_heater. eXO salt chlorinators: filter_pump, production (chlorine generation), boost, low (low-output mode), heating. Reads the current state first and sends nothing if it already matches (iAqua commands are toggles); afterwards re-reads to confirm the change landed. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Switch pool equipment', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        equipment: z.enum([...IAQUA_EQUIPMENT, ...EXO_EQUIPMENT]).describe('Which equipment to switch'),
        on: onArg,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, equipment, on, confirmToken }, ctx) => {
      const raw = await read(serial, confirmToken);
      const meta = {
        tool: 'iaqualink_set_equipment',
        action: 'iaqualink.equipment.set',
        summary: `Turn ${equipment.replace(/_/g, ' ')} ${on ? 'on' : 'off'} on ${serial}`,
        target: equipment,
      };
      let plan: Plan;
      if (raw.kind === 'iaqua') {
        const entries = parseHome(raw.home).entries;
        if (!(IAQUA_EQUIPMENT as readonly string[]).includes(equipment) || !(equipment in entries)) {
          const have = IAQUA_EQUIPMENT.filter((e) => e in entries);
          throw new McpToolError(`System ${serial} (iAqua) has no "${equipment}".`, { hint: `It reports: ${have.join(', ') || 'none'}.` });
        }
        const previous = isOn(entries[equipment]);
        const command = `set_${equipment}`;
        plan = {
          ...meta,
          previous,
          requested: on,
          unchanged: previous === on,
          request: iaquaRequest(serial, command),
          send: () => client.iaquaCommand(serial, command),
          observe: (r) => isOn(parseHome((r as Iaqua).home).entries[equipment]),
        };
      } else {
        if (!(EXO_EQUIPMENT as readonly string[]).includes(equipment)) {
          throw new McpToolError(`System ${serial} is an eXO chlorinator; "${equipment}" is iAqua equipment.`, {
            hint: `eXO equipment: ${EXO_EQUIPMENT.join(', ')}.`,
          });
        }
        const w: ExoWrite = { kind: 'equipment', name: equipment as (typeof EXO_EQUIPMENT)[number], on };
        if (exoObserved(parseShadow(raw.shadow), w) === undefined) {
          throw new McpToolError(`System ${serial} does not report "${equipment}".`);
        }
        plan = exoPlan(serial, w, raw, meta, on ? 1 : 0, deps);
      }
      return execute(ctx, deps, serial, raw.kind, plan, { serial, equipment, on }, confirmToken);
    },
  );

  // ── aux circuits (incl. lights' on/off) ──────────────────────────────────
  server.registerTool(
    'iaqualink_set_aux',
    {
      description:
        'Turn an auxiliary circuit on or off — cleaner, waterfall, bubbler, landscape or pool/spa lights wired to an aux relay. Identify it by number ("3"), name ("aux_3") or label as shown by iaqualink_get_status. On iAqua, dimmable lights turn on at 100% and color lights at their first color, as the iAqualink app does. Sends nothing if already in that state, then re-reads to confirm. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Switch an aux circuit', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        aux: z.string().min(1).max(64).describe('Aux number, aux_<n> name, or label'),
        on: onArg,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, aux, on, confirmToken }, ctx) => {
      const raw = await read(serial, confirmToken);
      const meta = { tool: 'iaqualink_set_aux', action: 'iaqualink.aux.set' };
      let plan: Plan;
      if (raw.kind === 'iaqua') {
        const list = parseDevices(raw.devices).aux;
        const a = findAux(list, aux);
        if (!a) throw unknownAux(serial, aux, list.map((x) => `${x.aux} (${x.label})`));
        const { command, params } = auxOnOff(a, on);
        plan = {
          ...meta,
          summary: `Turn ${a.label} (aux ${a.aux}) ${on ? 'on' : 'off'} on ${serial}`,
          target: a.name,
          previous: a.on,
          requested: on,
          unchanged: a.on === on,
          request: iaquaRequest(serial, command, params),
          send: () => client.iaquaCommand(serial, command, params),
          observe: (r) => findAux(parseDevices((r as Iaqua).devices).aux, a.name)?.on,
        };
      } else {
        const list = parseShadow(raw.shadow).aux;
        const a = list.find((x) => x.name === `aux_${aux.replace(/^aux_?/i, '')}`);
        if (!a) throw unknownAux(serial, aux, list.map((x) => x.aux));
        plan = exoPlan(
          serial,
          { kind: 'aux', name: a.name, on },
          raw,
          { ...meta, summary: `Turn aux ${a.aux} ${on ? 'on' : 'off'} on ${serial}`, target: a.name },
          on ? 1 : 0,
          deps,
        );
      }
      return execute(ctx, deps, serial, raw.kind, plan, { serial, aux, on }, confirmToken);
    },
  );

  // ── light brightness / color ─────────────────────────────────────────────
  server.registerTool(
    'iaqualink_set_light',
    {
      description:
        'Set a pool/spa light’s brightness (dimmable lights: 0, 25, 50, 75 or 100 %) or color/show effect (color lights — Jandy, Pentair, Hayward; the effect names are listed by iaqualink_get_status with view "full"). iAqua systems only. The current color cannot be read back from iAqualink, so an effect change is confirmed only by the light being on. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Set light brightness or color', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        aux: z.string().min(1).max(64).describe('The light’s aux number, aux_<n> name, or label'),
        brightness: z.number().int().optional().describe('Dimmable lights: 0, 25, 50, 75 or 100'),
        effect: z.string().min(1).max(64).optional().describe('Color lights: an effect name (e.g. "Caribbean Blue") or its number'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, aux, brightness, effect, confirmToken }, ctx) => {
      if ((brightness === undefined) === (effect === undefined)) {
        throw new McpToolError('Give exactly one of brightness or effect.');
      }
      const raw = await read(serial, confirmToken);
      if (raw.kind !== 'iaqua') {
        throw new McpToolError('Light brightness/color is only available on iAqua systems.', {
          hint: 'eXO aux outputs can only be switched on/off with iaqualink_set_aux.',
        });
      }
      const list = parseDevices(raw.devices).aux;
      const a = findAux(list, aux);
      if (!a) throw unknownAux(serial, aux, list.map((x) => `${x.aux} (${x.label})`));
      const meta = { tool: 'iaqualink_set_light', action: 'iaqualink.light.set', target: a.name };
      let plan: Plan;
      if (brightness !== undefined) {
        if (a.kind !== 'dimmable_light') {
          throw new McpToolError(`${a.label} (aux ${a.aux}) is not a dimmable light (it is a ${a.kind.replace('_', ' ')}).`);
        }
        if (!(BRIGHTNESS_STEPS as readonly number[]).includes(brightness)) {
          throw new McpToolError(`${brightness}% isn't a valid brightness — only 0, 25, 50, 75 or 100.`);
        }
        const params = { aux: a.aux, light: String(brightness) };
        plan = {
          ...meta,
          summary: `Set ${a.label} (aux ${a.aux}) to ${brightness}% on ${serial}`,
          previous: a.brightness,
          requested: brightness,
          unchanged: a.brightness === brightness,
          request: iaquaRequest(serial, 'set_light', params),
          send: () => client.iaquaCommand(serial, 'set_light', params),
          observe: (r) => findAux(parseDevices((r as Iaqua).devices).aux, a.name)?.brightness,
        };
      } else {
        if (a.kind !== 'color_light' || !a.light) {
          throw new McpToolError(`${a.label} (aux ${a.aux}) is not a color light with a known effect table.`);
        }
        const effects = a.light.effects;
        const byName = Object.entries(effects).find(([n]) => n.toLowerCase() === effect!.trim().toLowerCase());
        const id = byName ? byName[1] : /^\d+$/.test(effect!.trim()) ? Number(effect) : undefined;
        if (id === undefined || !Object.values(effects).includes(id)) {
          throw new McpToolError(`"${effect}" isn't an effect of ${a.light.model}.`, { hint: `Effects: ${Object.keys(effects).join(', ')}.` });
        }
        const params = { aux: a.aux, light: String(id), subtype: a.subtype };
        const name = Object.keys(effects)[id];
        plan = {
          ...meta,
          summary: `Set ${a.label} (aux ${a.aux}) to "${name}" on ${serial}`,
          previous: { on: a.on },
          requested: { effect: name, on: id > 0 },
          // The current effect is not readable, so an effect change is always sent.
          unchanged: false,
          request: iaquaRequest(serial, 'set_light', params),
          send: () => client.iaquaCommand(serial, 'set_light', params),
          observe: (r) => ({ on: findAux(parseDevices((r as Iaqua).devices).aux, a.name)?.on }),
          settled: (v) => (v as { on?: boolean }).on === id > 0,
          note: 'iAqualink does not report which color a light is showing, so only its on/off state can be confirmed.',
        };
      }
      return execute(ctx, deps, serial, 'iaqua', plan, { serial, aux, brightness, effect }, confirmToken);
    },
  );

  // ── set points ───────────────────────────────────────────────────────────
  server.registerTool(
    'iaqualink_set_temperature',
    {
      description:
        'Set the pool and/or spa heater set point (target water temperature), in the system’s own unit (iAqua: °F 34–104 or °C 1–40; eXO: °C within its reported range, pool only). This changes the target only — turning a heater on or off is iaqualink_set_equipment. Re-reads to confirm. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Set pool/spa temperature', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        pool: z.number().int().optional().describe('Pool set point'),
        spa: z.number().int().optional().describe('Spa set point (iAqua only)'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, pool, spa, confirmToken }, ctx) => {
      if (pool === undefined && spa === undefined) throw new McpToolError('Give a pool and/or spa set point.');
      const raw = await read(serial, confirmToken);
      const meta = { tool: 'iaqualink_set_temperature', action: 'iaqualink.temperature.set', target: 'set_points' };
      let plan: Plan;
      if (raw.kind === 'iaqua') {
        const home = parseHome(raw.home);
        const { min, max } = tempRange(home.unit);
        for (const [k, t] of Object.entries({ pool, spa })) {
          if (t !== undefined && (t < min || t > max)) {
            throw new McpToolError(`${t}°${home.unit} isn't a valid ${k} temperature (${min}–${max}°${home.unit}).`);
          }
        }
        const params = setTempsParams(home.entries, { pool, spa });
        const pick = (e: Record<string, string>) => {
          const out: Record<string, number> = {};
          if (pool !== undefined) out.pool = Number(e.pool_set_point);
          if (spa !== undefined) out.spa = Number(e.spa_set_point);
          return out;
        };
        const requested = { ...(pool !== undefined ? { pool } : {}), ...(spa !== undefined ? { spa } : {}) };
        const previous = pick(home.entries);
        plan = {
          ...meta,
          summary: `Set ${Object.entries(requested).map(([k, t]) => `${k} to ${t}°${home.unit}`).join(' and ')} on ${serial}`,
          previous,
          requested,
          unchanged: same(previous, requested),
          request: iaquaRequest(serial, 'set_temps', params),
          send: () => client.iaquaCommand(serial, 'set_temps', params),
          observe: (r) => pick(parseHome((r as Iaqua).home).entries),
        };
      } else {
        if (spa !== undefined) throw new McpToolError('eXO systems have a single (pool) heating set point; omit spa.');
        const heating = parseShadow(raw.shadow).heating;
        if (!heating) throw new McpToolError(`System ${serial} reports no heating control.`);
        if (pool! < heating.sp_min || pool! > heating.sp_max) {
          throw new McpToolError(`${pool}°C isn't a valid temperature (${heating.sp_min}–${heating.sp_max}°C).`);
        }
        plan = exoPlan(
          serial,
          { kind: 'set_point', value: pool! },
          raw,
          { ...meta, summary: `Set the pool heating set point to ${pool}°C on ${serial}` },
          pool!,
          deps,
        );
      }
      return execute(ctx, deps, serial, raw.kind, plan, { serial, pool, spa }, confirmToken);
    },
  );

  // ── eXO chlorinator output ───────────────────────────────────────────────
  server.registerTool(
    'iaqualink_set_chlorinator',
    {
      description:
        'Set an eXO salt chlorinator’s output (chlorine production) percentage, 0–100. eXO systems only. Unlike the other controls this write is NOT in the iaqualink-py reference client — its shape is inferred from the reported `swc` field — so it is confirmed only if a re-read shows the new value. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Set chlorinator output', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        percent: z.number().int().min(0).max(100).describe('Chlorinator output, 0–100 %'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, percent, confirmToken }, ctx) => {
      const raw = await read(serial, confirmToken);
      if (raw.kind !== 'exo') throw new McpToolError('Chlorinator output is only settable on eXO systems.');
      const plan = exoPlan(
        serial,
        { kind: 'chlorinator', value: percent },
        raw,
        {
          tool: 'iaqualink_set_chlorinator',
          action: 'iaqualink.chlorinator.set',
          summary: `Set the chlorinator output to ${percent}% on ${serial}`,
          target: 'swc',
          note: 'This write shape is inferred, not taken from iaqualink-py; trust it only if the re-read confirms it.',
        },
        percent,
        deps,
      );
      return execute(ctx, deps, serial, 'exo', plan, { serial, percent }, confirmToken);
    },
  );
}

/** The command iaqualink-py sends to switch an aux on/off, by its kind. */
function auxOnOff(a: AuxDevice, on: boolean): { command: string; params: Record<string, string> } {
  if (a.kind === 'dimmable_light') return { command: 'set_light', params: { aux: a.aux, light: on ? '100' : '0' } };
  if (a.kind === 'color_light') return { command: 'set_light', params: { aux: a.aux, light: on ? '1' : '0', subtype: a.subtype } };
  return { command: `set_aux_${a.aux}`, params: {} };
}
