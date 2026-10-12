/**
 * OneTouch scenes (iAqua / AquaLink RS) — panel-defined macros such as
 * "Spa Mode" or "All OFF" — through WebTouch: OneTouch (3) → screen 77, six
 * scene buttons (code 24 `idx||on||img||label||ON|OFF`), a scene toggles with
 * command 17 + idx (live capture 2026-10-11; the toggle itself was not pressed
 * in the capture).
 *
 * The session.json route (`get_onetouch` / `set_onetouch_<n>`, iaqualink-py
 * master) was removed: iaqualink-py's own notes say `set_onetouch` was never
 * seen in protocol analysis, and one path is easier to trust than two.
 *
 * Annotations: a scene can be switched back with this same tool and reaches no
 * other person, so it is not destructive.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CONFIRM_FLOW_SENTENCE, McpToolError, confirmTokenParam, confirmWrite, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { readOneTouch, setOneTouch, type PanelScene } from '../rs-panel.js';
import { withPanel, type WebTouchSession } from '../webtouch.js';
import { serialArg } from './read.js';
import type { Deps } from './deps.js';

/** Scenes as shown to callers: `onetouch` is 1-based, as the panel labels "OneTouch 4" etc. */
const show = (s: PanelScene) => ({ onetouch: s.index + 1, label: s.label, on: s.on });

function find(scenes: PanelScene[], ref: string): PanelScene | undefined {
  const r = ref.trim().toLowerCase().replace(/^onetouch_?/, '');
  return scenes.find((s) => String(s.index + 1) === r || s.label.toLowerCase() === ref.trim().toLowerCase());
}

export function registerOneTouchTools(server: McpServer, deps: Deps): void {
  const { client } = deps;
  const panel = <T>(serial: string, fn: (s: WebTouchSession) => Promise<T>) => withPanel(client, serial, deps.timing.webtouch, fn);

  async function scenes(serial: string): Promise<PanelScene[]> {
    const raw = await client.readRawStatus(serial);
    if (raw.kind !== 'iaqua') throw new McpToolError('OneTouch scenes exist only on iAqua (Jandy AquaLink) systems.');
    return panel(serial, readOneTouch);
  }

  server.registerTool(
    'iaqualink_list_onetouch',
    {
      description:
        'List a Jandy AquaLink RS panel’s OneTouch scenes — the panel-defined one-button macros such as "Spa Mode", "All OFF" or "Clean Mode" — with each scene’s number, label and whether it is on, read through iAqualink WebTouch (the panel emulation). Use iaqualink_set_onetouch to run or stop one.',
      annotations: toolAnnotations({ title: 'List OneTouch scenes', readOnly: true, openWorld: true }),
      inputSchema: z.object({ serial: serialArg }),
    },
    async ({ serial }) => minifiedResult({ serial, source: 'webtouch', scenes: (await scenes(serial)).map(show) }),
  );

  server.registerTool(
    'iaqualink_set_onetouch',
    {
      description:
        'Turn a Jandy AquaLink RS panel’s OneTouch scene on or off (by number 1–6, onetouch_<n>, or its label from iaqualink_list_onetouch), through WebTouch. The panel button is a toggle, so it is pressed only when the scene is not already in the requested state; the scenes are re-read afterwards to confirm. A scene switches several pieces of equipment at once, as configured on the panel. The toggle press was not exercised in the live capture. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Switch a OneTouch scene', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        onetouch: z.string().min(1).max(64).describe('Scene number (1–6), onetouch_<n>, or label'),
        on: z.boolean().describe('true = run the scene, false = stop it'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, onetouch, on, confirmToken }, ctx) => {
      const before = await scenes(serial);
      const scene = find(before, onetouch);
      if (!scene) {
        throw new McpToolError(`System ${serial} has no OneTouch scene "${onetouch}".`, {
          hint: `Scenes: ${before.map((s) => `${s.index + 1} (${s.label})`).join(', ') || 'none'}.`,
        });
      }
      const base = { serial, target: scene.label, requested: on, previous: scene.on };
      if (scene.on === on) return minifiedResult({ status: 'unchanged', ...base, note: 'Already in the requested state — nothing was pressed.' });
      const gate = await confirmWrite(ctx, {
        tool: 'iaqualink_set_onetouch',
        action: 'iaqualink.onetouch.set',
        summary: `Turn the "${scene.label}" OneTouch scene ${on ? 'on' : 'off'} on ${serial}`,
        account: client.account,
        target: `${serial}:onetouch_${scene.index + 1}`,
        revision: JSON.stringify(scene.on),
        request: { method: 'POST', path: '/v2/webtouch/command', body: { screen: 77, command: 17 + scene.index } },
        preview: { system: serial, current: scene.on, requested: on },
        args: { serial, onetouch, on },
        confirmToken,
      });
      if (gate) return gate;
      const after = await panel(serial, (s) => setOneTouch(s, scene.index, on));
      // setOneTouch only returns once the panel shows the scene in the requested state (it throws otherwise).
      return minifiedResult({ status: 'confirmed', ...base, observed: after.find((s) => s.index === scene.index)!.on, scenes: after.map(show) });
    },
  );
}
