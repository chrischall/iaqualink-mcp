import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './support/harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
  tools: Array<{ name: string; description: string }>;
};

async function served() {
  const { h } = await setup();
  const { tools } = await h.client.listTools();
  await h.close();
  return tools;
}

const EXPECTED = [
  'iaqualink_get_status',
  'iaqualink_healthcheck',
  'iaqualink_list_onetouch',
  'iaqualink_list_schedules',
  'iaqualink_list_systems',
  'iaqualink_set_aux',
  'iaqualink_set_chlorinator',
  'iaqualink_set_equipment',
  'iaqualink_set_light',
  'iaqualink_set_onetouch',
  'iaqualink_set_schedule',
  'iaqualink_set_temperature',
];

describe('tool roster', () => {
  it('registers exactly the expected tools', async () => {
    expect((await served()).map((t) => t.name).sort()).toEqual(EXPECTED);
  });

  it('manifest.json lists the same tools, in both directions, each with a description', async () => {
    const names = (await served()).map((t) => t.name).sort();
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(names);
    for (const t of manifest.tools) expect(t.description.trim().length).toBeGreaterThan(10);
  });

  it('every write takes a confirmToken and says how the confirmation works', async () => {
    for (const t of await served()) {
      if (t.annotations?.readOnlyHint !== false) continue;
      expect(Object.keys((t.inputSchema as { properties: object }).properties)).toContain('confirmToken');
      expect(t.description).toMatch(/confirmToken/);
    }
  });
});

describe('tool annotations', () => {
  it('sets an explicit boolean readOnlyHint and openWorldHint on every tool', async () => {
    for (const t of await served()) {
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe('boolean');
      expect(t.annotations?.openWorldHint, t.name).toBe(true);
    }
  });

  it('sets an explicit boolean destructiveHint on every write (silence would publish as destructive)', async () => {
    const undeclared = (await served())
      .filter((t) => t.annotations?.readOnlyHint === false && typeof t.annotations?.destructiveHint !== 'boolean')
      .map((t) => t.name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', async () => {
    const bad = (await served()).filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true);
    expect(bad).toEqual([]);
  });

  it('holds the read and destructive sets at their decided sizes', async () => {
    const tools = await served();
    expect(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort()).toEqual([
      'iaqualink_get_status',
      'iaqualink_healthcheck',
      'iaqualink_list_onetouch',
      'iaqualink_list_schedules',
      'iaqualink_list_systems',
    ]);
    // Every control has an inverse in this tool set and reaches no other person.
    expect(tools.filter((t) => t.annotations?.destructiveHint === true)).toEqual([]);
  });
});
