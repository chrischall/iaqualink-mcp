// Invariant: every release-please version annotation under src/ holds the
// version in package.json, and every other file release-please bumps agrees.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionSyncTest } from '@chrischall/mcp-utils/test';
import { VERSION } from '../src/version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (p: string): Record<string, any> => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

describe('version sync', () => {
  it('every annotated src line matches package.json', () => {
    const mismatches = versionSyncTest({ srcDir: join(ROOT, 'src'), pkgPath: join(ROOT, 'package.json') });
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('every release-please extra-file carries the package version', () => {
    const v = json('package.json').version;
    expect(VERSION).toBe(v);
    expect(json('manifest.json').version).toBe(v);
    expect(json('server.json').version).toBe(v);
    for (const p of json('server.json').packages) expect(p.version).toBe(v);
    expect(json('.claude-plugin/plugin.json').version).toBe(v);
    expect(json('.claude-plugin/marketplace.json').metadata.version).toBe(v);
    for (const p of json('.claude-plugin/marketplace.json').plugins) expect(p.version).toBe(v);
    expect(json('.release-please-manifest.json')['.']).toBe(v);
  });
});
