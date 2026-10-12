/**
 * Response shapes, transcribed from iaqualink-py 0.7.0 (the client Home
 * Assistant uses): its parsers in src/iaqualink/systems/{iaqua,exo}/system.py
 * and the payloads in its tests/ (test_client.py LOGIN_DATA, tests/systems/
 * iaqua/test_system.py devices_screen, tests/systems/exo/test_system.py
 * SAMPLE_DATA). The iAqua home_screen entries beyond index 3 are the device
 * names those parsers and docs/guide/devices.md use, plus the chemistry /
 * cover / ICL names seen in public Home Assistant diagnostics. NOT captured
 * live — see docs/IAQUALINK-API.md.
 */

export const LOGIN_OK = {
  id: 'user-123',
  authentication_token: 'auth-tok',
  session_id: 'sess-1',
  userPoolOAuth: { IdToken: 'id-tok-1', RefreshToken: 'refresh-tok' },
};

export const REFRESH_OK = {
  id: 'user-123',
  authentication_token: 'auth-tok-2',
  session_id: 'sess-2',
  userPoolOAuth: { IdToken: 'id-tok-2' },
};

export const DEVICES = [
  {
    id: 123456,
    serial_number: 'IAQ123',
    created_at: '2017-09-23T01:00:08.000Z',
    updated_at: '2017-09-23T01:00:08.000Z',
    name: 'Pool',
    device_type: 'iaqua',
    owner_id: null,
    updating: false,
    firmware_version: null,
    target_firmware_version: null,
    update_firmware_start_at: null,
    last_activity_at: null,
  },
  { id: 2, serial_number: 'EXO456', name: 'Salt', device_type: 'exo' },
  { id: 3, serial_number: 'ZZZ789', name: 'Robot', device_type: 'i2d_robot' },
];

export type HomeState = Record<string, string>;

export const IAQUA_HOME_STATE: HomeState = {
  spa_temp: '',
  pool_temp: '80',
  air_temp: '72',
  spa_set_point: '102',
  pool_set_point: '85',
  cover_pool: '0',
  freeze_protection: '0',
  spa_pump: '0',
  pool_pump: '1',
  spa_heater: '0',
  pool_heater: '3',
  solar_heater: '0',
  spa_salinity: '0',
  pool_salinity: '3200',
  orp: '',
  ph: '',
  is_icl_present: 'absent',
};

export function homeScreen(state: HomeState, opts: { status?: string; scale?: string } = {}) {
  return {
    message: '',
    home_screen: [
      { status: opts.status ?? 'Online' },
      { response: '' },
      { system_type: '0' },
      { temp_scale: opts.scale ?? 'F' },
      ...Object.entries(state).map(([k, v]) => ({ [k]: v })),
      // A structured entry the library skips (state is a dict/list).
      { icl_info_list: [{ icl_state: 'off' }] },
    ],
  };
}

export interface AuxState {
  state: string;
  label: string;
  icon?: string;
  type: string;
  subtype: string;
}

export const IAQUA_AUX: Record<string, AuxState> = {
  aux_1: { state: '0', label: 'CLEANER', icon: 'aux_1_0.png', type: '0', subtype: '0' },
  aux_2: { state: '1', label: 'POOL LIGHT', icon: 'aux_1_1.png', type: '2', subtype: '4' },
  aux_3: { state: '0', label: 'SPA LIGHT', icon: 'aux_1_0.png', type: '1', subtype: '0' },
  aux_4: { state: '0', label: 'YARD LIGHT', icon: 'aux_1_0.png', type: '0', subtype: '0' },
};

export function devicesScreen(aux: Record<string, AuxState>, opts: { status?: string } = {}) {
  return {
    message: '',
    devices_screen: [
      { status: opts.status ?? 'Online' },
      { response: '' },
      { group: '1' },
      ...Object.entries(aux).map(([k, a]) => ({
        [k]: [{ state: a.state }, { label: a.label }, { icon: a.icon ?? 'x.png' }, { type: a.type }, { subtype: a.subtype }],
      })),
    ],
  };
}

/** eXO shadow, trimmed from iaqualink-py's tests/systems/exo/test_system.py SAMPLE_DATA (+ its heating block). */
export function exoShadow() {
  return {
    state: {
      reported: {
        vr: 'V85W4',
        aws: { status: 'connected', timestamp: 123, session_id: 'xxxx' },
        equipment: {
          swc_0: {
            vr: 'V85R67',
            sn: 'xxxxx',
            amp: 1,
            vsp: 1,
            low: 0,
            swc: 50,
            temp: 1,
            lang: 2,
            ph_sp: 74,
            sns_1: { state: 1, value: 75, sensor_type: 'Ph' },
            aux_1: { type: 'none', mode: 0, color: 0, state: 0 },
            sns_2: { state: 1, value: 780, sensor_type: 'Orp' },
            sns_3: { state: 1, value: 29, sensor_type: 'Water temp' },
            aux_2: { type: 'none', mode: 0, state: 0, color: 0 },
            boost: 0,
            orp_sp: 830,
            aux230: 1,
            ph_only: 1,
            swc_low: 0,
            version: 'V1',
            exo_state: 1,
            dual_link: 1,
            production: 1,
            error_code: 0,
            boost_time: '24:00',
            filter_pump: { type: 1, state: 1 },
            error_state: 0,
          },
        },
        heating: { sp_min: 1, sp_max: 40, sp: 28, enabled: 0, state: 0 },
        // iaqualink-py master (eb1cf63) tests/systems/exo/fixtures/shadow_get.json
        // `schedules`, trimmed — except sch4, made a variable-speed pump
        // (vsp_2 + rpm) per dje2912/ha-iaqualink_exoiq@85bb2dd
        // systems/exo/system.py:315-322 so the rpm path has data.
        schedules: {
          sch1: { id: 'sch_1', name: 'Salt Water Chlorinator 1', timer: { end: '16:00', start: '10:00' }, active: 0, enabled: 1, endpoint: 'swc_1' },
          sch2: { id: 'sch_2', name: 'Salt Water Chlorinator 2', timer: { end: '00:00', start: '00:00' }, active: 0, enabled: 0, endpoint: 'swc_2' },
          sch3: { id: 'sch_3', name: 'Filter Pump 1', timer: { end: '18:00', start: '08:00' }, active: 1, enabled: 1, endpoint: 'ssp_1' },
          sch4: { id: 'sch_4', name: 'Filter Pump 2', timer: { end: '00:00', start: '00:00' }, active: 0, enabled: 0, endpoint: 'vsp_2', rpm: 1750 },
          sch9: { id: 'sch_9', name: 'Aux 1', timer: { end: '00:00', start: '00:00' }, active: 0, enabled: 0, endpoint: 'aux1' },
          supported: 6,
          programmed: 2,
        },
      },
    },
    deviceId: '123',
    ts: 123,
  };
}

export interface OneTouchState {
  status: string;
  state: string;
  label: string;
}

/**
 * OneTouch scenes — iaqualink-py master (eb1cf63) tests/systems/iaqua/fixtures/
 * session_get_onetouch.json, a capture from a real panel. Slot 4 is disabled
 * (`status: "0"`), which iaqualink-py drops.
 */
export const ONETOUCH: Record<string, OneTouchState> = {
  onetouch_1: { status: '1', state: '0', label: 'All OFF' },
  onetouch_2: { status: '1', state: '0', label: 'Spa Mode' },
  onetouch_3: { status: '1', state: '0', label: 'Clean Mode' },
  onetouch_4: { status: '0', state: '0', label: 'ONETOUCH 4' },
  onetouch_5: { status: '1', state: '0', label: 'OneTouch 5' },
  onetouch_6: { status: '1', state: '0', label: 'Water Falls' },
};

export function onetouchScreen(scenes: Record<string, OneTouchState>, opts: { status?: string } = {}) {
  return {
    message: '',
    onetouch_screen: [
      { status: opts.status ?? 'Online' },
      { response: "AQU='71','xx xx'" },
      ...Object.entries(scenes).map(([k, o]) => ({ [k]: [{ status: o.status }, { state: o.state }, { label: o.label }] })),
    ],
  };
}

/**
 * iQ20 schedules — the field list of iaqualink-py master (eb1cf63)
 * docs/reference/systems/iaqua.md:867-900 and the iAquaLink iOS app's
 * IQ20Equipment.m:70-95 (krishvios/iAquaLink-Mirror@50e4182). NOT a capture:
 * no live get_schedule_list response has been published.
 */
export const IQ20_SCHEDULES = [
  { id: 1, deviceId: 2, startHrs: 9, startMins: 0, stopHrs: 17, stopMins: 0, scheduleDays: 'AllDays', vspId: 0 },
  { id: 2, deviceId: 5, startHrs: 19, startMins: 30, stopHrs: 22, stopMins: 5, scheduleDays: 'Weekends', vspId: 0 },
];

/** get_master_device_list deviceList (iaqua.md:925-945). Device 5 is absent on purpose (unresolvable name). */
export const IQ20_MASTER_DEVICES = [
  { id: 1, name: 'Filter Pump', isVSP: 'false' },
  { id: 2, name: 'Pool Light', isVSP: 'false' },
  { id: 3, name: 'Cleaner', isVSP: 'false' },
];
