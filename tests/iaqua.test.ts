import { describe, it, expect } from 'vitest';
import {
  IAQUA_EQUIPMENT,
  auxKey,
  findAux,
  isOn,
  normalizeIaqua,
  parseDevices,
  parseHome,
  setTempsParams,
  stateLabel,
  tempRange,
} from '../src/iaqua.js';
import { DEVICES, IAQUA_AUX, IAQUA_HOME_STATE, devicesScreen, homeScreen } from './support/fixtures.js';

const system = DEVICES[0]!;

describe('iAqua state vocabulary (iaqualink-py AqualinkState)', () => {
  it('labels the numeric states and passes others through', () => {
    expect(['0', '1', '2', '3', 'present', 'absent', 'weird'].map(stateLabel)).toEqual([
      'off',
      'on',
      'standby',
      'enabled',
      'present',
      'absent',
      'weird',
    ]);
  });

  it('treats on, enabled and present as on — like IaquaBinarySensor.is_on', () => {
    expect(['1', '3', 'present'].every(isOn)).toBe(true);
    expect(['0', '2', 'absent', '', undefined].some(isOn)).toBe(false);
  });
});

describe('parseHome', () => {
  it('flattens the entries after the four header rows and sets aside structured ones', () => {
    const h = parseHome(homeScreen(IAQUA_HOME_STATE));
    expect(h.online).toBe(true);
    expect(h.unit).toBe('F');
    expect(h.entries.pool_pump).toBe('1');
    expect(h.entries.spa_temp).toBe('');
    expect(Object.keys(h.structured)).toEqual(['icl_info_list']);
  });

  it('reports an offline system without entries', () => {
    const h = parseHome(homeScreen(IAQUA_HOME_STATE, { status: 'Offline' }));
    expect(h).toMatchObject({ online: false, status: 'Offline', entries: {} });
  });

  it('marks a home screen with an empty system_type as not ready (iaqualink-py skips it)', () => {
    const h = parseHome({ home_screen: [{ status: 'Online' }, { response: '' }, { system_type: '' }] });
    expect(h.ready).toBe(false);
    expect(h.entries).toEqual({});
  });

  it('rejects something that is not a home screen', () => {
    expect(() => parseHome({ message: 'nope' })).toThrow(/home_screen/);
    expect(() => parseHome(null)).toThrow(/home_screen/);
  });

  it('defaults the unit when the scale row is missing or blank, and a missing status to empty', () => {
    expect(parseHome({ home_screen: [{ status: 'Online' }, {}, { system_type: '0' }] }).unit).toBe('F');
    const h = parseHome({ home_screen: [{}, {}, { system_type: '0' }, { temp_scale: '' }] });
    expect(h).toMatchObject({ unit: 'F', status: '', online: true });
  });
});

describe('parseDevices', () => {
  it('flattens each aux row and classifies it the way iaqualink-py does', () => {
    const d = parseDevices(devicesScreen(IAQUA_AUX));
    expect(d.online).toBe(true);
    expect(d.stale).toBe(false);
    const byName = Object.fromEntries(d.aux.map((a) => [a.name, a]));
    expect(byName.aux_1).toMatchObject({ aux: '1', label: 'Cleaner', kind: 'switch', on: false });
    expect(byName.aux_2).toMatchObject({ aux: '2', label: 'Pool Light', kind: 'color_light', on: true });
    expect(byName.aux_2!.light).toMatchObject({ manufacturer: 'Jandy', model: 'LED WaterColors Light' });
    expect(byName.aux_2!.light!.effects['Alpine White']).toBe(1);
    expect(byName.aux_3).toMatchObject({ kind: 'dimmable_light', brightness: 0 });
    expect(byName.aux_4).toMatchObject({ kind: 'light', on: false });
  });

  it('keeps a color light with an unknown subtype as a light without effects', () => {
    const d = parseDevices(devicesScreen({ aux_9: { state: '1', label: 'X', type: '2', subtype: '42' } }));
    expect(d.aux[0]).toMatchObject({ kind: 'color_light', light: undefined });
  });

  it('flags a NaN state as stale, as iaqualink-py does', () => {
    const d = parseDevices(devicesScreen({ aux_1: { state: 'NaN', label: 'AUX 1', type: 'NaN', subtype: 'NaN' } }));
    expect(d.stale).toBe(true);
    expect(d.aux).toEqual([]);
  });

  it('reports an offline system', () => {
    expect(parseDevices(devicesScreen(IAQUA_AUX, { status: 'Offline' }))).toMatchObject({ online: false, aux: [] });
  });

  it('rejects something that is not a devices screen', () => {
    expect(() => parseDevices({})).toThrow(/devices_screen/);
  });

  it('labels a row with no label from its name', () => {
    const d = parseDevices({
      devices_screen: [{ status: 'Online' }, {}, {}, { aux_5: [{ state: '1' }, { type: '0' }, { subtype: '0' }] }],
    });
    expect(d.aux[0]).toMatchObject({ label: 'Aux 5', kind: 'switch', on: true });
  });

  it('ignores malformed rows', () => {
    const d = parseDevices({ devices_screen: [{ status: 'Online' }, {}, {}, { aux_1: 'x' }, 7, {}] });
    expect(d.aux).toEqual([]);
  });

  it('defaults the attributes a row omits', () => {
    const d = parseDevices({ devices_screen: [{ status: 'Online' }, {}, {}, { aux_6: [{ label: 'Bubbler' }] }] });
    expect(d.aux[0]).toMatchObject({ state: '', on: false, type: '0', subtype: '0', kind: 'switch' });
  });
});

describe('findAux / auxKey', () => {
  const { aux } = parseDevices(devicesScreen(IAQUA_AUX));
  it('accepts the number, the aux_ name or the label (case-insensitive)', () => {
    expect(auxKey('3')).toBe('aux_3');
    expect(auxKey('AUX_3')).toBe('aux_3');
    expect(auxKey('aux3')).toBe('aux_3');
    expect(findAux(aux, '2')?.name).toBe('aux_2');
    expect(findAux(aux, 'aux_2')?.name).toBe('aux_2');
    expect(findAux(aux, 'pool light')?.name).toBe('aux_2');
    expect(findAux(aux, 'nope')).toBeUndefined();
  });
});

describe('temperatures', () => {
  it('uses iaqualink-py’s ranges per unit', () => {
    expect(tempRange('F')).toEqual({ min: 34, max: 104 });
    expect(tempRange('C')).toEqual({ min: 1, max: 40 });
  });

  it('sends spa as temp1 and pool as temp2 when the spa set point exists, filling the other from current', () => {
    expect(setTempsParams({ spa_set_point: '102', pool_set_point: '85' }, { pool: 86 })).toEqual({
      temp1: '102',
      temp2: '86',
    });
    expect(setTempsParams({ spa_set_point: '102', pool_set_point: '85' }, { spa: 100 })).toEqual({
      temp1: '100',
      temp2: '85',
    });
  });

  it('sends only temp1 for the pool when there is no spa set point', () => {
    expect(setTempsParams({ spa_set_point: '', pool_set_point: '85' }, { pool: 80 })).toEqual({ temp1: '80' });
  });

  it('refuses a spa set point on a system without one, and a missing pool set point', () => {
    expect(() => setTempsParams({ pool_set_point: '85' }, { spa: 100 })).toThrow(/spa set point/);
    expect(() => setTempsParams({}, { pool: 80 })).toThrow(/pool set point/);
  });
});

describe('normalizeIaqua', () => {
  const home = homeScreen(IAQUA_HOME_STATE);
  const devices = devicesScreen(IAQUA_AUX);

  it('produces a compact status with typed temperatures and named equipment', () => {
    const s = normalizeIaqua({ kind: 'iaqua', system, home, devices }, 'compact') as Record<string, any>;
    expect(s).toMatchObject({
      serial: 'IAQ123',
      name: 'Pool',
      type: 'iaqua',
      online: true,
      unit: 'F',
      temperatures: { air: 72, pool: 80, spa: null },
      setPoints: { pool: 85, spa: 102 },
      equipment: { pool_pump: 'on', spa_pump: 'off', pool_heater: 'enabled', spa_heater: 'off', solar_heater: 'off' },
      freezeProtection: 'off',
      chemistry: { pool_salinity: 3200, spa_salinity: 0 },
    });
    expect(s.chemistry).not.toHaveProperty('orp');
    expect(s.aux).toContainEqual({ aux: '2', label: 'Pool Light', on: true, kind: 'color_light' });
    expect(s.other).toEqual({ cover_pool: '0', is_icl_present: 'absent' });
  });

  it('adds light details and the raw entries in full', () => {
    const s = normalizeIaqua({ kind: 'iaqua', system, home, devices }, 'full') as Record<string, any>;
    const light = s.aux.find((a: any) => a.aux === '2');
    expect(light.effects).toContain('Alpine White');
    expect(light.state).toBe('1');
    expect(s.homeEntries.pool_pump).toBe('1');
    expect(s.structured).toHaveProperty('icl_info_list');
  });

  it('keeps a non-numeric reading as text and lists the equipment vocabulary', () => {
    const s = normalizeIaqua(
      { kind: 'iaqua', system, home: homeScreen({ ...IAQUA_HOME_STATE, air_temp: '--' }), devices },
      'compact',
    ) as Record<string, any>;
    expect(s.temperatures.air).toBe('--');
    expect(IAQUA_EQUIPMENT).toContain('solar_heater');
  });

  it('says so when the system is offline', () => {
    const s = normalizeIaqua(
      { kind: 'iaqua', system, home: homeScreen({}, { status: 'Offline' }), devices: devicesScreen({}, { status: 'Offline' }) },
      'compact',
    ) as Record<string, any>;
    expect(s.online).toBe(false);
    expect(s.note).toMatch(/offline/i);
  });

  it('says so when the panel has not reported yet', () => {
    const s = normalizeIaqua(
      {
        kind: 'iaqua',
        system: { serial_number: 'X', device_type: 'iaqua' },
        home: { home_screen: [{ status: 'Online' }, {}, { system_type: '' }] },
        devices: devicesScreen({ aux_1: { state: 'NaN', label: 'A', type: 'NaN', subtype: 'NaN' } }),
      },
      'compact',
    ) as Record<string, any>;
    expect(s.note).toMatch(/not reported/i);
    expect(s.name).toBeNull();
  });
});

describe('parseOneTouch (iaqualink-py master system.py:465-508)', () => {
  it('reads every onetouch_N slot, marking disabled ones', async () => {
    const { parseOneTouch, findOneTouch } = await import('../src/iaqua.js');
    const { ONETOUCH, onetouchScreen } = await import('./support/fixtures.js');
    const p = parseOneTouch(onetouchScreen({ ...ONETOUCH, onetouch_2: { ...ONETOUCH.onetouch_2!, state: '1' } }));
    expect(p.online).toBe(true);
    expect(p.scenes.map((s) => [s.onetouch, s.label, s.enabled, s.on])).toEqual([
      ['1', 'All OFF', true, false],
      ['2', 'Spa Mode', true, true],
      ['3', 'Clean Mode', true, false],
      ['4', 'ONETOUCH 4', false, false],
      ['5', 'OneTouch 5', true, false],
      ['6', 'Water Falls', true, false],
    ]);
    expect(findOneTouch(p.scenes, '2')?.name).toBe('onetouch_2');
    expect(findOneTouch(p.scenes, 'onetouch_3')?.label).toBe('Clean Mode');
    expect(findOneTouch(p.scenes, 'water falls')?.onetouch).toBe('6');
    expect(findOneTouch(p.scenes, 'nope')).toBeUndefined();
  });

  it('skips non-slot rows and labels a slot without one by its name', async () => {
    const { parseOneTouch } = await import('../src/iaqua.js');
    const p = parseOneTouch({ onetouch_screen: [{ status: 'Online' }, { response: '' }, { other: [] }, { onetouch_7: [{ state: '0' }] }, { onetouch_8: [{ label: 'X' }] }, null] });
    expect(p.scenes).toEqual([
      { onetouch: '7', name: 'onetouch_7', label: 'Onetouch 7', enabled: true, on: false, state: '0' },
      { onetouch: '8', name: 'onetouch_8', label: 'X', enabled: true, on: false, state: '' },
    ]);
  });

  it('reports an Offline / Service / empty status as offline with no scenes', async () => {
    const { parseOneTouch } = await import('../src/iaqua.js');
    for (const status of ['Offline', 'Service', '']) {
      expect(parseOneTouch({ onetouch_screen: [{ status }, { onetouch_1: [{ status: '1' }] }] })).toEqual({ online: false, status, scenes: [] });
    }
    expect(parseOneTouch({ onetouch_screen: [{}] }).online).toBe(false);
    expect(() => parseOneTouch({})).toThrow(/onetouch_screen/);
  });
});
