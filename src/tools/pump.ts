/**
 * Variable-speed pump speeds (iAqua / AquaLink RS) through WebTouch: Home →
 * Other Devices (24) → the pump's "ADJ" entry → screen 30, the panel's named
 * speeds (live 2026-10-12, src/rs-panel.ts).
 *
 * Two different writes, because the panel has two: pressing a named speed makes
 * it the running speed at once; the keypad stores an RPM for the running speed.
 * So changing a speed that is not running briefly runs it, and the tool switches
 * back to the speed that was running.
 *
 * Annotations: both writes can be undone with these same tools and reach no
 * other person, so neither is destructive.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CONFIRM_FLOW_SENTENCE, McpToolError, confirmTokenParam, confirmWrite, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { readPumpSpeeds, selectPumpSpeed, setPumpSpeedRpm, type PumpSpeed, type PumpSpeeds } from '../rs-panel.js';
import { withPanel, type WebTouchSession } from '../webtouch.js';
import { serialArg } from './read.js';
import type { Deps } from './deps.js';

/** The usual Jandy variable-speed range. */
export const RPM_MIN = 600;
export const RPM_MAX = 3450;

const speedArg = z.string().min(1).max(64).describe('A named speed as iaqualink_list_pump_speeds shows it, e.g. "Pool" or "Spa"');
const show = (s: PumpSpeed) => ({ speed: s.label, rpm: s.rpm, active: s.active });
const named = (s: PumpSpeed) => `${s.label} (${s.rpm} rpm)`;
const activeOf = (p: PumpSpeeds) => p.speeds.find((s) => s.active)?.label ?? null;
/** What a confirmation is bound to: the whole list, so any change at the panel voids the token. */
const revisionOf = (p: PumpSpeeds) => JSON.stringify(p.speeds.map(show));

export function registerPumpTools(server: McpServer, deps: Deps): void {
  const { client } = deps;
  const panel = <T>(serial: string, fn: (s: WebTouchSession) => Promise<T>) => withPanel(client, serial, deps.timing.webtouch, fn);

  async function speeds(serial: string): Promise<PumpSpeeds> {
    const raw = await client.readRawStatus(serial);
    if (raw.kind !== 'iaqua') throw new McpToolError('Pump speeds through the panel exist only on iAqua (Jandy AquaLink RS) systems.', { hint: 'For an eXO pump timer\'s rpm use iaqualink_set_schedule.' });
    return panel(serial, readPumpSpeeds);
  }

  function find(p: PumpSpeeds, serial: string, speed: string): PumpSpeed {
    const hit = p.speeds.find((s) => s.label.toLowerCase() === speed.trim().toLowerCase());
    if (!hit) {
      throw new McpToolError(`System ${serial} has no pump speed "${speed}".`, {
        hint: `Speeds: ${p.speeds.map((s) => `${s.label} (${s.rpm})`).join(', ')}.`,
      });
    }
    return hit;
  }

  server.registerTool(
    'iaqualink_list_pump_speeds',
    {
      description:
        'List a Jandy AquaLink RS panel’s variable-speed pump speeds — the named speeds (e.g. Pool, Spa, Cleaner) with each one’s RPM and which one the pump runs at — read through iAqualink WebTouch from the panel’s "VSP Adjust / Set Speed" screen. Use iaqualink_set_pump_speed to switch speeds and iaqualink_set_pump_speed_rpm to change a speed’s RPM.',
      annotations: toolAnnotations({ title: 'List pump speeds', readOnly: true, openWorld: true }),
      inputSchema: z.object({ serial: serialArg }),
    },
    async ({ serial }) => {
      const p = await speeds(serial);
      return minifiedResult({ serial, source: 'webtouch', pump: p.pump, active: activeOf(p), speeds: p.speeds.map(show) });
    },
  );

  server.registerTool(
    'iaqualink_set_pump_speed',
    {
      description:
        'Run a Jandy AquaLink RS panel’s variable-speed pump at one of its named speeds (from iaqualink_list_pump_speeds), through WebTouch — the panel makes a pressed speed the running speed at once. Nothing is pressed if that speed already runs; the speeds are re-read afterwards to confirm. Switch back the same way. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Switch the pump speed', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({ serial: serialArg, speed: speedArg, confirmToken: confirmTokenParam }),
    },
    async ({ serial, speed, confirmToken }, ctx) => {
      const before = await speeds(serial);
      const target = find(before, serial, speed);
      const current = before.speeds.find((s) => s.active);
      const base = { serial, speed: target.label, previous: current?.label ?? null };
      if (target.active) return minifiedResult({ status: 'unchanged', ...base, active: target.label, note: 'Already the running speed — nothing was pressed.' });
      const gate = await confirmWrite(ctx, {
        tool: 'iaqualink_set_pump_speed',
        action: 'iaqualink.pump_speed.select',
        summary: `Run the pump at "${target.label}" (${target.rpm} rpm) on ${serial}`,
        account: client.account,
        target: `${serial}:vsp`,
        revision: revisionOf(before),
        request: { method: 'POST', path: '/v2/webtouch/command', body: { screen: 30, command: 17 + target.index } },
        preview: { system: serial, current: current ? named(current) : null, requested: named(target) },
        args: { serial, speed },
        confirmToken,
      });
      if (gate) return gate;
      const after = await panel(serial, (s) => selectPumpSpeed(s, target.index, target.label));
      const active = activeOf(after);
      return minifiedResult({
        status: active === target.label ? 'confirmed' : 'sent-unconfirmed',
        ...base,
        active,
        speeds: after.speeds.map(show),
      });
    },
  );

  server.registerTool(
    'iaqualink_set_pump_speed_rpm',
    {
      description:
        `Change the RPM of one of a Jandy AquaLink RS panel’s named pump speeds (${RPM_MIN}–${RPM_MAX}), through WebTouch. The panel stores a typed RPM for the running speed, so a speed that is not running is run for a few seconds while it is set, and the speed that was running is switched back afterwards; the speeds are re-read to confirm. ` +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Set a pump speed’s RPM', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        speed: speedArg,
        rpm: z.number().int().min(RPM_MIN).max(RPM_MAX).describe(`New RPM, ${RPM_MIN}–${RPM_MAX}`),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, speed, rpm, confirmToken }, ctx) => {
      const before = await speeds(serial);
      const target = find(before, serial, speed);
      const running = before.speeds.find((s) => s.active);
      const base = { serial, speed: target.label, previous: target.rpm };
      if (target.rpm === rpm) return minifiedResult({ status: 'unchanged', ...base, rpm, note: 'Already at that RPM — nothing was pressed.' });
      const gate = await confirmWrite(ctx, {
        tool: 'iaqualink_set_pump_speed_rpm',
        action: 'iaqualink.pump_speed.rpm',
        summary: `Set the "${target.label}" pump speed to ${rpm} rpm (now ${target.rpm}) on ${serial}`,
        account: client.account,
        target: `${serial}:vsp:${target.index}`,
        revision: revisionOf(before),
        request: { method: 'POST', path: '/v2/webtouch/command', body: { screen: 30, command: 128, text: String(rpm) } },
        preview: {
          system: serial,
          speed: target.label,
          current: target.rpm,
          requested: rpm,
          running: running?.label ?? null,
          ...(running && !target.active
            ? { note: `The pump runs at "${target.label}" for a few seconds while it is set, then is switched back to "${running.label}".` }
            : {}),
        },
        args: { serial, speed, rpm },
        confirmToken,
      });
      if (gate) return gate;
      const after = await panel(serial, (s) => setPumpSpeedRpm(s, target.index, target.label, rpm));
      const now = after.speeds.find((s) => s.index === target.index)!;
      const ok = now.rpm === rpm && activeOf(after) === (running?.label ?? activeOf(after));
      return minifiedResult({ status: ok ? 'confirmed' : 'sent-unconfirmed', ...base, rpm: now.rpm, active: activeOf(after), speeds: after.speeds.map(show) });
    },
  );
}
