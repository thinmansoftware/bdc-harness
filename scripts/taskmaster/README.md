# Taskmaster operator scripts

One-shot / operator-run scripts for the Taskmaster subsystem. These are NOT run
by the loop; they are deliberate operator actions.

## `expire-xo-deadletter.ts`

Retires the backlog of queued, never-addressed `recipient='xo'` Taskmaster
messages left behind by the pre-M-155 noise stream (~920 rows that no reader
ever drained).

Authority: `WO-HARNESS-TASKMASTER-EXCEPTION-PUSH-01` (M-155 WO 3), ruling
`M-20260817-155-RULING.md`.

### What it does

- Matches `status='queued' AND addressed_at IS NULL AND sender='taskmaster'`
  where the recipient normalizes to `xo` (via `LOWER(BTRIM(recipient)) = 'xo'`,
  the same identity normalization migration 040 applies).
- On `--confirm`, marks each matched row addressed
  (`addressed_at = now`, `addressed_by = 'taskmaster:m155-deadletter'`) so the
  audit trail cites M-155. It writes nothing to GitHub and never touches
  `tm_control` (no un-pause).

### Usage

```bash
# Dry run -- prints the count that WOULD be expired, writes nothing (DEFAULT):
bun run scripts/taskmaster/expire-xo-deadletter.ts

# Actually expire the backlog (requires the explicit flag):
bun run scripts/taskmaster/expire-xo-deadletter.ts --confirm
```

The script reads `DATABASE_URL` (PostgreSQL in production) exactly like the app.
The `LOWER(BTRIM(...))` predicate requires PostgreSQL, which is the production
target on `archon-app-1`.

### When to run

Once, at Deploy 2 (M-155 gate G9/G10), AFTER this WO merges to `dev` and the
image is rebuilt. Do NOT run it on a schedule and do NOT wire it into the loop.
Un-pause of the Taskmaster loop is a separate operator action at gate G11.
