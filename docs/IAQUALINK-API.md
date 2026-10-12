# iAqualink cloud API — what this server sends, and where each shape comes from

> **Live verification is PENDING.** No request below has been made with a real
> account yet. Every shape is transcribed from **iaqualink-py 0.7.0** (PyPI
> `iaqualink`, the client Home Assistant's iAqualink integration uses), its
> source and its test fixtures. The first real connect should confirm each one;
> update this file (and drop the "derived" notes in the skills, tool
> descriptions and README) as each is seen working.
>
> The one thing that HAS been checked live: `POST /users/v1/login` with the app
> key below and a deliberately fake `@example.com` account answered
> `401 {"message":"Authorization Required"}` — the endpoint and key are current,
> only the credential was wrong.

## Hosts

| Host | Used for |
| --- | --- |
| `prod.zodiac-io.com` | login, token refresh, eXO device shadow |
| `r-api.iaqualink.net` | system list (`devices.json`), iAqua command channel |
| `p-api.iaqualink.net` | alternate iAqua command channel — tried only by the iQ20 schedule probe |
| `prm.iaqualink.net` | WebTouch (RS panel emulation): `/v2/userId`, `/v2/users/<id>/locations`, `/v2/webtouch/{init,command}`, and the display stream; also the iOS app's iQ20 schedule host (`/v1`, probe only) |

Every request carries `user-agent: okhttp/3.14.7` and
`content-type: application/json` (iaqualink-py `client.py`
`AQUALINK_HTTP_HEADERS`). The app key is `EOOEMOW4YR6QNB07`
(`const.py` `AQUALINK_API_KEY`).

## Auth

### Login — `POST https://prod.zodiac-io.com/users/v1/login`

Body `{"api_key": "EOOEMOW4YR6QNB07", "email": "…", "password": "…"}`
(`client.py` `_send_login_request`). A 200 carries (`_apply_login_data`;
`tests/test_client.py` `LOGIN_DATA`):

```json
{
  "id": "<user id>",
  "authentication_token": "<token for devices.json>",
  "session_id": "<sessionID for session.json>",
  "userPoolOAuth": { "IdToken": "<JWT>", "RefreshToken": "<token>" }
}
```

A wrong credential is `401`. **This server never retries a rejected login**
and latches the refusal for the life of the process, so a bad password cannot
lock the account through repeated attempts.

### Refresh — `POST https://prod.zodiac-io.com/users/v1/refresh`

Body `{"email": "…", "refresh_token": "…"}` — **no `api_key`** (the library
comments that the refresh endpoint does not take one). Same response shape; if
it omits `RefreshToken` the previous one is kept. A `401` here falls back to one
full login (`_refresh_auth`). Refresh/login is single-flight: concurrent
callers share one attempt.

Any `401` on a data call → refresh once → replay once (`reauth.py`
`send_with_reauth_retry`). iaqualink-py also maps a `devices.json` `404` to
"unauthorized"; this server treats it the same way.

## Systems — `GET https://r-api.iaqualink.net/devices.json`

Query `api_key`, `authentication_token`, `user_id`. Answers an array
(`tests/systems/iaqua/test_system.py`):

```json
[{ "id": 123456, "serial_number": "SN123456", "name": "Pool", "device_type": "iaqua",
   "created_at": "…", "updated_at": "…", "owner_id": null, "updating": false,
   "firmware_version": null, "target_firmware_version": null,
   "update_firmware_start_at": null, "last_activity_at": null }]
```

`device_type` `iaqua` and `exo` are supported (`system.py` subclass registry);
anything else is listed as unsupported.

## iAqua (Jandy iAquaLink) — the command channel

`GET https://r-api.iaqualink.net/v2/mobile/session.json?<params>&actionID=command&command=<cmd>&serial=<serial>&sessionID=<session_id>`
with headers `Authorization: Bearer <IdToken>` and `api_key: EOOEMOW4YR6QNB07`
(`systems/iaqua/system.py` `_send_session_request`). Every command, read or
write, is a GET.

### `get_home` → `home_screen`

Rows 0-3 are `{status}` (`Online` / `Offline`), `{response}`, `{system_type}`
(an empty string means "not populated yet" — skip), `{temp_scale}` (`F`/`C`).
Every later row is one `{ "<device>": "<state>" }`. Device names used by the
library and its docs (`docs/guide/devices.md`): `pool_temp`, `spa_temp`,
`air_temp`, `pool_set_point`, `spa_set_point`, `pool_pump`, `spa_pump`,
`pool_heater`, `spa_heater`, `solar_heater`, `freeze_protection`, `*_present`.
States are strings: `0` off, `1` on, `2` standby, `3` enabled (heating),
`present`/`absent` (`device.py` `AqualinkState`). A temperature of `""` means
no reading. Rows whose value is an object/list are skipped by the library.

**Derived, not in the library:** the chemistry names this server groups
(`pool_salinity`, `spa_salinity`, `orp`, `ph`) and `cover_pool` /
`is_icl_present` in the test fixture come from public Home Assistant
diagnostics, not iaqualink-py — they are reported as-is and grouped only when
present.

### `get_devices` → `devices_screen`

Rows 0-2 are `{status}`, `{response}`, `{group}`; every later row is
`{ "aux_<n>": [ {"state"}, {"label"}, {"icon"}, {"type"}, {"subtype"} ] }`.
A `"NaN"` state anywhere means the panel has not reported — skip the update.
Classification (`IaquaDevice.from_data`): `type "2"` color light (by
`subtype` 1-6: Jandy Colors, Pentair SAm/SAL, Pentair ColorLogic, Jandy LED
WaterColors, Pentair Intellibrite, Hayward Universal — effect tables in
`src/iaqua.ts`), `type "1"` dimmable light (brightness = `subtype`), label
containing `LIGHT` → light switch, else aux switch. An aux is on only when its
state is `"1"`.

### Writes — all TOGGLES except set_temps / set_light

| Command | Params | Effect |
| --- | --- | --- |
| `set_pool_pump`, `set_spa_pump`, `set_pool_heater`, `set_spa_heater`, `set_solar_heater` | — | **toggles**; answers a `home_screen` |
| `set_aux_<n>` | — | **toggles** aux `n`; answers a `devices_screen` |
| `set_light` | `aux=<n>&light=<0/25/50/75/100>` | dimmable level (0 = off) |
| `set_light` | `aux=<n>&light=<effect id>&subtype=<subtype>` | color effect (0 = off) |
| `set_temps` | `temp1=…[&temp2=…]` | set points — **both in one request**: with a spa set point, `temp1` = spa and `temp2` = pool; without one, `temp1` = pool. The unrequested one is resent at its current value. |

Because the switches toggle, this server reads the current state first and
sends nothing when it already matches (`IaquaSwitch.turn_on/turn_off` does the
same), and binds the confirmation to that state. Ranges: °F 34-104, °C 1-40
(`IAQUA_TEMP_*`). The current color of a color light is not readable (the
library says so too), so an effect change is verified only by on/off.

## eXO (Zodiac salt chlorinator) — the device shadow

`GET https://prod.zodiac-io.com/devices/v1/<serial>/shadow` with header
`Authorization: <IdToken>` — **no `Bearer`** (`systems/exo/system.py`
`send_devices_request`). The answer (trimmed from
`tests/systems/exo/test_system.py` `SAMPLE_DATA`):

```json
{ "state": { "reported": {
    "aws": { "status": "connected" },
    "equipment": { "swc_0": {
      "production": 1, "boost": 0, "low": 0, "swc": 50, "swc_low": 0, "boost_time": "24:00",
      "ph_sp": 74, "orp_sp": 830, "error_code": 0, "error_state": 0,
      "sns_1": { "state": 1, "value": 75, "sensor_type": "Ph" },
      "sns_2": { "state": 1, "value": 780, "sensor_type": "Orp" },
      "sns_3": { "state": 1, "value": 29, "sensor_type": "Water temp" },
      "aux_1": { "type": "none", "mode": 0, "color": 0, "state": 0 },
      "filter_pump": { "type": 1, "state": 1 } } },
    "heating": { "enabled": 0, "sp": 28, "sp_min": 1, "sp_max": 40, "state": 0 } } } }
```

A sensor with `state: 0` has no reading. Units are Celsius only (the library
hard-codes it). pH appears scaled ×10 (75 beside a set point of 74) — reported
as-is.

### Writes — `POST` the same URL with `{"state":{"desired":{…}}}`

| What | `desired` | Source |
| --- | --- | --- |
| heating set point | `{"heating":{"sp":N}}` (within `sp_min`-`sp_max`) | `set_heating` |
| heating on/off | `{"heating":{"enabled":0/1}}` | `ExoThermostat.turn_on/off` |
| aux `n` | `{"equipment":{"swc_0":{"aux_n":{"state":0/1}}}}` | `set_aux` |
| production / boost / low | `{"equipment":{"swc_0":{"<name>":0/1}}}` | `set_toggle` |
| filter pump | `{"equipment":{"swc_0":{"filter_pump":{"state":0/1}}}}` | `set_filter_pump` |
| **chlorinator output %** | `{"equipment":{"swc_0":{"swc":N}}}` | **NOT in iaqualink-py** — inferred from the reported `swc` field and the `set_toggle` shape. Verified only by the re-read. |

The device applies desired state asynchronously, so a write is proven only by
a later `reported` read; this server re-reads (every 10 s, up to 30 s) and
reports `sent-unconfirmed` rather than failing when it has not landed yet.

## WebTouch (AquaLink RS panel emulation)

**Source: live capture 2026-10-11 on an RS panel (v1.5-RS)** — a real
create → save → verify → delete → verify round-trip on the owner's panel, plus
the page's client script `netlink.js` (element table `nl_element[screen]`,
`printNL` 1688-2430) and ejc3/iaqualink-webtouch@42c4d65
(`src/iaqualink_webtouch/client.py:100-163`, `parser.py`). This is the only
cloud route to an RS panel's own programs and OneTouch scenes.

### Bootstrap (ejc3 client.py:100-163, matches the capture)

1. `GET https://prm.iaqualink.net/v2/userId` — `Authorization: Bearer <IdToken>`
   (the login's `userPoolOAuth.IdToken`) → `{session_user_id}`.
2. `GET https://prm.iaqualink.net/v2/users/<session_user_id>/locations` —
   same header → a list (or `{locations: […]}`); pick the entry whose
   `serial_number` (or `serial`) is the system's, take its `touchLink`
   (or `touch_link`).
3. `GET https://prm.iaqualink.net/v2/webtouch/init?actionID=<touchLink>` —
   `Authorization: <IdToken>` (bare) → `{label, serverConnection,
   actionIdMasterId, actionIdMasterStart, actionIdMasterSTB,
   actionIdMasteReset, systemType}`.
4. `GET <serverConnection>` — the display stream, unauthenticated, held open.
   **Its host is not recorded in the capture**; this server allows only
   `https://prm.iaqualink.net` unless `IAQUALINK_WEBTOUCH_STREAM_HOSTS` adds
   one, and refuses anything else before connecting.
5. Start-up press: `command=1` on `actionIdMasterStart` (netlink.js:2925 does
   this 2.5 s after load); the panel then paints its current screen.

### Commands

`POST https://prm.iaqualink.net/v2/webtouch/command`, `Authorization: <IdToken>`,
JSON `{"actionID": "<actionIdMasterId>", "command": "<n>", "dt": "<ms>"}` →
`200` with an empty body; the panel answers on the stream. Keypad Enter is
`{"actionID": "<actionIdMasterSTB>", "command": "128", "text": "hh:mm", "dt": …}`
— 12-hour text with the colon, as shown in the box (e.g. `"03:00"`).

| Screen | Id | Commands |
| --- | --- | --- |
| bottom bar | any | 1 Home (also dialog Ok / button 1) · 2 Menu (dialog Cancel / button 2) · 3 OneTouch · 5 Back |
| Home | 1 | equipment buttons 17 + idx; 24 Other Devices |
| Menu | 15 | 17 Schedule |
| Schedule list | 40 | 17 Add · 18 Edit toggle · 19 Delete · 20 PageDown · 21 PageUp · 22 Save · 23–32 run days (All, M, Tu, W, Th, F, Sa, Su, Wkdays, Wkends = button idx 6–15) · 33 Start Time · 34 Stop Time · 35–41 rows 1–7 (34 + row) |
| Time keypad | 41 | 17 AM/PM toggle; Enter = 128 + text |
| Device picker | 56 | 17 PageUp · 18 PageDown · 19 Select · 20–26 rows 1–7 (19 + row) |
| OneTouch | 77 | 17 + idx toggles scene idx 0–5 |

Dynamic buttons (code 24) send `17 + idx` (netlink.js:1738); static ones carry
their command in `nl_element` field 7.

### The stream

Chunks of `<script type='text/javascript'>parent.printNL('<code>','<a||b||c>')</script>`.
Both arguments are JS string literals (`\t` separates row columns). They are
parsed with a strict regex and decoded escape-by-escape — never evaluated.
In the table, `‖` stands for the literal `||` separator.

| Code | Params | Meaning |
| --- | --- | --- |
| `23` | `<id>` | screen id (state resets when it changes) |
| `24` | `idx‖state‖img‖label‖stateText` | button; on screen 40 idx 1 is Edit (`1` = on), idx 6–15 run days; on 77 idx 0–5 scenes (`ON`/`OFF`) |
| `25` | `idx‖text` | text field — keypad `1‖02:00` (time), `2‖PM` (meridiem) |
| `26` | `0‖row‖Circuit\tStart\tStop\tDays` | list row (screen 40: rows 1–7; 56: row 0 is a header) |
| `28` | `M‖D‖YY‖H‖M` | clock (ignored) |
| `2C` | `type‖buttons‖message‖btn1‖btn2` | dialog; a blank message closes it |
| `2D` | text | title |
| `40` | `0‖row‖1/0` | row selected / deselected |

### Flows (as captured, and as this server presses them)

- **List** — Menu (2) → screen 15 → Schedule (17) → screen 40; rows 1–7; while
  a page is full, PageDown (20) and stop when the rows do not change; Home (1).
  Paging past the first page was **not** captured.
- **Add** — Add (17) → screen 56; find the circuit label across picker pages
  (PageDown 18), press its row (19 + row), Select (19) → back on 40 with the new
  row appended, selected, Edit ON, defaulting to 1:00 PM–1:00 PM All; Start
  Time (33) → 41, AM/PM (17) until it matches, Enter (128 text); Stop Time
  (34) likewise; the run-day button (23–32); Save (22) → Edit off.
  *Not in the capture:* whether the picker echoes a row selection (code 40) —
  this server waits for one and aborts if it never comes.
- **Edit** — select the row (34 + row), Edit (18), then times/days, Save (22).
  Edit-mode entry and the keypad were captured; editing an *existing* row's
  times end-to-end was not (only on the added row).
- **Delete** — select the row, Delete (19) → dialog `3‖1‖Are you sure you want
  to delete this program?.‖Ok‖Cancel` → Ok (1). Persists **without** Save.
- **OneTouch** — OneTouch (3) → screen 77, scenes from code 24. The toggle
  (17 + idx) was **not** pressed in the capture.
- **Edit-mode guard** — leaving screen 40 with Edit on shows "Program changes
  must be saved before exiting this screen."; turning Edit off with changes
  shows "Press SAVE to store program changes." A Save with nothing entered is a
  no-op (owner-verified), so after an abort before any entry this server
  presses Save to leave Edit mode, then Home. With entries made it does NOT
  save or discard — it reports the panel as left in Edit mode with unsaved
  changes. It never touches a panel that is already in Edit mode when the
  session starts.

### OneTouch over session.json — removed

iaqualink-py master (`systems/iaqua/system.py:150-151,465-513`) reads
`command=get_onetouch` and toggles `set_onetouch_<n>`, but its own notes
(`docs/reference/systems/iaqua.md:1293`) say `set_onetouch` was never seen in
protocol analysis. This server now uses WebTouch for OneTouch only.

## Schedules

### iQ20 (iAqua) — fallback, read only, UNVERIFIED live

Used only when WebTouch is unavailable for the system.

Only adapters with `attached_system_fw_version` ≥ 3 (top-level in `get_home`)
have them — the app hides Schedules otherwise
(krishvios/iAquaLink-Mirror@50e4182 `Shared/Shared/Models/IQ20Device.m:19,119`,
`iAqualink/.../IQ20CogMenuVC.m:67-73`). An **AquaLink RS panel's own
built-in programs are a different thing that no cloud API reaches.**

- List: `command=get_schedule_list&pageNum=1` →
  `{is_error, count, totalCount, pageNum, isNewScheduleAllowed, scheduleList:[{id, deviceId, startHrs, startMins, stopHrs, stopMins, scheduleDays, vspId}]}`
  (`Shared/Shared/Managers/IQ20ApiManager.m:197-231`,
  `Shared/Shared/Models/IQ20Equipment.m:70-95`; iaqualink-py master
  `docs/reference/systems/iaqua.md:867-900`). Only page 1 is read; the result
  shows `count` and `totalCount`.
- Device names: `command=get_master_device_list&listType=1&pageNum=1` →
  `deviceList:[{id, name, isVSP}]` (`IQ20ApiManager.m:232-262`;
  `iaqua.md:925-945`).
- Days: the app's picker sends `AllDays`, `Weekdays`, `Weekends` or a weekday
  name (`IQ20ScheduleSetupViewController.m:106`) — but LOCALIZED; iaqualink-py
  writes "All Days". Unconfirmed.
- Writes (`do_schedule_operation&operation=Add|Edit|Delete…`,
  `IQ20ApiManager.m:151-195`; `iaqua.md:902-919`) are **not built** — on hold.

**Which host serves them is unknown.** The sources disagree:

| Probe order | Endpoint | Authorization | Source |
| --- | --- | --- | --- |
| 1 | `r-api.iaqualink.net/v2/mobile/session.json` | `Bearer <IdToken>` | this server's channel (iaqualink-py 0.7.0) |
| 2 | `p-api.iaqualink.net/v2/mobile/session.json` | `Bearer <IdToken>` | iaqualink-py master `system.py:45,129-131` |
| 3 | `p-api.iaqualink.net/v2/mobile/session.json` | `<IdToken>` (bare) | iaqualink-py master `docs/reference/systems/iaqua.md:19-27` |
| 4 | `prm.iaqualink.net/v1/mobile/session.json` | `<IdToken>` (bare) | iOS app `Environment.m:313-327`, `AuthenticatedConnection.m:60-63` |

All carry `api_key` and `sessionID`. `iaqualink_list_schedules` tries them in
that order (the one that last answered goes first), each once, stopping at the
first body with a `scheduleList`; a 429 or a refused sign-in stops the probe.
A 401 from endpoints 2-4 is recorded, never answered with a re-login. The
result's `probe` names the endpoint that answered and every attempt's
(token-scrubbed) body — that is the live check.

### eXO timers — UNVERIFIED live

Read from the shadow: `state.reported.schedules.schN` =
`{id, name, endpoint, enabled, active, timer:{start, end}, rpm?}` plus
`supported` / `programmed` counters (iaqualink-py master
`tests/systems/exo/fixtures/shadow_get.json`;
dje2912/ha-iaqualink_exoiq@85bb2dd `systems/exo/system.py:287-340`).

Write: `POST` shadow `{"state":{"desired":{"schedules":{"schN":{"enabled":1,"timer":{"start":"HH:MM","end":"HH:MM"},"rpm":N}}}}}`
— `rpm` only for `vsp_*` endpoints (benjycov/exo_pool@64b8806 `api.py:1173-1219`,
`759-767`; dje2912 `system.py:514-548`). Disable =
`{"enabled":0,"timer":{"start":"00:00","end":"00:00"}}` (dje2912
`system.py:913-946`). A chlorinator timer `swc_N` must be inside, and may only
be enabled with, the same-index pump timer `vsp_N` / `ssp_N` (dje2912
`system.py:780-836, 868-895`; endpoint pairing in `timer_helpers.py:6-23`);
this server refuses writes that break that.

## Rate limiting

iaqualink-py retries `429` with backoff honouring `Retry-After` and enforces a
minimum refresh interval (5 s iAqua; **50 s eXO — "eXO systems returned HTTP
429 when polled every 15s"**). This server serializes requests, retries a `429`
twice (Retry-After capped at 10 s), caches a status read for
`IAQUALINK_STATUS_CACHE_SECONDS` (default 5), and polls an eXO no faster than
every 10 s while verifying a write.
