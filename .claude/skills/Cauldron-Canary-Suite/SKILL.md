This lifecycle canary document is the in-repo copy. XO/John is responsible for syncing the Windows-operator mirror at `~/.claude/skills/Cauldron-Canary-Suite/SKILL.md`.

## Run the LIFECYCLE canary (end-to-end wheel probe)

Unlike Level 0 `check` (static lane-routing probe, non-mutating) and the
`mechanisms` subcommand (static per-mechanism reachability, from PR #749), the
`lifecycle` canary type DRIVES ONE REAL THROWAWAY CHANGE through the entire
build wheel and grades every handoff by artifact:

```bash
ssh hetzner-prod "docker exec archon-app-1 sh -c 'cd /app && \
  bun run packages/canary-suite/src/cli.ts lifecycle \
  --api-base http://localhost:3090 \
  --codebase-id <bdc-harness codebase UUID, fetch via /api/codebases> \
  --run-id lifecycle-$(date +%Y%m%d-%H%M) \
  --output-root /tmp/canary-out'"
```

Report lands at `docs/evidence/lifecycle-canary-<date>.md` in bdc-harness
(committed by the run) and mirrored to `/tmp/canary-out/<run-id>/summary.md`
inside the container.

**This is a MUTATING run** (opens a real PR, may merge, posts a real dispatch
message) -- unlike `check`, do not run casually. Confirm no other canary or WO
is mid-flight on `dev` first (Section 7 Invariant 2 depends on branch isolation).

Ten legs graded: Taskmaster fire, codex-lane build+PR, Overseer catch-the-
planted-defect, remediation reaches PR, Overseer re-approve, autonomous merge,
reconcile closes issue, Dispatch delivers readable reply, DO reports the run
without flagging it stale, canary reverts itself. See
`WO-HARNESS-LIFECYCLE-CANARY-01` for the exact Given/When/Then and artifact
query per leg.

Known live gaps as of 2026-09-02 (re-verify, don't assume still true): Leg 1
(Taskmaster) blocks on bdc-xo#1843 (Taskmaster has never fired); Leg 4
(auto-remediation) blocks on bdc-xo#1835 (Overseer verdict does not yet reach
Taskmaster). Both legs fall back to a documented manual path rather than
failing the whole run.
