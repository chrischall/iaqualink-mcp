# CLAUDE.md — iaqualink-mcp

Fleet conventions (TDD, merge/label policy, release rules) live in
`~/.claude/CLAUDE.md` and chrischall/workflows — this file carries only what is
true of this repo.

- CI runs `npm run test:coverage` (typecheck of src AND tests, then vitest with
  a 100% threshold). Run that, not `npm test`, before calling anything green.
