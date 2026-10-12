import { describe, it, expect } from 'vitest';
import { EXO_EQUIPMENT, exoDesired, exoObserved, normalizeExo, parseShadow } from '../src/exo.js';
import { DEVICES, exoShadow } from './support/fixtures.js';

const system = DEVICES[1]!;

describe('parseShadow', () => {
  it('reads the swc_0 equipment block, its sensors and aux, and the heating block', () => {
    const p = parseShadow(exoShadow());
    expect(p.connection).toBe('connected');
    expect(p.swc.production).toBe(1);
    expect(p.sensors).toContainEqual({ key: 'sns_3', type: 'Water temp', on: true, value: 29 });
    expect(p.aux).toContainEqual({ aux: '1', name: 'aux_1', on: false, type: 'none', mode: 0, color: 0 });
    expect(p.heating).toMatchObject({ sp: 28, enabled: 0 });
  });

  it('reports a sensor that is off as having no value (ExoSensor.state)', () => {
    const s = exoShadow();
    s.state.reported.equipment.swc_0.sns_1.state = 0;
    expect(parseShadow(s).sensors.find((x) => x.key === 'sns_1')!.value).toBeNull();
  });

  it('rejects a shadow without the swc_0 block', () => {
    expect(() => parseShadow({ state: { reported: {} } })).toThrow(/swc_0/);
    expect(() => parseShadow(null)).toThrow(/swc_0/);
  });
});

describe('normalizeExo', () => {
  it('produces a compact status', () => {
    const s = normalizeExo({ kind: 'exo', system, shadow: exoShadow() }, 'compact') as Record<string, any>;
    expect(s).toMatchObject({
      serial: 'EXO456',
      name: 'Salt',
      type: 'exo',
      online: true,
      unit: 'C',
      temperatures: { pool: 29 },
      setPoints: { pool: 28 },
      heating: { enabled: 'off', heater: 'off', setPoint: 28, min: 1, max: 40 },
      chlorinator: { production: 'on', outputPercent: 50, boost: 'off', boostTime: '24:00', low: 'off' },
      chemistry: { ph: 75, phSetPoint: 74, orp: 780, orpSetPoint: 830 },
      equipment: { filter_pump: 'on' },
      errors: { code: 0, state: 0 },
    });
    expect(s.aux).toEqual([
      { aux: '1', on: false, type: 'none' },
      { aux: '2', on: false, type: 'none' },
    ]);
    expect(s).not.toHaveProperty('equipmentRaw');
  });

  it('adds the raw equipment and heating blocks in full', () => {
    const s = normalizeExo({ kind: 'exo', system, shadow: exoShadow() }, 'full') as Record<string, any>;
    expect(s.equipmentRaw.swc).toBe(50);
    expect(s.heatingRaw.sp_max).toBe(40);
  });

  it('copes with a system that has no heating block or water sensor and an unknown connection', () => {
    const sh = exoShadow() as any;
    delete sh.state.reported.heating;
    delete sh.state.reported.aws;
    delete sh.state.reported.equipment.swc_0.sns_3;
    delete sh.state.reported.equipment.swc_0.filter_pump;
    const s = normalizeExo({ kind: 'exo', system: { serial_number: 'E', device_type: 'exo' }, shadow: sh }, 'compact') as Record<string, any>;
    expect(s.online).toBeNull();
    expect(s.name).toBeNull();
    expect(s.temperatures).toEqual({ pool: null });
    expect(s).not.toHaveProperty('heating');
    expect(s.setPoints).toEqual({});
    expect(s.equipment).toEqual({});
  });

  it('marks a disconnected system offline', () => {
    const sh = exoShadow() as any;
    sh.state.reported.aws.status = 'disconnected';
    expect((normalizeExo({ kind: 'exo', system, shadow: sh }, 'compact') as any).online).toBe(false);
  });
});

describe('eXO write shapes (iaqualink-py ExoSystem.set_*)', () => {
  it('builds exactly the desired-state bodies the library sends', () => {
    expect(exoDesired({ kind: 'equipment', name: 'filter_pump', on: true })).toEqual({
      equipment: { swc_0: { filter_pump: { state: 1 } } },
    });
    expect(exoDesired({ kind: 'equipment', name: 'production', on: false })).toEqual({
      equipment: { swc_0: { production: 0 } },
    });
    expect(exoDesired({ kind: 'equipment', name: 'heating', on: true })).toEqual({ heating: { enabled: 1 } });
    expect(exoDesired({ kind: 'aux', name: 'aux_2', on: true })).toEqual({ equipment: { swc_0: { aux_2: { state: 1 } } } });
    expect(exoDesired({ kind: 'aux', name: 'aux_1', on: false })).toEqual({ equipment: { swc_0: { aux_1: { state: 0 } } } });
    expect(exoDesired({ kind: 'set_point', value: 30 })).toEqual({ heating: { sp: 30 } });
    expect(exoDesired({ kind: 'chlorinator', value: 60 })).toEqual({ equipment: { swc_0: { swc: 60 } } });
    expect(EXO_EQUIPMENT).toEqual(['filter_pump', 'production', 'boost', 'low', 'heating']);
  });

  it('reads back the field each write changes', () => {
    const p = parseShadow(exoShadow());
    expect(exoObserved(p, { kind: 'equipment', name: 'filter_pump', on: true })).toBe(1);
    expect(exoObserved(p, { kind: 'equipment', name: 'boost', on: true })).toBe(0);
    expect(exoObserved(p, { kind: 'equipment', name: 'heating', on: true })).toBe(0);
    expect(exoObserved(p, { kind: 'aux', name: 'aux_1', on: true })).toBe(0);
    expect(exoObserved(p, { kind: 'set_point', value: 30 })).toBe(28);
    expect(exoObserved(p, { kind: 'chlorinator', value: 60 })).toBe(50);
    expect(exoObserved(p, { kind: 'aux', name: 'aux_9', on: true })).toBeUndefined();
  });
});
