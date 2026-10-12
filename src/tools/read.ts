import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { minifiedResult, resolveView, toolAnnotations, viewParam, type View } from '@chrischall/mcp-utils';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import { SUPPORTED_TYPES, type RawStatus } from '../client.js';
import { normalizeIaqua } from '../iaqua.js';
import { normalizeExo } from '../exo.js';
import type { Deps } from './deps.js';

const VIEWS: readonly View[] = ['compact', 'full', 'raw'];

const viewArg = () =>
  viewParam(VIEWS, {
    note: 'compact = normalized status; full = plus aux/light details and the unprocessed entries; raw = iAqualink’s responses untouched.',
  });

export const serialArg = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'a system serial (letters, digits, - and _)')
  .describe('System serial number, from iaqualink_list_systems');

/** Normalize a raw status for a view. Exported for the write tools' previews. */
export function statusView(raw: RawStatus, view: View): Record<string, unknown> {
  return raw.kind === 'iaqua' ? normalizeIaqua(raw, view) : normalizeExo(raw, view);
}

export function registerReadTools(server: McpServer, deps: Deps): void {
  const { client } = deps;

  server.registerTool(
    'iaqualink_list_systems',
    {
      description:
        'List the pool/spa systems (iAqualink / Jandy iAquaLink panels and Zodiac eXO salt chlorinators) on the signed-in iAqualink account, with each serial number needed by the other tools. Other device types (e.g. robotic cleaners) are listed but marked unsupported.',
      annotations: toolAnnotations({ title: 'List iAqualink systems', readOnly: true, openWorld: true }),
      inputSchema: z.object({ view: viewArg() }),
    },
    async ({ view }) => {
      const rung = resolveView(view, VIEWS);
      const list = await client.listSystems();
      if (rung === 'raw') return minifiedResult(list);
      return minifiedResult(
        list.map((d) => {
          const base = {
            serial: d.serial_number,
            name: d.name ?? null,
            type: d.device_type,
            supported: (SUPPORTED_TYPES as readonly string[]).includes(d.device_type),
          };
          return rung === 'compact' ? base : { ...d, ...base };
        }),
      );
    },
  );

  server.registerTool(
    'iaqualink_get_status',
    {
      description:
        'Get the current pool/spa status of one iAqualink system: air, pool and spa temperatures, heater set points, pumps, heaters (pool/spa/solar), freeze protection, aux circuits and lights (with names), and — where the system reports them — salt chlorinator output, boost, salinity, pH and ORP. Readings are cached for a few seconds to stay polite to iAqualink.',
      annotations: toolAnnotations({ title: 'Get pool status', readOnly: true, openWorld: true }),
      inputSchema: z.object({ serial: serialArg, view: viewArg() }),
    },
    async ({ serial, view }) => {
      const rung = resolveView(view, VIEWS);
      const raw = await client.readRawStatus(serial);
      if (rung === 'raw') {
        return minifiedResult(raw.kind === 'iaqua' ? { home: raw.home, devices: raw.devices } : { shadow: raw.shadow });
      }
      return minifiedResult(statusView(raw, rung));
    },
  );

  registerCredentialHealthcheckTool({
    server,
    prefix: 'iaqualink',
    hostLabel: 'r-api.iaqualink.net',
    probePath: '/devices.json',
    resolveCredential: async () => client.describeCredential(),
    probeFn: () => client.listSystems(),
    hints: {
      no_credential:
        'No iAqualink sign-in configured. Set IAQUALINK_EMAIL and IAQUALINK_PASSWORD, or reconnect the connector and enter them.',
      credential_rejected:
        'iAqualink rejected the email/password. Fix it (or reconnect the connector); this server will not retry a rejected password, so the account cannot be locked by repeated attempts.',
    },
  });
}
