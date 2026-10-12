/**
 * iaqualink_check_panel — is the system reachable, and what is its RS panel
 * showing? The one call to make when the app, WebTouch and these tools
 * disagree (2026-10-12: a panel left in schedule Edit mode read as "offline").
 *
 * Reads the cloud's online flag first and opens no panel session for a system
 * iAqualink reports Offline. Otherwise it opens a WebTouch session — sending
 * only the start-up press the website sends on load — and reports the screen,
 * any dialog and the Edit state. Nothing else is pressed.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { McpToolError, errorKindOf, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import { parseDevices, parseHome } from '../iaqua.js';
import { describePanel, type PanelCheck } from '../rs-panel.js';
import { withPanel } from '../webtouch.js';
import { serialArg } from './read.js';
import type { Deps } from './deps.js';

function hintFor(p: PanelCheck): string {
  switch (p.state) {
    case 'ready':
      return `The panel is responsive (showing ${p.screenName}). The schedule and OneTouch tools can run.`;
    case 'edit_unsaved':
      return 'The panel is in schedule Edit mode with unsaved changes — someone is editing at the panel, or a change was interrupted. Save or discard them at the panel or in WebTouch (iaqualink.net → the system), then check again; the schedule and OneTouch tools will not press anything until then. A new session re-raises "Program changes must be saved…": that is the panel\'s answer to Edit mode, not a fault.';
    case 'dialog':
      return `A dialog is open on the panel ("${p.dialog!.message}"). Close it at the panel or in WebTouch before using the schedule or OneTouch tools.`;
  }
}

export function registerPanelCheckTool(server: McpServer, deps: Deps): void {
  const { client } = deps;
  server.registerTool(
    'iaqualink_check_panel',
    {
      description:
        'Check whether an iAqua (Jandy AquaLink RS) system is reachable and what its panel is showing: the cloud online flag, then — over WebTouch — the current screen, any open dialog, and whether the schedule screen is in Edit mode with unsaved changes. Use it when the app, WebTouch and the other tools disagree, or a schedule/OneTouch tool reports a dialog or a timeout. Sends only the start-up press the WebTouch page sends when it loads (in Edit mode the panel answers it with its "must be saved" dialog); presses nothing else and changes no setting.',
      annotations: toolAnnotations({ title: 'Check the panel', readOnly: true, openWorld: true }),
      inputSchema: z.object({ serial: serialArg }),
    },
    async ({ serial }) => {
      const raw = await client.readRawStatus(serial, { fresh: true });
      if (raw.kind !== 'iaqua') throw new McpToolError('The panel check exists only on iAqua (Jandy AquaLink RS) systems.');
      if (!(parseHome(raw.home).online && parseDevices(raw.devices).online)) {
        return minifiedResult({
          serial,
          online: false,
          panel: null,
          hint: 'iAqualink reports this system Offline — the panel is not connected to the cloud, so no panel session was opened. Check the panel\'s iAqualink device and its network connection.',
        });
      }
      try {
        const panel = await withPanel(client, serial, deps.timing.webtouch, async (s) => describePanel(s.state));
        return minifiedResult({ serial, online: true, panel, hint: hintFor(panel) });
      } catch (err) {
        if (errorKindOf(err) !== 'timeout') throw err;
        return minifiedResult({
          serial,
          online: true,
          panel: { state: 'no_answer', screen: null, screenName: null, dialog: null, editMode: null },
          hint: `iAqualink reports the system online, but the panel did not answer over WebTouch within ${deps.timing.webtouch.stepTimeoutMs / 1000} s. Usually transient — try again; if it persists, open WebTouch on iaqualink.net to look at the panel.`,
        });
      }
    },
  );
}
