/**
 * `_meta.mint` hints (the mcp-host context-groups contract): which canonical
 * group a tool belongs to, what kind of ask it answers, which argument takes
 * the person's subject, and everyday words its name and description lack.
 * Inert data to any other client.
 */
const DOMAIN = 'home';

/** What people call the equipment these switches reach. Lowercase, ≤ 8, each ≤ 40 chars. */
export const SWITCH_ALIASES = ['hot tub', 'spa', 'pool', 'heater', 'jets', 'lights'];

/** A read with no system argument (the account's list). */
export const LOOKUP_META = { mint: { domain: DOMAIN, intent: 'lookup' } };
/** A read of one system. */
export const SYSTEM_LOOKUP_META = { mint: { domain: DOMAIN, intent: 'lookup', subject: 'serial' } };
/** An on/off or set-point write on one system. */
export const SWITCH_META = { mint: { domain: DOMAIN, intent: 'turn-on-off', subject: 'serial', aliases: SWITCH_ALIASES } };
/** A write that edits a stored program rather than switching equipment. */
export const CHANGE_META = { mint: { domain: DOMAIN, intent: 'change', subject: 'serial' } };
