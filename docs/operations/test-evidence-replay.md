# Guarded test evidence and backlog replay

WO: WO-HARNESS-TEST-LOOP-BEFORE-EVIDENCE-GATE-01

The feature lanes execute declared tests before the manifest evidence gate. Real
test failures may receive at most two Overseer repair attempts. Missing tools,
the Bun node shim, timeouts and absent stage repositories are BLOCKED immediately.
Repairs may change product code or setup, but must preserve assertions, test files
and skip/only/todo markers. A guard violation terminates repair as BLOCKED.

`run-stop-tests-final` supplies evidence to the validator, manifest stamp and
evidence gate. CODE/MIXED blocked evidence fails closed with `TESTS_BLOCKED:`.
Existing non-PROCEED `NOT_GATED` and base-red behavior remains in place.

## Saved inputs and stage directories

The evidence directory contains `stop-tests.commands` (one full command per line),
`stop-tests.stages` (stage ID, TAB, repository slug, TAB, command), the test log,
guard snapshot, attempt count and final evidence. Repair and final verification
use these saved files rather than reading the spec again.

When canonical stages are declared, their verify commands supersede Stop test
blocks and the project-map command. Each stage executes in its declared worktree.
Set `RST_STAGE_WORKTREES` to newline-separated `stage-id=/absolute/worktree` pairs
(semicolon separators are also accepted). Without a mapping, only a stage whose
repository equals the current worktree origin is available. Missing repositories
remain BLOCKED; a command is never redirected into another repository.

The optional project-map integer `test_timeout_seconds` is clamped to 60..1700;
missing or invalid values use 1500. A direct `RST_TIMEOUT_SECONDS` fixture override
may be below 60; positive values above 1700 are capped at 1700.

## Invoke the replay lane

After merge and an operator-authorized runtime rebuild, from the serving checkout:

```bash
bun run cli workflow run bdc-evidence-replay 'PR_NUMBER=1234'
```

The workflow requires worktree isolation, disables origin pushing before fetching
the PR ref, checks out that ref detached, resolves the WO spec using the standard
read-spec fallbacks and executes the same resolver, runner and guarded repair
nodes as the feature lane. `WO_ID` may be supplied in the environment to override
the PR body's `WO:` line. An unresolved spec is empty and does not fabricate one.

The lane has no commit, push, PR, label or comment node. Repairs remain local.
Its `replay-report` node prints `REPLAY_REPORT_PATH=...`; that JSON records PR, WO,
stage lines, status, blocked reason, repair attempts and repair result. The report
also records the observed Tests line and WO class for independent verification.
The adjacent repair patch records tracked local changes for a fresh verification.

## Select the backlog without running anything

```bash
bash scripts/evidence-replay/backlog-replay.sh --sample 10 --dry-run
```

This performs one read-only GitHub query and prints exactly ten PR numbers. The
selection is open PRs against dev with empty checks or a FAILURE, ERROR,
TIMED_OUT or CANCELLED result, ordered by updatedAt descending. Too few eligible
PRs is an explicit failure. Dry run exits before opening the database, invoking
the CLI, creating worktrees or writing events.

## Post-merge acceptance (XO/Overseer)

```bash
bash scripts/evidence-replay/backlog-replay.sh --sample 10 --db /absolute/path/to/archon.db
```

Use the serving runtime's existing SQLite event store and configured CLI/provider
environment. `--db` is optional: the default follows `ARCHON_HOME/archon.db`,
`/.archon/archon.db` in Docker, or `~/.archon/archon.db` locally. A PostgreSQL
`DATABASE_URL` is rejected instead of inspecting a different database.
The CLI waits synchronously. Each run is correlated by a unique
user-message token, and its completed replay-report event locates the JSON file.
The script reads the event store in read-only mode, verifies every PASS again in
a fresh detached worktree (including the recorded local repair), checks that PR
heads did not move and prints per-PR outcomes and:

```text
REPLAY: false_pass=0 na_on_code=0 passed=<n> repaired=<n> blocked=<n> failed=<n>
```

The script exits successfully only when false_pass and na_on_code are both zero.
Missing run correlation or report evidence fails closed. Multi-repository stages
unavailable to fresh verification remain blocked and cannot certify a PASS.
This command must not run during pre-merge builder work. Post the acceptance table
to the WO using the existing owner process after the runtime rebuild. Local tests
and sample selection do not constitute live acceptance or WO completion.
