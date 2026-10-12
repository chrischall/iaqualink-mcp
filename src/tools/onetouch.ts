/**
 * OneTouch scenes (iAqua only) — panel-defined macros such as "Spa Mode" or
 * "All OFF". Read with `get_onetouch`, switched with `set_onetouch_<n>`, which
 * is a TOGGLE like the other iAqua commands (iaqualink-py master
 * flz/iaqualink-py@eb1cf63 systems/iaqua/system.py:150-151,465-513 and
 * device.py:141-145). iaqualink-py's own protocol notes
 * (docs/reference/systems/iaqua.md:1293) say the `set_onetouch` command
 * string was not found in its protocol analysis, so the write is unverified.
 *
 * Annotations: set_onetouch has an inverse (toggle it back) and reaches no
 * other person, so it is not destructive.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CONFIRM_FLOW_SENTENCE, McpToolError, confirmTokenParam, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { findOneTouch, parseOneTouch } from '../iaqua.js';
import { execute, iaquaRequest, type Plan } from './control.js';
import { serialArg } from './read.js';
import type { Deps } from './deps.js';

export function registerOneTouchTools(server: McpServer, deps: Deps): void {
  const { client } = deps;

  /** The system must be iAqua; returns get_home's top-level `onetouch` flag. */
  async function requireIaqua(serial: string): Promise<unknown> {
    const raw = await client.readRawStatus(serial);
    if (raw.kind !== 'iaqua') throw new McpToolError('OneTouch scenes exist only on iAqua (Jandy iAquaLink) systems.');
    return (raw.home as { onetouch?: unknown } | null)?.onetouch;
  }

  server.registerTool(
    'iaqualink_list_onetouch',
    {
      description:
        'List an iAqua (Jandy iAquaLink) panel’s OneTouch scenes — the panel-defined one-button macros such as "Spa Mode", "All OFF" or "Clean Mode" — with each scene’s number, label, whether it is configured, and whether it is currently on. Use iaqualink_set_onetouch to run or stop one.',
      annotations: toolAnnotations({ title: 'List OneTouch scenes', readOnly: true, openWorld: true }),
      inputSchema: z.object({ serial: serialArg }),
    },
    async ({ serial }) => {
      const flag = await requireIaqua(serial);
      if (flag === 'false') {
        return minifiedResult({ serial, supported: false, reason: 'The panel reports OneTouch as not enabled (get_home onetouch: "false").' });
      }
      const p = parseOneTouch(await client.iaquaCommand(serial, 'get_onetouch'));
      return minifiedResult({
        serial,
        supported: true,
        online: p.online,
        ...(p.online ? {} : { note: `The OneTouch screen reports status "${p.status}"; scenes cannot be read right now.` }),
        scenes: p.scenes.map(({ onetouch, label, enabled, on }) => ({ onetouch, label, enabled, on })),
      });
    },
  );

  server.registerTool(
    'iaqualink_set_onetouch',
    {
      description:
        'Turn an iAqua OneTouch scene on or off (by number, onetouch_<n>, or its label from iaqualink_list_onetouch). The command is a toggle, so this reads the scene first and sends nothing if it is already in the requested state, then re-reads to confirm. A scene switches several pieces of equipment at once, as configured on the panel. Unverified on live hardware. ' +
        CONFIRM_FLOW_SENTENCE,
      annotations: toolAnnotations({ title: 'Switch a OneTouch scene', readOnly: false, destructive: false, idempotent: true, openWorld: true }),
      inputSchema: z.object({
        serial: serialArg,
        onetouch: z.string().min(1).max(64).describe('Scene number, onetouch_<n>, or label'),
        on: z.boolean().describe('true = run the scene, false = stop it'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ serial, onetouch, on, confirmToken }, ctx) => {
      await requireIaqua(serial);
      const read = async () => parseOneTouch(await client.iaquaCommand(serial, 'get_onetouch'));
      const p = await read();
      if (!p.online) throw new McpToolError(`The OneTouch screen reports status "${p.status}"; nothing can be switched right now.`);
      const scene = findOneTouch(p.scenes, onetouch);
      if (!scene || !scene.enabled) {
        const usable = p.scenes.filter((s) => s.enabled).map((s) => `${s.onetouch} (${s.label})`);
        throw new McpToolError(`System ${serial} has no configured OneTouch scene "${onetouch}".`, { hint: `Scenes: ${usable.join(', ') || 'none'}.` });
      }
      const command = `set_onetouch_${scene.onetouch}`;
      const plan: Plan = {
        tool: 'iaqualink_set_onetouch',
        action: 'iaqualink.onetouch.set',
        summary: `Turn the "${scene.label}" OneTouch scene ${on ? 'on' : 'off'} on ${serial}`,
        target: scene.name,
        previous: scene.on,
        requested: on,
        unchanged: scene.on === on,
        request: iaquaRequest(serial, command),
        send: () => client.iaquaCommand(serial, command),
        reread: async () => findOneTouch((await read()).scenes, scene.name)?.on,
      };
      return execute(ctx, deps, serial, 'iaqua', plan, { serial, onetouch, on }, confirmToken);
    },
  );
}
