import { describe, it, expect } from 'vitest';
import { setup } from './support/harness.js';

type Listed = { name: string; inputSchema: { properties: Record<string, any> }; _meta?: { mint?: Record<string, any> } };

async function served(opts: Parameters<typeof setup>[0] = {}): Promise<Listed[]> {
  const { h } = await setup(opts);
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const SWITCH_ALIASES = ['hot tub', 'spa', 'pool', 'heater', 'jets', 'lights'];

describe('_meta.mint hints', () => {
  it('every tool this server registers itself carries a hint in the contract’s shape', async () => {
    for (const t of await served()) {
      if (t.name === 'iaqualink_healthcheck') continue; // registered by mcp-utils, which takes no _meta
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(Object.keys(m!).every((k) => ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'].includes(k)), t.name).toBe(true);
      expect(DOMAINS).toContain(m!.domain);
      expect(m!.domain, t.name).toBe('home');
      expect(INTENTS).toContain(m!.intent);
      if (m!.aliases) {
        expect(m!.aliases.length).toBeLessThanOrEqual(8);
        for (const a of m!.aliases) {
          expect(a.length).toBeLessThanOrEqual(40);
          expect(a).toBe(a.toLowerCase());
        }
      }
      if (m!.subject) expect(t.inputSchema.properties, t.name).toHaveProperty(m!.subject);
    }
  });

  it('marks the reads as lookups', async () => {
    const tools = await served();
    const reads = ['iaqualink_list_systems', 'iaqualink_get_status', 'iaqualink_list_schedules', 'iaqualink_list_onetouch', 'iaqualink_list_pump_speeds', 'iaqualink_check_panel'];
    for (const name of reads) expect(tools.find((t) => t.name === name)?._meta?.mint?.intent, name).toBe('lookup');
    expect(tools.find((t) => t.name === 'iaqualink_get_status')?._meta?.mint?.subject).toBe('serial');
  });

  it('marks every set_* tool as an on/off switch on the system, with the everyday words', async () => {
    const sets = (await served()).filter((t) => t.name.startsWith('iaqualink_set_'));
    expect(sets.length).toBe(9);
    for (const t of sets) {
      expect(t._meta?.mint, t.name).toEqual({ domain: 'home', intent: 'turn-on-off', subject: 'serial', aliases: SWITCH_ALIASES });
    }
  });

  it('marks the schedule edits as changes on the system', async () => {
    const tools = await served();
    for (const name of ['iaqualink_add_schedule', 'iaqualink_edit_schedule', 'iaqualink_delete_schedule']) {
      expect(tools.find((t) => t.name === name)?._meta?.mint, name).toEqual({ domain: 'home', intent: 'change', subject: 'serial' });
    }
  });
});

describe('system labels on the serial argument', () => {
  const systems = [
    { label: 'Pool', serial: 'IAQ123' },
    { label: 'Salt', serial: 'EXO456' },
  ];

  it('publishes the supported system names as an enum on every serial argument', async () => {
    const withSerial = (await served({ systems })).filter((t) => 'serial' in t.inputSchema.properties);
    expect(withSerial.length).toBe(17);
    for (const t of withSerial) expect(t.inputSchema.properties.serial.enum, t.name).toEqual(['Pool', 'Salt']);
  });

  it('keeps the property, without an enum, when the listing failed', async () => {
    const withSerial = (await served()).filter((t) => 'serial' in t.inputSchema.properties);
    expect(withSerial.length).toBe(17);
    for (const t of withSerial) {
      expect(t.inputSchema.properties.serial, t.name).not.toHaveProperty('enum');
      expect(t.inputSchema.properties.serial.type).toBe('string');
    }
  });

  it('a read and a write accept the label and act on its serial', async () => {
    const { call, confirmed, server } = await setup({ systems });
    expect(await call('iaqualink_get_status', { serial: 'Pool' })).toMatchObject({ type: 'iaqua', temperatures: { pool: 80 } });
    const { result } = await confirmed('iaqualink_set_equipment', { serial: 'pool', equipment: 'pool_pump', on: false });
    expect(result).toMatchObject({ status: 'confirmed', serial: 'IAQ123' });
    expect(server).toBeDefined();
  });

  it('still accepts the serial', async () => {
    const { call } = await setup({ systems });
    expect(await call('iaqualink_get_status', { serial: 'EXO456' })).toMatchObject({ type: 'exo' });
  });

  it('refuses an unknown name and names the systems it knows', async () => {
    const { fail } = await setup({ systems });
    const text = await fail('iaqualink_get_status', { serial: 'Hot Tub' });
    expect(text).toMatch(/No iAqualink system named "Hot Tub"/);
    expect(text).toMatch(/Pool \(IAQ123\), Salt \(EXO456\)/);
  });
});
