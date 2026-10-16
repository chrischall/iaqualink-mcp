// Packaging invariants that otherwise only fail once a tag exists: npm
// provenance validates repository.url, a scoped name needs public access, and
// anything missing from `files` silently does not ship.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (p: string): Record<string, any> => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const pkg = json('package.json');
const plugin = json('.claude-plugin/plugin.json');

describe('package.json', () => {
  it('declares the repository npm provenance checks against', () => {
    expect(pkg.repository.url).toBe('git+https://github.com/chrischall/iaqualink-mcp.git');
  });

  it('publishes under the @chrischall scope with public access', () => {
    expect(pkg.name).toBe('@chrischall/iaqualink-mcp');
    expect(pkg.publishConfig).toEqual({ access: 'public' });
  });

  it('keeps the bin unscoped and pointing at the tsc entry', () => {
    expect(pkg.bin).toEqual({ 'iaqualink-mcp': 'dist/index.js' });
  });

  it('ships skills, the hosting manifest and the registry/plugin files', () => {
    for (const f of ['dist', 'skills', 'mint.yaml', 'server.json', '.claude-plugin', '.mcp.json']) {
      expect(pkg.files).toContain(f);
    }
  });

  it('agrees with server.json and release-please on the npm identity', () => {
    expect(json('server.json').packages[0].identifier).toBe(pkg.name);
    expect(json('release-please-config.json').packages['.']['package-name']).toBe(pkg.name);
  });

  it('starts at 0.1.0 and stays on 0.x for breaking changes', () => {
    const rp = json('release-please-config.json').packages['.'];
    expect(rp['initial-version']).toBe('0.1.0');
    expect(rp['bump-minor-pre-major']).toBe(true);
    expect(rp['extra-files']).toContain('src/version.ts');
  });

  it('keeps the registry description within the 100-char limit', () => {
    expect(json('server.json').description.length).toBeLessThanOrEqual(100);
  });
});

describe('.claude-plugin/plugin.json', () => {
  it('declares the MCP config under `mcpServers`, not the ignored `mcp` key', () => {
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
    expect(existsSync(resolve(ROOT, plugin.mcpServers))).toBe(true);
  });

  it('the plugin launches the published package: a git-source plugin install never has dist/ (fleet-audit#1195)', () => {
    const servers = json('.mcp.json').mcpServers as Record<string, { command: string; args: string[] }>;
    const entry = servers.iaqualink!;
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['-y', json('package.json').name]);
  });

  it('auto-discovers the skills directory', () => {
    expect(plugin.skills).toBe('./skills/');
  });
});

describe('environment variables', () => {
  it('declares every IAQUALINK_* variable the server reads in manifest.json, server.json and .mcp.json (CI strict surface lint)', () => {
    const src = ['src/client.ts', 'src/index.ts'].map((p) => readFileSync(join(ROOT, p), 'utf8')).join('\n');
    const read = [...new Set([...src.matchAll(/'(IAQUALINK_[A-Z_]+)'/g)].map((m) => m[1]!))].sort();
    expect(read.length).toBeGreaterThan(0);
    const manifestEnv = Object.keys(json('manifest.json').server.mcp_config.env).sort();
    const serverEnv = (json('server.json').packages as Array<{ environmentVariables: Array<{ name: string }> }>)
      .flatMap((p) => p.environmentVariables.map((e) => e.name))
      .sort();
    const mcpEnv = Object.keys(Object.values(json('.mcp.json').mcpServers as Record<string, { env: object }>)[0]!.env).sort();
    expect(manifestEnv).toEqual(read);
    expect(serverEnv).toEqual(read);
    expect(mcpEnv).toEqual(read);
  });
});
