# Taskmaster automatic-fire daily cap

Source repair for bdc-xo#2002, WO-HARNESS-TASKMASTER-DAILY-FIRE-CAP-01.
The ordinary attended source-build scope is recorded in bdc-xo#2002 comment
6250714249. This document does not authorize runtime publication or #3089.

`TASKMASTER_FIRE_MAX_PER_DAY` defaults to 2 accepted automatic cascade
admissions per UTC day. Zero disables new automatic fires. Invalid, negative,
fractional or unsafe integer values fail closed. The existing three-per-tick
ceiling remains an additional bound. Manual cascade callers are unchanged.

The journal row precedes a durable reservation in `tm_fire_admissions`.
SQLite uses the existing serialized BEGIN IMMEDIATE helper; PostgreSQL pins
one transaction connection and locks the existing singleton `tm_control` row.
An owned reservation grants at most one invocation. After asynchronous lane
preflight, the cascade awaits the budget guard. The guard samples its clock
after acquiring the DB lock, rechecks UTC day and current pause/epoch, and
commits conservative permission before a durable cascade admission or effect.

A lost result remains unknown and consumes capacity. There is no timeout refund.
Only a reservation that never committed permission, or a durable zero-attempt
refusal/dry-run, can release capacity. Later build failure does not refund an
accepted fire. Restart reconciliation covers all unresolved ledger identities,
including those older than the message journal lookback. Missing or conflicting
history withholds new fires; legacy unknowns are not relabelled as verified.

The cascade record carries source, journal/action/thread, UTC admission day and
permission timestamp. Actual workflow identities come from `attempts[].runId`.
The ledger and pending expectation follow those child IDs; a cascade ID is never
used as a workflow row ID, and WO text matching is not admission evidence.

## Verification

From a clean checkout with existing dependencies:

```text
bun test packages/server/src/taskmaster/daily-fire-cap.test.ts packages/core/src/db/taskmaster-fire-cap.test.ts packages/server/src/taskmaster/loop.test.ts packages/server/src/taskmaster/fire-eligibility.test.ts
bun test packages/core/src/db/taskmaster-fire-cap.postgres.test.ts
bun run type-check
git diff --check
```

The PostgreSQL suite requires the existing `TASKMASTER_POSTGRES_TEST_URL`
fixture, restricted to a loopback `/phase15` or `_test` database. It creates and
removes only its random schema and uses independent real adapter pools. It fails
before connecting if the fixture is absent or outside that boundary. The existing
`dispatch-phase15-postgres` CI job supplies the disposable PG17 fixture. Missing,
failed or skipped dialect proof is BLOCKED, not success. Never substitute a live
database, guess a login, or install dependencies to manufacture acceptance.

The SQLite suite also invokes `taskmaster-fire-cap-race.fixture.ts` with Bun to
race two real OS processes against one remaining slot. The fixture accepts only
the suite's `tm-cap-*` temporary-directory `test.db` and synthetic request JSON;
it is not a builder, provider runner or operational database command.

## Publication and rollout

Migration `063_tm_fire_admissions.sql` is additive PostgreSQL DDL; SQLite has an
equivalent additive bootstrap table. Existing journal rows and unrelated work are
preserved. Source review and both dialect tests precede acceptance. A separate
exact-image production motion, protected backup, rollback and health evidence are
still required before runtime publication. Do not change a live cap/config value,
pause/resume Taskmaster, fire a workflow, remove foundation holds or perform the
registry correction from this source-build scope. A reviewed source revert is
the source rollback; never drop admission history or restore a whole live DB.
