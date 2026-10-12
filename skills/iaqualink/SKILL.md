---
name: iaqualink
description: Check and control an iAqualink (Zodiac / Jandy iAquaLink / Fluidra) pool or spa through the iaqualink-mcp tools — pool, spa and air temperatures, heater set points, pumps, heaters, lights, aux circuits (cleaner, waterfall, bubbler), salt chlorinator output, salinity, pH and ORP, schedules/timers and OneTouch scenes. Use when the user asks "what's the pool temperature", "is the pool pump running", "turn on the spa", "heat the spa to 102", "turn on the pool lights", "set the pool light to Caribbean Blue", "boost the chlorinator", "what are the pool schedules", "run Spa Mode", or anything about their iAqualink / iAquaLink / eXO system.
---

# iAqualink (iaqualink-mcp)

Tools for the user's own iAqualink pool/spa systems. Two system types are
supported: **iAqua** (Jandy iAquaLink panels — pumps, heaters, set points, aux
circuits, lights) and **eXO** (Zodiac salt chlorinators — chlorine production,
boost, low mode, filter pump, heating, pH/ORP). Other devices on the account
(robotic cleaners) are listed but not controlled.

> Built from the open-source iaqualink-py client; live verification against a
> real pool is pending. If a write comes back `sent-unconfirmed`, say so
> plainly rather than claiming it worked.

## Start here

1. `iaqualink_list_systems` → serials and types. Most homes have one system;
   use its serial everywhere else.
2. `iaqualink_get_status { serial }` → temperatures, set points, equipment
   states (`off` / `on` / `standby` / `enabled` = heating), aux circuits with
   labels, lights, and chlorinator/chemistry where present. `view: "full"`
   adds light effect lists and the raw entries; `view: "raw"` is iAqualink's
   own response.
3. `iaqualink_healthcheck` when something fails: it says whether a sign-in is
   configured and whether iAqualink accepted it.

Readings are in the system's own unit (`unit`: `F` or `C`; eXO is always °C).
An empty reading (`null`) means the sensor has nothing to report — e.g. the spa
temperature while the spa pump is off.

## Changing things

| Want | Tool |
| --- | --- |
| pump / heater / solar on-off; eXO filter pump, production, boost, low, heating | `iaqualink_set_equipment { serial, equipment, on }` |
| an aux circuit or light on/off (by number, `aux_3`, or its label) | `iaqualink_set_aux { serial, aux, on }` |
| dimmable light level (0/25/50/75/100) or color effect | `iaqualink_set_light { serial, aux, brightness \| effect }` |
| pool and/or spa target temperature | `iaqualink_set_temperature { serial, pool?, spa? }` |
| eXO chlorinator output % | `iaqualink_set_chlorinator { serial, percent }` |
| run / stop a OneTouch scene (iAqua) | `iaqualink_set_onetouch { serial, onetouch, on }` |
| change or disable an eXO timer | `iaqualink_set_schedule { serial, schedule, start, stop, rpm?, enabled? }` |

Every write:

- **Checks first.** If the equipment is already in the requested state it
  returns `status: "unchanged"` and sends nothing.
- **Asks for confirmation.** On clients without a prompt the first call returns
  a `confirmation-required` preview and a `confirmToken`; show the preview to
  the user, get their explicit yes in chat, then repeat the call with the
  token. If the pool's state changed in between, the token is refused
  (`DRAFT_CHANGED`) with a fresh preview — show that one instead.
- **Verifies.** `confirmed` means a re-read shows the change. `sent-unconfirmed`
  means iAqualink accepted it but the re-read did not show it yet — eXO systems
  apply changes asynchronously; tell the user and check `iaqualink_get_status`
  again later. **Do not blindly retry**: iAqua pump/heater/aux commands are
  toggles.

Notes:

- Turning a heater **on** lets it heat to the set point; changing the set point
  alone does not turn the heater on.
- A color light's current color cannot be read back, so an effect change is
  confirmed only by the light being on.
- `iaqualink_set_chlorinator` uses an inferred request shape (not in the
  reference client) — trust it only when the result is `confirmed`.

## Schedules and scenes

- `iaqualink_list_schedules { serial }` — eXO: pump / chlorinator / aux timers.
  iAqua: iQ20 schedules only (adapter firmware 3+). `supported: false` comes
  with the reason. An **AquaLink RS panel's own programs cannot be read or
  changed** through these tools — say so rather than guessing. On iAqua the
  result's `probe` shows which iAqualink host answered; pass it on verbatim
  if the user is debugging.
- iAqua schedules cannot be changed here. eXO timers can
  (`iaqualink_set_schedule`); a chlorinator timer must sit inside its pump
  timer's window, and `enabled: false` clears a timer.
- `iaqualink_list_onetouch` / `iaqualink_set_onetouch` — the panel's
  one-button scenes ("Spa Mode", "All OFF"). Scene switching is a toggle and
  is unverified live: report `sent-unconfirmed` honestly.

## Trouble

- `no_credential` → the user needs to set `IAQUALINK_EMAIL` /
  `IAQUALINK_PASSWORD` (or reconnect the hosted connector).
- `credential_rejected` → the email/password is wrong. The server will **not**
  retry it (so the account cannot be locked); the user must fix it and restart
  or reconnect.
- Rate limited → wait a minute; eXO systems in particular dislike fast polling.
- System `online: false` → the panel is offline from iAqualink's cloud; nothing
  can be controlled until it reconnects.
