# CLAUDE.md — iaqualink-mcp

Fleet conventions (TDD, merge/label policy, release rules) live in
`~/.claude/CLAUDE.md` and chrischall/workflows — this file carries only what is
true of this repo.

- CI runs `npm run test:coverage` (typecheck of src AND tests via
  `tsconfig.test.json`, then vitest with a 100% threshold). Run that, not
  `npm test`, before calling anything green.
- Request shapes are DERIVED from iaqualink-py 0.7.0. Login, devices.json, the
  iAqua reads and WebTouch are seen live; the iAqua `set_*` commands and all
  eXO requests are not yet (`docs/IAQUALINK-API.md`). When a shape is confirmed against a real
  account, flip the claim tree-wide: `grep -rniE "verif|derived|inferred"
  README.md docs/ skills/ src/`.
- Never auto-retry a login: `src/client.ts` latches a rejected password for the
  life of the process so repeated attempts cannot lock the account. Keep it.
- iAqua pump/heater/aux commands are TOGGLES. Writes must read the current
  state, send only on a difference, and bind the confirm token's `revision` to
  that state (`src/tools/control.ts`).
- Tests drive the real client against `tests/support/fake-server.ts` (an
  in-memory iAqualink built from iaqualink-py's fixtures) — extend the fake
  rather than mocking the client.
- `mint.yaml` egress must equal the hosts of the URL constants in
  `src/client.ts`; `tests/mint.test.ts` enforces it.
