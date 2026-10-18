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

Legacy reconciliation may establish a historical accounting day only from an
exact journal/action/thread/cascade/WO/project match, a non-dry-run terminal
cascade, real child identifiers and complete, valid attempt timestamps. Record
creation and the first attempt must bound admission within the same UTC day;
otherwise its day remains ambiguous and held. The legacy record creation time
is the historical accounting anchor, not a newly verified permission instant.
The ledger then counts the proven admission on that bounded day and
keeps its `legacy-reconciliation` owner; no automatic permission provenance is
invented, the original cascade is not rewritten, and legacy journal supervision
deadlines are preserved. A terminal journal outcome alone is insufficient.
Missing records, running/incomplete attempts, identity/time conflicts and genuine
post-permission unknowns remain held across UTC days; there is no blanket expiry.

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

The server cap suite includes the migration regression: seed two proven legacy
admissions, reconcile, reopen the real temporary SQLite database, advance one UTC
day and admit exactly two new reservations. Negative controls cover missing or
conflicting identity, malformed/future times, absent child/completion evidence,
old pending history and genuine lost post-permission provenance. All external
cascade effects in this suite are injected fakes. Temporary SQLite references
are dropped before final collection/cleanup on Windows.

### Windows cleanup diagnostic boundary

At source7572a409, hosted Windows job117780463435 failed with EBUSY while
removing the proved legacy case's owned temporary directory. Its Taskmaster
group reported357pass/1fail/1416assertions. The same unmodified grouped command
passed locally358/0/1416 before A4 changes; local Bun1.3.13 differs from hosted
1.3.11. Neither that difference nor a missing yield is a proven root cause.
The subsequent A4 four-file cap run reproduced the real EBUSY locally:
158pass/1fail/810assertions. Its non-synthetic diagnostic found only the SQLite
db/wal/shm files remaining, after recorder artifacts had been removed. The
retaining adapter/native handle is still unknown; the version difference alone
cannot explain a failure now observed under local1.3.13 as well.

A4 adds failure-only metadata collection, not a cleanup repair. It preserves
the existing close/reference/yield/GC ordering and rm retry/time bounds. Upon
the original removal error it reports at most eight root-entry classifications
(db/wal/shm/recorder/other), kinds and byte lengths, runtime and fixed stage/error
metadata. It reads no contents, follows no symlinks and reports no raw paths or
stacks. Inspection/reporting failure cannot replace the original cleanup error;
the test still fails. A synthetic diagnostic control validates bounds and exact
error preservation; it is not a reproduction of the hosted lock. A later hosted
pass alone must not be described as a root-cause repair.

A6 eliminated the memory/file confound with a separate raw file/WAL control:
both finalized old and reopened connections closed strictly without error. The
adapter control then failed strict close with its own control statement already
finalized and no open transaction. Routing twenty unfinalized metadata SELECT/
PRAGMA reads through the existing `pragmaAll` finalization helper made the same
adapter control pass; deliberately pending caller-owned statements still report
in-use and remain usable. This supports the metadata-statement lifetime cause
collectively, not attribution to one uniquely identified statement.

Only resource finalization changed. Former single-row reads retain the first
row or native null-on-absence result. All351 literal values/order and all93
write/cached-query calls/order are identical; `query`, `pragmaAll` and `close`
implementations are byte-identical. Ordinary close/reopen/cleanup retains its
ordering, method, retry/time bounds and assertions, without strict-close calls.
Local cap Stop1 passed161/0/840assertions and the Taskmaster group361/0/1461.
Seven existing SQLite/schema/dispatch suites passed251 applicable tests with
1106assertions; one unchanged Windows skip covers dangling symlink aliases.
Fresh hosted Windows/PG/CI, independent review and runtime approval remain
required; no deployed behavior or registry correction follows from local proof.

## Publication and rollout

Migration `063_tm_fire_admissions.sql` is additive PostgreSQL DDL; SQLite has an
equivalent additive bootstrap table. Existing journal rows and unrelated work are
preserved. Source review and both dialect tests precede acceptance. A separate
exact-image production motion, protected backup, rollback and health evidence are
still required before runtime publication. Do not change a live cap/config value,
pause/resume Taskmaster, fire a workflow, remove foundation holds or perform the
registry correction from this source-build scope. A reviewed source revert is
the source rollback; never drop admission history or restore a whole live DB.
