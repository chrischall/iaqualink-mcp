import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as client from '../src/client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mint = readFileSync(join(ROOT, 'mint.yaml'), 'utf8');
const code = mint
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');
const section = (key: string): string => {
  const m = new RegExp(`^${key}:\\n([\\s\\S]*?)(?=^\\S|$(?![\\s\\S]))`, 'm').exec(code);
  return m?.[1] ?? '';
};
const names = (block: string) => [...block.matchAll(/- name: ([A-Z_]+)/g)].map((m) => m[1]);

describe('mint.yaml', () => {
  it('declares per-user children and a credential form with no flow', () => {
    expect(code).toMatch(/perUserChild:\s*true/);
    expect(names(section('auth'))).toEqual(['IAQUALINK_EMAIL', 'IAQUALINK_PASSWORD']);
    expect(section('auth')).not.toMatch(/flow:/);
    expect(section('auth')).toMatch(/name: IAQUALINK_PASSWORD[\s\S]*?type: password/);
  });

  it('keeps no state on disk', () => {
    expect(code).not.toMatch(/^state:/m);
    expect(code).not.toMatch(/dataDir/);
  });

  it('never names an auth field as a host-set env var', () => {
    const env = names(section('env'));
    for (const f of names(section('auth'))) expect(env).not.toContain(f);
  });

  it('documents every env var the source reads (except the per-user credential)', () => {
    const src = readdirSync(join(ROOT, 'src'), { recursive: true })
      .filter((f) => String(f).endsWith('.ts'))
      .map((f) => readFileSync(join(ROOT, 'src', String(f)), 'utf8'))
      .join('\n');
    const read = new Set([...src.matchAll(/readEnvVar\('([A-Z_]+)'/g)].map((m) => m[1]));
    expect(read.size, 'the scan found no readEnvVar calls').toBeGreaterThanOrEqual(3);
    const env = names(section('env'));
    for (const v of read) {
      if (v === 'IAQUALINK_EMAIL' || v === 'IAQUALINK_PASSWORD') continue;
      expect(env, v).toContain(v);
    }
  });

  it('allows exactly the hosts the client fetches', () => {
    const allow = [...section('egress').matchAll(/^\s+- ([a-z0-9.-]+)\s*$/gm)].map((m) => m[1]).sort();
    const fetched = [client.LOGIN_URL, client.REFRESH_URL, client.DEVICES_URL, client.IAQUA_SESSION_URL, client.EXO_DEVICES_URL, client.P_API_SESSION_URL, client.PRM_SESSION_URL, client.WEBTOUCH_USER_URL, client.WEBTOUCH_INIT_URL, client.WEBTOUCH_COMMAND_URL, ...client.WEBTOUCH_STREAM_HOSTS.map((h) => `https://${h}/`)]
      .map((u) => new URL(u).host);
    expect(allow).toEqual([...new Set(fetched)].sort());
  });

  it('puts no secret value in the file', () => {
    expect(code).not.toMatch(/default:/);
  });
});
