/**
 * AquaLink RS panel schedules, through WebTouch (src/rs-panel.ts).
 *
 * Each write follows the same shape:
 *  1. read the panel's schedule list (its own WebTouch session);
 *  2. plan the change against it and gate on confirmation — the preview shows
 *     the list before and after, and the token is bound to the list read;
 *  3. in a new session: re-read, refuse if the list changed, press exactly the
 *     captured sequence (every press preceded by a screen/row check), return
 *     Home, and re-read the list from a fresh Menu → Schedule entry as
 *     `verified`.
 *
 * Annotations: deleting a program has no undo here (re-adding makes a new
 * row), so delete is destructive; add and edit are reversible with this same
 * tool set.
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CONFIRM_FLOW_SENTENCE, McpToolError, confirmTokenParam, confirmWrite, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import {
  PANEL_DAYS,
  addSchedule,
  deleteSchedule,
  editSchedule,
  readSchedules,
  sameList,
  to12,
  type PanelSchedule,
  type Target,
} from '../rs-panel.js';
import { HHMM_PATTERN } from '../schedules.js';
import { withPanel, type WebTouchSession } from '../webtouch.js';
import { serialArg } from './read.js';
import type { Deps } from './deps.js';

const hhmm = z.string().regex(HHMM_PATTERN, '24-hour HH:MM');
const daysArg = z.enum(PANEL_DAYS).describe('Run days as the panel names them: All, M, Tu, W, Th, F, Sa, Su, Wkdays or Wkends');

type Planned = Pick<PanelSchedule, 'circuit' | 'days'> & { display: { start: string; stop: string } };

/** What a tool result shows of a schedule. */
export function showSchedule(s: PanelSchedule) {
  return { page: s.page, row: s.row, circuit: s.circuit, start: s.start, stop: s.stop, days: s.days, display: s.display };
}

const showPlanned = (l: Planned[]) => l.map((s) => ({ circuit: s.circuit, start: s.display.start, stop: s.display.stop, days: s.days }));

function plannedOf(circuit: string, start: string, stop: string, days: string): Planned {
  return { circuit, days, display: { start: to12(start).display, stop: to12(stop).display } };
}

const UNVERIFIED_NOTE =
  'WebTouch writes follow the live capture of 2026-10-11 on an RS panel; trust the result only when status is "confirmed" (the re-read list matches).';

export function registerPanelTools(server: McpServer, deps: Deps): void {
  const { client } = deps;
  const panel = <T>(serial: string, fn: (s: WebTouchSession) => Promise<T>) => withPanel(client, serial, deps.timing.webtouch, fn);

  async function readIaquaList(serial: string): Promise<PanelSchedule[]> {
    const raw = await client.readRawStatus(serial);
    if (raw.kind !== 'iaqua') {
      throw new McpToolError('Panel schedules exist only on iAqua (Jandy AquaLink RS) systems.', {
        hint: 'For an eXO timer use iaqualink_set_schedule.',
      });
    }
    return panel(serial, readSchedules);
  }

  function findTarget(before: PanelSchedule[], t: { page: number; row: number; circuit: string; start: string; stop: string; days: string }): PanelSchedule {
    const hit = before.find(
      (s) =>
        s.page === t.page &&
        s.row === t.row &&
        s.circuit.toLowerCase() === t.circuit.trim().toLowerCase() &&
        s.start === t.start &&
        s.stop === t.stop &&
        s.days === t.days,
    );
    if (!hit) {
      throw new McpToolError(`No schedule "${t.circuit} ${t.start}–${t.stop} ${t.days}" at page ${t.page} row ${t.row} on the panel.`, {
        hint: `The panel shows: ${before.map((s) => `p${s.page} r${s.row} ${s.circuit} ${s.start}–${s.stop} ${s.days}`).join('; ') || 'no schedules'}. Re-read with iaqualink_list_schedules.`,
      });
    }
    return hit;
  }

  async function gateAndRun(
    ctx: ServerContext,
    serial: string,
    p: {
      tool: string;
      action: string;
      summary: string;
      target: string;
      args: Record<string, unknown>;
      confirmToken: string | undefined;
      before: PanelSchedule[];
      after: Planned[];
      run: (s: WebTouchSession) => Promise<PanelSchedule[]>;
    },
  ) {
    const gate = await confirmWrite(ctx, {
      tool: p.tool,
      action: p.action,
      summary: p.summary,
      account: client.account,
      target: `${serial}:${p.target}`,
      revision: JSON.stringify(showPlanned(p.before)),
      request: { method: 'POST', path: '/v2/webtouch/command', body: { panel: 'RS via WebTouch', change: p.summary } },
      preview: { system: serial, before: p.before.map(showSchedule), after: showPlanned(p.after), note: UNVERIFIED_NOTE },
      args: p.args,
      confirmToken: p.confirmToken,
    });
    if (gate) return gate;
    const verified = await panel(serial, p.run);
    const ok = sameList(verified, p.after);
    return minifiedResult({
      status: ok ? 'confirmed' : 'sent-unconfirmed',
      serial,
      before: p.before.map(showSchedule),
      expected: showPlanned(p.after),
      verified: verified.map(showSchedule),
      ...(ok ? {} : { note: 'The panel accepted the presses, but the re-read list does not match what was expected. Check iaqualink_list_schedules before retrying.' }),
    });
  }

  const identity = {
    page: z.number().int().min(1).max(10).default(1).describe('The page the schedule was listed on (from iaqualink_list_schedules)'),
    row: z.number().int().min(1).max(7).describe('Its row on that page (1–7)'),
    circuit: z.string().min(1).max(64).describe('Its circuit, as listed'),
    start: hhmm.describe('Its current start time, HH:MM as listed'),
    stop: hhmm.describe('Its current stop time, HH:MM as listed'),
    days: daysArg.describe('Its current run days, as listed'),
  };

  server.registerTool(
    'iaqualink_add_schedule',
    {
      description:
        'Add a program to a Jandy AquaLink RS panel’s own schedule (iAqua systems), through iAqualink WebTouch — the panel emulation the iAqualink web app uses. Picks the circuit by its panel label (e.g. "Filter Pump", "Pool Light", "Cleaner"), sets start and stop (24-hour HH:MM; stop may be earlier than start to run overnight) and run days, saves, and re-reads the list to confirm. The preview shows the schedule list before and after. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Add an RS panel schedule', readOnly: false, destructive: false, idempotent: false, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        circuit: z.string().min(1).max(64).describe('Circuit label as the panel names it'),
        start: hhmm.describe('Start time, 24-hour HH:MM'),
        stop: hhmm.describe('Stop time, 24-hour HH:MM'),
        days: daysArg,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, circuit, start, stop, days, confirmToken }, ctx) => {
      if (start === stop) throw new McpToolError('Start and stop are the same time; give a program that runs.');
      const before = await readIaquaList(serial);
      const add = plannedOf(circuit.trim(), start, stop, days);
      if (before.some((s) => sameList([s], [add]))) {
        return minifiedResult({ status: 'unchanged', serial, note: 'The panel already has exactly this program — nothing was pressed.', schedules: before.map(showSchedule) });
      }
      return gateAndRun(ctx, serial, {
        tool: 'iaqualink_add_schedule',
        action: 'iaqualink.panel_schedule.add',
        summary: `Add "${circuit.trim()}" ${add.display.start}–${add.display.stop} ${days} to ${serial}’s panel schedule`,
        target: 'schedule',
        args: { serial, circuit, start, stop, days },
        confirmToken,
        before,
        after: [...before, add],
        run: (s) => addSchedule(s, { circuit: circuit.trim(), start, stop, days }, before),
      });
    },
  );

  server.registerTool(
    'iaqualink_edit_schedule',
    {
      description:
        'Change the start time, stop time and/or run days of one existing program in a Jandy AquaLink RS panel’s schedule (iAqua systems), through WebTouch. Identify the program exactly as iaqualink_list_schedules listed it (page, row, circuit, start, stop, days) — if the panel no longer shows that, nothing is pressed. The circuit itself cannot be changed (delete and add instead). The preview shows the list before and after; the result re-reads it. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Edit an RS panel schedule', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        ...identity,
        newStart: hhmm.optional().describe('New start time, 24-hour HH:MM'),
        newStop: hhmm.optional().describe('New stop time, 24-hour HH:MM'),
        newDays: daysArg.optional().describe('New run days'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, page, row, circuit, start, stop, days, newStart, newStop, newDays, confirmToken }, ctx) => {
      if (newStart === undefined && newStop === undefined && newDays === undefined) {
        throw new McpToolError('Give at least one of newStart, newStop or newDays.');
      }
      const before = await readIaquaList(serial);
      const hit = findTarget(before, { page, row, circuit, start, stop, days });
      const next = plannedOf(hit.circuit, newStart ?? start, newStop ?? stop, newDays ?? days);
      if (next.display.start === next.display.stop) throw new McpToolError('Start and stop would be the same time; give a program that runs.');
      if (sameList([next], [hit])) {
        return minifiedResult({ status: 'unchanged', serial, note: 'The program already has these times and days — nothing was pressed.', schedule: showSchedule(hit) });
      }
      const target: Target = { page, row };
      return gateAndRun(ctx, serial, {
        tool: 'iaqualink_edit_schedule',
        action: 'iaqualink.panel_schedule.edit',
        summary: `Change "${hit.circuit}" ${hit.display.start}–${hit.display.stop} ${hit.days} to ${next.display.start}–${next.display.stop} ${next.days} on ${serial}’s panel`,
        target: `p${page}r${row}`,
        args: { serial, page, row, circuit, start, stop, days, newStart, newStop, newDays },
        confirmToken,
        before,
        after: before.map((s) => (s === hit ? { ...s, ...next } : s)),
        run: (s) =>
          editSchedule(
            s,
            target,
            {
              ...(newStart !== undefined && newStart !== start ? { start: newStart } : {}),
              ...(newStop !== undefined && newStop !== stop ? { stop: newStop } : {}),
              ...(newDays !== undefined && newDays !== days ? { days: newDays } : {}),
            },
            before,
          ),
      });
    },
  );

  server.registerTool(
    'iaqualink_delete_schedule',
    {
      description:
        'Delete one program from a Jandy AquaLink RS panel’s schedule (iAqua systems), through WebTouch. The panel stores the deletion immediately, with no undo. Identify the program exactly as iaqualink_list_schedules listed it (page, row, circuit, start, stop, days) — if the panel no longer shows that, nothing is pressed. The preview shows the list before and after; the result re-reads it. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Delete an RS panel schedule', readOnly: false, destructive: true, idempotent: false, openWorld: true }),
      inputSchema: z.object({ serial: serialArg, ...identity, confirmToken: confirmTokenParam }),
    },
    async ({ serial, page, row, circuit, start, stop, days, confirmToken }, ctx) => {
      const before = await readIaquaList(serial);
      const hit = findTarget(before, { page, row, circuit, start, stop, days });
      return gateAndRun(ctx, serial, {
        tool: 'iaqualink_delete_schedule',
        action: 'iaqualink.panel_schedule.delete',
        summary: `Delete "${hit.circuit}" ${hit.display.start}–${hit.display.stop} ${hit.days} from ${serial}’s panel schedule`,
        target: `p${page}r${row}`,
        args: { serial, page, row, circuit, start, stop, days },
        confirmToken,
        before,
        after: before.filter((s) => s !== hit),
        run: (s) => deleteSchedule(s, { page, row }, before),
      });
    },
  );
}
