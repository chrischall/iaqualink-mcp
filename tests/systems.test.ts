import { describe, it, expect } from 'vitest';
import { IaqualinkClient } from '../src/client.js';
import { loadSystemLabels, resolveSerial, type SystemLabel } from '../src/tools/systems.js';
import { FakeIaqualink } from './support/fake-server.js';

function clientFor(server: FakeIaqualink, password = server.password) {
  return new IaqualinkClient({
    email: 'me@example.com',
    password,
    fetchImpl: server.fetch,
    minIntervalMs: 0,
    statusCacheMs: 0,
    sleep: async () => {},
  });
}

describe('loadSystemLabels', () => {
  it('labels the supported systems by name and leaves unsupported devices out', async () => {
    expect(await loadSystemLabels(clientFor(new FakeIaqualink()))).toEqual([
      { label: 'Pool', serial: 'IAQ123' },
      { label: 'Salt', serial: 'EXO456' },
    ]);
  });

  it('labels a nameless system by its serial and disambiguates a repeated name', async () => {
    const server = new FakeIaqualink();
    server.devices = [
      { serial_number: 'A1', device_type: 'iaqua' },
      { serial_number: 'B2', name: 'Spa', device_type: 'iaqua' },
      { serial_number: 'C3', name: ' spa ', device_type: 'exo' },
    ];
    expect(await loadSystemLabels(clientFor(server))).toEqual([
      { label: 'A1', serial: 'A1' },
      { label: 'Spa (B2)', serial: 'B2' },
      { label: 'spa (C3)', serial: 'C3' },
    ]);
  });

  it('answers undefined (no enum) when the listing fails', async () => {
    expect(await loadSystemLabels(clientFor(new FakeIaqualink(), 'wrong'))).toBeUndefined();
    expect(await loadSystemLabels(new IaqualinkClient({ env: {} }))).toBeUndefined();
  });

  it('answers undefined when the account has no supported system (never an empty enum)', async () => {
    const server = new FakeIaqualink();
    server.devices = [{ serial_number: 'R1', name: 'Robot', device_type: 'i2d_robot' }];
    expect(await loadSystemLabels(clientFor(server))).toBeUndefined();
  });

  it('gives up after its deadline rather than holding the boot', async () => {
    const client = { listSystems: () => new Promise<never>(() => {}) } as unknown as IaqualinkClient;
    expect(await loadSystemLabels(client, 5)).toBeUndefined();
  });
});

describe('resolveSerial', () => {
  const systems: SystemLabel[] = [
    { label: 'Pool', serial: 'IAQ123' },
    { label: 'Back Spa', serial: 'EXO456' },
  ];
  const server = new FakeIaqualink();
  const client = clientFor(server);

  it('maps a label (case- and space-insensitively) to its serial', async () => {
    expect(await resolveSerial({ client, systems }, 'Pool')).toBe('IAQ123');
    expect(await resolveSerial({ client, systems }, '  back spa ')).toBe('EXO456');
  });

  it('accepts a serial as is', async () => {
    expect(await resolveSerial({ client, systems }, 'EXO456')).toBe('EXO456');
  });

  it('accepts a serial the account lists now but did not at start', async () => {
    expect(await resolveSerial({ client, systems: [systems[0]!] }, 'EXO456')).toBe('EXO456');
  });

  it('refuses an unknown name, naming the known systems', async () => {
    await expect(resolveSerial({ client, systems }, 'Hot Tub')).rejects.toThrow(
      /No iAqualink system named "Hot Tub"[\s\S]*Pool[\s\S]*Back Spa/,
    );
  });

  it('passes the value through when no labels were listed at start', async () => {
    expect(await resolveSerial({ client, systems: undefined }, 'IAQ123')).toBe('IAQ123');
  });
});
