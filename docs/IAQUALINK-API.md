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

## Rate limiting

iaqualink-py retries `429` with backoff honouring `Retry-After` and enforces a
minimum refresh interval (5 s iAqua; **50 s eXO — "eXO systems returned HTTP
429 when polled every 15s"**). This server serializes requests, retries a `429`
twice (Retry-After capped at 10 s), caches a status read for
`IAQUALINK_STATUS_CACHE_SECONDS` (default 5), and polls an eXO no faster than
every 10 s while verifying a write.
