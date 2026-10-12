# iaqualink-mcp

MCP server for **iAqualink** (Zodiac / Jandy / Fluidra) pool and spa equipment.
Read temperatures, set points, pumps, heaters, lights, aux circuits and salt
chlorinator state, and switch equipment — every change confirmation-gated and
verified by a re-read. It signs in with your own iAqualink account (the same
email and password as the iAqualink app); no browser, extension or bridge.

Supports the two system types the reference client supports: **iAqua**
(Jandy iAquaLink panels) and **eXO** (Zodiac salt chlorinators). Other device
types on the account (robotic cleaners, …) are listed but not controlled.

> **Status: built from the open-source client, live verification pending.**
> Every request shape is transcribed from
> [iaqualink-py](https://pypi.org/project/iaqualink/) 0.7.0 (what Home
> Assistant uses) — see [docs/IAQUALINK-API.md](docs/IAQUALINK-API.md) — and has
> not yet been exercised against a real pool. The login endpoint and app key
> are confirmed live.

This project was developed and is maintained by AI (Claude Code). Use at your
own discretion.

## Tools

| Tool | What it does | Annotation |
| --- | --- | --- |
| `iaqualink_list_systems` | Systems on the account and their serials | read |
| `iaqualink_get_status` | Temperatures, set points, pumps, heaters, aux/lights, chlorinator, salinity/pH/ORP (`view`: compact · full · raw) | read |
| `iaqualink_healthcheck` | Whether a sign-in is configured and accepted | read |
| `iaqualink_set_equipment` | Pool/spa pump, pool/spa/solar heater; eXO filter pump, production, boost, low, heating — on/off | write, not destructive |
| `iaqualink_set_aux` | Aux circuit or light on/off (by number, `aux_<n>` or label) | write, not destructive |
| `iaqualink_set_light` | Dimmable brightness (0/25/50/75/100) or color effect (iAqua) | write, not destructive |
| `iaqualink_set_temperature` | Pool and/or spa set point (iAqua °F/°C; eXO °C pool) | write, not destructive |
| `iaqualink_set_chlorinator` | eXO chlorinator output % — **inferred shape, not in iaqualink-py** | write, not destructive |
| `iaqualink_list_schedules` | RS panel programs via WebTouch (iAqua; iQ20 fallback probe); eXO timers | read |
| `iaqualink_add_schedule` | Add an RS panel program (circuit, start, stop, run days) via WebTouch | write, not destructive |
| `iaqualink_edit_schedule` | Change an RS panel program's start / stop / run days via WebTouch | write, not destructive |
| `iaqualink_delete_schedule` | Delete an RS panel program via WebTouch — **no undo** | write, **destructive** |
| `iaqualink_set_schedule` | Set / re-time / disable an eXO timer (start–stop, rpm on variable-speed pumps) — **eXO only, unverified live** | write, not destructive |
| `iaqualink_list_onetouch` | RS panel OneTouch scenes (Spa Mode, All OFF, …) and their state, via WebTouch | read |
| `iaqualink_set_onetouch` | Turn a OneTouch scene on/off via WebTouch — **toggle not exercised live yet** | write, not destructive |

Every write has an inverse in this set and reaches no other person — except
deleting a panel program, which the panel stores immediately with no undo, so
that one is marked destructive.

**Schedules and OneTouch on a Jandy AquaLink RS panel** go through
**WebTouch**, the panel emulation the iAqualink web app uses: the server opens
the panel's display stream, presses the same buttons a person would (checking
before every press that the panel is on the expected screen and row, and
aborting otherwise), returns to Home, and re-reads to verify. Only one WebTouch
session per system runs at a time. The add / edit / delete sequences follow a
live capture on an RS panel (2026-10-11) — see
[docs/IAQUALINK-API.md](docs/IAQUALINK-API.md#webtouch-aqualink-rs-panel-emulation).
If WebTouch is unavailable, `iaqualink_list_schedules` falls back to iQ20
schedules (adapter firmware 3+), probing `r-api.iaqualink.net/v2` (Bearer),
`p-api.iaqualink.net/v2` (Bearer), `p-api.iaqualink.net/v2` (bare token) and
`prm.iaqualink.net/v1` (bare token) once each and reporting every attempt.
iQ20 schedule *writes* are not built.

**How a write works.** It reads the current state first and sends nothing if
it already matches — iAqua's pump/heater/aux commands are *toggles*, so a blind
send would flip whatever the state happened to be. It then asks you to confirm
(an elicitation prompt where the client supports one; otherwise a preview plus
a `confirmToken`, bound to the state it was planned against), sends, and
re-reads until the requested value shows up. The result is `confirmed`,
`unchanged`, or `sent-unconfirmed` with what was observed (eXO applies changes
asynchronously — check again rather than retrying).

## Setup

```sh
npm i -g @chrischall/iaqualink-mcp
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `IAQUALINK_EMAIL` | for every tool | Your iAqualink app sign-in email |
| `IAQUALINK_PASSWORD` | for every tool | Your iAqualink password (not trimmed) |
| `IAQUALINK_STATUS_CACHE_SECONDS` | no | Seconds a status read is reused (default 5; 0 disables) |
| `IAQUALINK_WEBTOUCH_STREAM_HOSTS` | no | Extra hosts (comma-separated) the WebTouch display stream may come from; default only `prm.iaqualink.net` |
| `MCP_CONFIRM_MODE` | no | `ask-user` (default) / `auto` / `refuse` |
| `MCP_CONFIRM_TTL_SECONDS` | no | confirmToken lifetime (default 600) |
| `MCP_CONFIRM_ELICITATION` | no | `off` skips the prompt even on clients that declare elicitation |

The server starts without credentials (so hosts can list its tools) and
reports them missing on the first call. **A rejected password is never
retried**: the refusal is remembered until the server restarts, so a typo
cannot lock the account.

Claude Code: `claude mcp add iaqualink -e IAQUALINK_EMAIL=… -e IAQUALINK_PASSWORD=… -- npx -y @chrischall/iaqualink-mcp`

### Hosted (claude.ai)

`mint.yaml` declares per-user children with an email/password form on the
connector's authorize page (each person signs in as themselves), egress to
exactly `prod.zodiac-io.com`, `r-api.iaqualink.net`, `p-api.iaqualink.net`
(iQ20 probe only) and `prm.iaqualink.net` (WebTouch, and the iQ20 probe); the
WebTouch display stream is refused on any other host unless it is added to
`IAQUALINK_WEBTOUCH_STREAM_HOSTS` (and egress). No persistent
state — the session lives in memory and one sign-in rebuilds it after a cold
start.

## Skills

- `skills/iaqualink` — how to use these tools.
- `skills/iaqualink-curl` — the same reads straight from a shell with `curl`,
  credentials from the macOS Keychain (derived from iaqualink-py; live
  verification pending).

## Development

```sh
npm install
npm run build
npm run test:coverage   # typecheck (src + tests) + vitest, 100% coverage — what CI runs
```

Tests run the real client against an in-memory iAqualink
(`tests/support/fake-server.ts`) built from iaqualink-py's fixtures.
