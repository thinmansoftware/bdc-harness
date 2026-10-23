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
Only the active owner's reservation that never committed permission can release
capacity. A definitive refusal/dry-run observed before the awaited permission
guard uses that owned release path. A pre-existing zero-attempt record alone is
not proof that a later permission was unused. Later build failure does not refund an
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

### A7 provenance and release correction candidate

Independent review of published5f7f (#2002/6255868999) found that reconciliation
could refund a committed unknown permission from an older planned/refused file
before matching its admission provenance. Three real temporary-recorder collision
cases and a direct DAL case reproduced that transition:0pass/4fail/31assertions,
then4pass/0fail/47assertions after the correction. A second RED0/2/14 exposed
rewriting a committed permission's accounting timestamp to an earlier day.

The candidate removes the unowned zero-attempt reconciliation refund. Matching
action/journal/thread/cascade, non-dry-run and committed time/day evidence is
checked before settlement. Missing or conflicting evidence remains held. Generic
settlement cannot release capacity or replace a committed admission timestamp;
the existing owner-bound reserved/null release now uses the same control-row
transaction lock as authorization in both dialects. No schema, provider,
recorder, cascade or SQLite adapter implementation changes accompany A7.
Normal loop refused/planned returns before permission still release the owner's
reservation. Separate SQLite connections exercise release versus authorization
in both invocation orders; PostgreSQL counterparts await fresh isolated proof.

A7's four-file Stop1 passed175/0/1006assertions, no skip/filter. Its exact14-file
Taskmaster group FAILED371/1/1603: the existing old-pending fixture hit EPERM in
the normal recorder's rename. Core taskmaster passed103/0/350. The EPERM cause
is UNRESOLVED; it is distinct from the earlier SQLite cleanup EBUSY.

Separate diagnostic-only D1 observed one group372/0/1614 and one named isolated
old-pending control1/0/11 (32 other cases filtered for that diagnostic only).
Both traces show two normal exclusive creates and eight normal writes, sequential
awaited calls, peak one test-owned writer per record and none active at stop.
Both normal recorder methods were explicitly injected to preserve exclusive
create behavior. Observation does not prove native-handle closure or external
ownership. These passes neither erase A7's failure nor establish an EPERM fix.
No retry, forced deletion, sleep, teardown change or OS/config workaround was
added. The local checkpoint remains BLOCKED pending fresh exact-head CI/PG,
independent/App review, post-build validation and the unresolved failure's
disposition. It authorizes no publication, runtime release or registry effect.

## PostgreSQL settlement typing correction (2026-10-19)

Published checkpoint863161e398e07947a4e7e8b79a7553eb11317c80 failed the
real PG17 cap suite: four passed, two failed, sixteen assertions. Both the
existing replay/rebooking case and the new unowned-settlement case reported
42P08, an undetermined parameter$2 type in the settlement null guard. Both
release/authorize orderings passed. The original hosted failure is retained;
Ubuntu, Windows, Docker and CodeQL success do not erase it.

The correction gives that null check an explicit portable `CAST($2 AS TEXT)`.
The column is TEXT in both dialects. All release/provenance/time guards and the
parameter order remain unchanged, as do schema, adapters and transactions.
Existing four-file regressions pass175/0/1006assertions without skips/filters;
workspace/script types and production DAL lint exit0. The local isolated PG
fixture is absent, so real dialect acceptance still requires fresh hosted CI
at the correction head. This does not resolve the separate recorder EPERM.

John's own-draft rule permits continued source commits, ordinary pushes,
description updates and tests on the owner's draft PR1166 against dev without
another XO grant. It does not authorize ready-for-review, merge, runtime,
database, credential or production changes. The manifest remains BLOCKED.

## Development integration (2026-10-23)

The owned draft integrates dev240d96283018ba05d6c4d0cb0dea9ee873fad37c
without rewriting the published cap history. Daily reservation and the awaited
permission gate now wrap dev's pending-fire custody path. A committed permission
counts against the daily limit even when the workflow result is uncertain.
Admission accounting alone cannot mark a journal row sent or replace its
supervision. The existing exact cascade/workflow proof, expectation readback,
original proof deadline and conditional pending-to-sent transition own that step.
Restart accounting retains this separation, including across UTC rollover.

An identity-bound refusal before the permission gate releases only the owner's
uncommitted reservation. A refusal after committed permission stays charged;
missing workflow proof keeps custody pending. A release-storage error also keeps
custody pending. The default two-per-day and existing three-per-tick ceilings
both apply. Dev's lane routing, pending-scope exclusion and package test isolation
are retained. No live service, provider, credential or registry change is involved.

Local integrated verification: Taskmaster plus cap526pass/0fail/1957assertions
across17files, workspace/script types exit0, production DAL/adapter/loop lint
exit0. Core Taskmaster110pass/0fail/371assertions; SQLite49pass/0fail/357assertions
with its existing one Windows symlink skip. Fresh hosted Windows/Linux/PG and
exact-head review remain required. Original recorder EPERM and earlier PostgreSQL
failure evidence remain historical facts; these tests do not establish an EPERM
cause or production readiness.

## Independent review deadline correction (2026-10-23)

Independent Codex review of b8aa135f9 returned CHANGES_REQUIRED for one P2:
settlement persists permission-time plus24hours, but immediate supervision used
the in-memory proposal-time deadline. Delayed admission could escalate early;
a crash after expectation registration could leave restart custody unable to
match the persisted journal and immutable expectation deadlines.

The loop now rereads the same journal identity after settlement and before
supervision. Missing or changed pending custody fails closed. The existing
expectation registration/readback/conditional-transition protocol is retained.
A shared SQLite journal, admission ledger and expectation store reproduces both
normal and registration-before-transition crash cases: RED0/2/4assertions,
thenGREEN2/0/9assertions. Full Taskmaster/cap regression528/0/1966 across17files.
Filtered runs are targeted red/green diagnostics only; the full suite is unfiltered.
No schema, admission-limit, provider, credential, recorder or runtime change.
Fresh candidate CI and reviewer follow-through remain separate requirements;
b8aa CI and its CHANGES_REQUIRED report are retained as historical evidence.

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
