/**
 * System labels: the `serial` argument as the person's own system names.
 *
 * At start the server lists the account's systems once (`loadSystemLabels`);
 * when that succeeds every `serial` argument publishes the SUPPORTED systems'
 * names as a JSON Schema `enum`, so a host that groups tools by subject (the
 * mcp-host context groups) can fan a question out over "Pool" and "Spa"
 * without enumerating anything itself. A listing that fails — no credential
 * yet, a rejected password, iAqualink down, or past the deadline — publishes
 * the property with no `enum` (never an empty one, which is invalid JSON
 * Schema).
 *
 * The enum holds the NAMES only, each system once. The serials are not added
 * to it: a host that fans a question out over the enum's values would then
 * read every system twice, once by name and once by serial. So the schema
 * contract is the names, and that is what the description says. The server
 * stays lenient underneath: every handler resolves what it was given through
 * `resolveSerial` — the label-or-id precedent of `iaqualink_set_aux` — so a
 * caller that does not validate against the schema may still send the serial.
 */
import { z } from 'zod';
import { McpToolError } from '@chrischall/mcp-utils';
import { SUPPORTED_TYPES, type IaqualinkClient } from '../client.js';
import type { Deps } from './deps.js';

export interface SystemLabel {
  /** What the person calls it: the system's name, or its serial when it has none. */
  label: string;
  serial: string;
}

/** How long the start-up listing may hold the boot before the server serves without labels. */
export const SYSTEM_LABELS_DEADLINE_MS = 5_000;

const SERIAL_SHAPE = /^[A-Za-z0-9_-]+$/;
const DESCRIPTION = 'System serial number, from iaqualink_list_systems';

const normal = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The supported systems' labels, or undefined when they cannot be listed (or
 * there are none). A name two systems share is disambiguated with the serial,
 * so every label names exactly one system.
 */
export async function loadSystemLabels(
  client: Pick<IaqualinkClient, 'listSystems'>,
  deadlineMs = SYSTEM_LABELS_DEADLINE_MS,
): Promise<SystemLabel[] | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const list = await Promise.race([
      client.listSystems(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('listing timed out')), deadlineMs);
      }),
    ]);
    const supported = list.filter((d) => (SUPPORTED_TYPES as readonly string[]).includes(d.device_type));
    if (supported.length === 0) return undefined;
    const named = supported.map((d) => ({ name: d.name?.trim() || d.serial_number, serial: d.serial_number }));
    const count = new Map<string, number>();
    for (const n of named) count.set(normal(n.name), (count.get(normal(n.name)) ?? 0) + 1);
    return named.map((n) => ({ label: count.get(normal(n.name))! > 1 ? `${n.name} (${n.serial})` : n.name, serial: n.serial }));
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The `serial` argument: an enum of labels when they were listed, else the plain serial shape. */
export function serialArgFor(systems: readonly SystemLabel[] | undefined) {
  if (!systems) {
    return z.string().min(1).max(64).regex(SERIAL_SHAPE, 'a system serial (letters, digits, - and _)').describe(DESCRIPTION);
  }
  // `.meta({ enum })` publishes the labels without making zod refuse a serial.
  return z
    .string()
    .min(1)
    .max(64)
    .describe(
      'The system, by name as listed here. The server also resolves a serial from iaqualink_list_systems, ' +
        'but this schema offers the names only.',
    )
    .meta({ enum: systems.map((s) => s.label) });
}

/**
 * Map a label or a serial to the serial. With no labels listed at start the
 * value is taken as a serial. An unknown value is checked against a fresh
 * listing (a system added since start, or one the labels disambiguated) and
 * otherwise refused, naming the systems this server knows.
 */
export async function resolveSerial(deps: Pick<Deps, 'client' | 'systems'>, ref: string): Promise<string> {
  const { systems } = deps;
  if (!systems) return ref;
  const want = normal(ref);
  const hit = systems.find((s) => s.serial === ref.trim() || normal(s.label) === want);
  if (hit) return hit.serial;
  const now = await deps.client.listSystems();
  if (now.some((d) => d.serial_number === ref.trim())) return ref.trim();
  const known = systems.map((s) => `${s.label} (${s.serial})`).join(', ');
  throw new McpToolError(`No iAqualink system named "${ref}". Known systems: ${known}.`, {
    hint: 'Use one of those names or serials (iaqualink_list_systems lists them).',
  });
}

/** Wrap a handler so its `serial` argument is resolved (label or serial → serial) before it runs. */
export function withSystem<A extends { serial: string }, C, R>(
  deps: Pick<Deps, 'client' | 'systems'>,
  handler: (args: A, ctx: C) => R | Promise<R>,
): (args: A, ctx: C) => Promise<R> {
  return async (args, ctx) => handler({ ...args, serial: await resolveSerial(deps, args.serial) }, ctx);
}
