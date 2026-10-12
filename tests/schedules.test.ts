import { describe, it, expect } from 'vitest';
import {
  SCHEDULE_DAYS,
  checkExoWindow,
  deviceNames,
  findExoSchedule,
  minutes,
  normalizeIq20,
  parseExoSchedules,
  readScheduleList,
  scheduleError,
  toHHMM,
} from '../src/schedules.js';
import { IQ20_SCHEDULES, IQ20_MASTER_DEVICES, exoShadow } from './support/fixtures.js';

describe('toHHMM / minutes', () => {
  it('formats hour/minute pairs from numbers or numeric strings', () => {
    expect(toHHMM(9, 5)).toBe('09:05');
    expect(toHHMM('23', '59')).toBe('23:59');
    expect(toHHMM(0, 0)).toBe('00:00');
  });

  it('returns null for anything that is not an in-range integer pair', () => {
    for (const [h, m] of [
      [undefined, 0],
      [null, 0],
      ['', 0],
      [' ', 0],
      ['x', 0],
      [24, 0],
      [-1, 0],
      [1.5, 0],
      [1, 60],
      [1, undefined],
      [true, 0],
    ]) {
      expect(toHHMM(h, m), JSON.stringify([h, m])).toBeNull();
    }
  });

  it('counts minutes since midnight', () => {
    expect(minutes('00:00')).toBe(0);
    expect(minutes('09:30')).toBe(570);
  });

  it('names the app\'s day selectors (IQ20ScheduleSetupViewController.m:106)', () => {
    expect(SCHEDULE_DAYS).toEqual(['AllDays', 'Weekdays', 'Weekends', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
  });
});

describe('readScheduleList', () => {
  it('accepts a body with a scheduleList array', () => {
    const r = readScheduleList({ is_error: false, totalCount: 2, isNewScheduleAllowed: true, scheduleList: IQ20_SCHEDULES });
    expect(r).toEqual({ ok: true, list: IQ20_SCHEDULES, totalCount: 2, newAllowed: true });
  });

  it('tolerates missing counters', () => {
    expect(readScheduleList({ scheduleList: [] })).toEqual({ ok: true, list: [], totalCount: null, newAllowed: null });
  });

  it('reads isNewScheduleAllowed as a boolean or a string', () => {
    expect(readScheduleList({ scheduleList: [], isNewScheduleAllowed: 'false' })).toMatchObject({ newAllowed: false });
  });

  it('reports is_error (boolean or string) with the response text', () => {
    expect(readScheduleList({ is_error: true, response: 'not supported', scheduleList: [] })).toEqual({
      ok: false,
      reason: 'is_error: not supported',
    });
    expect(readScheduleList({ is_error: 'true' })).toEqual({ ok: false, reason: 'is_error: (no response text)' });
  });

  it('reports a body without a scheduleList, quoting its message', () => {
    expect(readScheduleList({ message: 'unknown command' })).toEqual({ ok: false, reason: 'no scheduleList (message: "unknown command")' });
    expect(readScheduleList({})).toEqual({ ok: false, reason: 'no scheduleList' });
    expect(readScheduleList(null)).toEqual({ ok: false, reason: 'no scheduleList' });
  });

  it('scheduleError is null unless is_error is set', () => {
    expect(scheduleError({ is_error: false })).toBeNull();
    expect(scheduleError('text')).toBeNull();
    expect(scheduleError({ is_error: true, response: 'x' })).toBe('x');
  });
});

describe('normalizeIq20', () => {
  const names = deviceNames({ deviceList: IQ20_MASTER_DEVICES });

  it('maps device ids to names, skipping malformed rows', () => {
    expect(deviceNames({ deviceList: [...IQ20_MASTER_DEVICES, null, { id: 9 }, { name: 'no id' }] })).toEqual(
      new Map([
        ['1', 'Filter Pump'],
        ['2', 'Pool Light'],
        ['3', 'Cleaner'],
      ]),
    );
    expect(deviceNames({}).size).toBe(0);
    expect(deviceNames(undefined).size).toBe(0);
  });

  it('normalizes a schedule, resolving its device name', () => {
    expect(normalizeIq20(IQ20_SCHEDULES[0], names)).toEqual({
      id: '1',
      deviceId: '2',
      device: 'Pool Light',
      start: '09:00',
      stop: '17:00',
      days: 'AllDays',
      raw: IQ20_SCHEDULES[0],
    });
  });

  it('leaves what it cannot read as null', () => {
    expect(normalizeIq20({ id: 7, deviceId: 5 }, names)).toMatchObject({ id: '7', deviceId: '5', device: null, start: null, stop: null, days: null });
    expect(normalizeIq20('junk', names)).toMatchObject({ id: 'undefined', deviceId: null, device: null });
  });
});

describe('eXO schedules', () => {
  it('parses the shadow schedules block, skipping the counters and malformed rows', () => {
    const shadow = exoShadow();
    (shadow.state.reported.schedules as Record<string, unknown>).sch99 = 'junk';
    const p = parseExoSchedules(shadow)!;
    expect(p.supported).toBe(6);
    expect(p.programmed).toBe(2);
    expect(p.schedules.map((s) => s.id)).toEqual(['sch1', 'sch2', 'sch3', 'sch4', 'sch9']);
    expect(p.schedules[2]).toEqual({
      id: 'sch3',
      scheduleId: 'sch_3',
      device: 'Filter Pump 1',
      endpoint: 'ssp_1',
      enabled: true,
      active: true,
      start: '08:00',
      stop: '18:00',
      days: null,
      raw: shadow.state.reported.schedules.sch3,
    });
    expect(p.schedules[3]).toMatchObject({ endpoint: 'vsp_2', rpm: 1750, enabled: false });
  });

  it('tolerates a row without a timer, name or endpoint', () => {
    const p = parseExoSchedules({ state: { reported: { schedules: { sch1: {} } } } })!;
    expect(p.schedules[0]).toMatchObject({ id: 'sch1', scheduleId: null, device: null, endpoint: null, start: null, stop: null, enabled: false, active: false });
    expect(p.supported).toBeNull();
  });

  it('returns null when the shadow has no schedules block', () => {
    expect(parseExoSchedules({ state: { reported: {} } })).toBeNull();
    expect(parseExoSchedules(null)).toBeNull();
  });

  it('finds a schedule by key, id, name or endpoint', () => {
    const list = parseExoSchedules(exoShadow())!.schedules;
    for (const ref of ['sch3', 'SCH_3', 'filter pump 1', 'ssp_1']) expect(findExoSchedule(list, ref)?.id, ref).toBe('sch3');
    expect(findExoSchedule(list, 'nope')).toBeUndefined();
  });

  describe('checkExoWindow (dje2912 systems/exo/system.py:780-836)', () => {
    const list = parseExoSchedules(exoShadow())!.schedules;
    const on = (start: string, stop: string) => ({ enabled: true, start, stop });
    const off = { enabled: false, start: '00:00', stop: '00:00' };

    it('lets an SWC window inside its pump window through', () => {
      expect(checkExoWindow(list, 'sch1', on('09:00', '18:00'))).toBeNull();
    });

    it('refuses an SWC window that leaves its pump window', () => {
      expect(checkExoWindow(list, 'sch1', on('07:00', '12:00'))).toMatch(/inside .*Filter Pump 1.*08:00–18:00/);
      expect(checkExoWindow(list, 'sch1', on('09:00', '19:00'))).toMatch(/inside/);
    });

    it('refuses an enabled SWC whose pump schedule is disabled', () => {
      expect(checkExoWindow(list, 'sch2', on('09:00', '10:00'))).toMatch(/Filter Pump 2.*disabled/);
    });

    it('allows disabling an SWC, and SWCs without a paired pump', () => {
      expect(checkExoWindow(list, 'sch1', off)).toBeNull();
      const lone = list.filter((s) => s.id !== 'sch3');
      expect(checkExoWindow(lone, 'sch1', on('01:00', '02:00'))).toBeNull();
    });

    it('refuses shrinking or disabling a pump window around an enabled SWC', () => {
      expect(checkExoWindow(list, 'sch3', on('11:00', '18:00'))).toMatch(/Salt Water Chlorinator 1.*10:00–16:00/);
      expect(checkExoWindow(list, 'sch3', off)).toMatch(/disable .*Salt Water Chlorinator 1.* first/);
      expect(checkExoWindow(list, 'sch3', on('06:00', '20:00'))).toBeNull();
    });

    it('falls back to the shadow key when a timer has no name', () => {
      const nameless = list.map((s) => (s.id === 'sch3' ? { ...s, device: null } : s));
      expect(checkExoWindow(nameless, 'sch1', on('07:00', '12:00'))).toMatch(/"sch3" \(sch3\)/);
    });

    it('ignores pumps whose SWC is disabled, and unpaired endpoints', () => {
      expect(checkExoWindow(list, 'sch4', on('01:00', '02:00'))).toBeNull();
      expect(checkExoWindow(list, 'sch9', on('01:00', '02:00'))).toBeNull();
      expect(checkExoWindow(list, 'nope', on('01:00', '02:00'))).toBeNull();
    });
  });
});
