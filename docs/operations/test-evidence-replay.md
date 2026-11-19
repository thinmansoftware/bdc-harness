# Guarded test evidence and backlog replay

WO: WO-HARNESS-TEST-LOOP-BEFORE-EVIDENCE-GATE-01

The feature lanes execute declared tests before the manifest evidence gate. Real
test failures may receive at most two Overseer repair attempts. Missing tools,
the Bun node shim, timeouts and absent stage repositories are BLOCKED immediately.
The test-repair node uses the lane's builder provider/model without a persona.
Repairs may change only product files already in the build diff against the base
at the snapshot, plus new non-test, non-frozen files. Every other tracked file is
frozen by SHA-256: any byte change or deletion is refused. Test files, declared
test scripts, package.json, lockfiles, bunfig.toml, runner configurations,
Makefile, tsconfig* and .github paths are always frozen, even when the build
changed them. The same classifier freezes shell scripts (*.sh, *.bash, *.ps1),
files under scripts/ or test directories, reachable package-script entrypoints
and executable files. New files in that class and skip/only/todo markers in any
new file are refused. A guard violation terminates repair as BLOCKED with
`tests_failed_after_repair:guard` in final evidence, the manifest audit line,
the evidence gate's stderr and the blocked-report comment.

`run-stop-tests-final` supplies evidence to the validator, manifest stamp and
evidence gate. `run-stop-greps` waits for that final test run, so all three
consumers receive grep evidence from the repaired worktree.
CODE/MIXED blocked evidence fails closed with `TESTS_BLOCKED:`.
Existing non-PROCEED `NOT_GATED` and base-red behavior remains in place.

The shared `rst_report` arguments are class, command, exit code, counts,
optional environment reason, and optional log path. A declared capability probe
that reports `env_unavailable` takes precedence over test-execution blocked
reasons, including across stages and final verification. An infrastructure guard
violation still blocks repair even if a capability later becomes unavailable.
An initial unavailable capability never enters repair, stamps
`VALIDATION: FAIL`, and fails the evidence gate with `ENVIRONMENT_UNAVAILABLE:`
even on a non-PROCEED run. Without that probe, the existing blocked reasons apply.

## Trusted final verification (WO #5217)

Option A, the snapshot tree, was approved by the acting XO on 2026-11-11
(bdc-xo#5217, fence 308). The trusted source is post-build and pre-repair, at
the existing guard snapshot. This keeps legitimate build-time test changes
and uses the same pre-repair evidence boundary the gate already accepts.
Option B, restoring infrastructure from the base commit, is deferred; revisit
it only if the Overseer finds build-time helper faking in practice.

The snapshot saves byte copies under `evidence/trusted-infra/`, separately for
the run checkout and each available stage checkout. The boundary approved by the
acting XO on 2026-11-11 (bdc-xo#5217, fence 313) includes the existing
test-infrastructure class and reached files marked as test support: a path
segment `test`, `tests`, `spec`, `specs`, `fixtures`, `__tests__` or `mocks`, or
a basename containing `test`, `spec`, `fixture`, `mock`, `helper`, `setup` or
`conftest` (case-insensitive). Other product modules are never saved or restored,
even when imported. Discovery may walk through them to reach marked helpers,
including relative JavaScript imports and local Python imports. It follows at
most eight helper hops and tracks visited files and command directories to
terminate cycles. Dynamic or unresolved references fail closed only when they
occur inside the boundary. Those failures and a depth overflow report
`tests_failed_after_repair:guard` after a repair attempt and a diagnostic naming
the entrypoint. Capture failures are recorded for repair without changing the
initial test verdict or the no-repair final evidence, including in fixtures
without a Git repository.
An absolute executable or helper reference from a boundary file (including a
reachable package script) into any run or stage worktree cannot use the trusted
scratch copy. Snapshot discovery records this as a capture failure. After a
repair, final evidence is BLOCKED with `tests_failed_after_repair:guard` and the
plain diagnostic `test guard: absolute reference into the live worktree cannot
be verified from the trusted copy: <file> -> <path>`. Without repair the initial
evidence remains unchanged. Absolute references outside those worktrees, such as
`/usr/bin/env bash check.sh`, are unaffected.
Harness-owned evidence retains its existing exclusion from project capture.
Product modules and data outside the boundary remain repairable. The accepted
residual is a build-changed product file with a non-test name executed as a helper;
the infrastructure-change listing and the Overseer's diff review are backstops.
The guard's product allowlist and freeze rules remain unchanged. After a repair,
final verification copies the repaired checkouts into temporary directories,
restores their saved infrastructure, and executes the persisted commands there.
Product fixes remain present; a repair's fabricated helper bytes do not run.
Each scratch checkout has private Git metadata and a copy of the live index,
including its tracked set. If a repair was staged, only the private HEAD is
anchored to that index so `git diff --cached` remains empty during verification.
The source index and Git metadata are never written by scratch preparation.
Command side effects remain in the scratch copies. Evidence files still go to
the run's artifact directory. Scratch copies are removed after final verification.
Missing or damaged trusted inputs fail closed. Final output and the stamped
manifest record `TESTS_FINAL_INFRA=trusted`. Runs with no repair use the original
evidence without creating a scratch copy or recording that mode.

## Saved inputs and stage directories

The evidence directory contains `stop-tests.commands` (one full command per line),
`stop-tests.stages` (stage ID, TAB, repository slug, TAB, command, TAB, target branch), the test log,
guard snapshot, attempt count and final evidence. Repair and final verification
use these saved files rather than reading the spec again. The guard snapshot is
keyed by absolute directory and saves the allowlist, known paths and raw-byte
SHA-256 hashes of frozen files in the current checkout plus every available stage
worktree resolved from the saved plan. The run base follows the lane's declared
base branch or BASE_BRANCH (otherwise master); each stage uses its saved target
branch. Local origin refs take precedence over local branches. An unresolved
base or missing merge base allows no tracked product files. The allowed set is
fixed at the snapshot and does not grow when repair commits move HEAD.
Checks revisit those saved roots even
if a mapping disappears; a missing snapshotted directory fails closed.
The freeze also includes existing regular files named by saved command tokens,
including ignored scripts such as `check.sh`. Paths resolve in the command's
worktree and honor a leading `cd`; flags, interpreter names and paths outside
that worktree are excluded.
Saved npm, Bun, Yarn and pnpm package-script commands resolve their script in
the command's package directory, including a leading `cd`. The guard freezes
every existing in-worktree file token named by that script, including regular
entrypoints changed by the build and files in `&&`, `||`, `;` and `|` chains.
Npm pre<name> and post<name> lifecycle hooks resolve alongside the requested
script, including hooks on nested npm package-script calls and chained segments.
Nested package-script calls resolve recursively, with at most five script
expansions per call chain. A cycle, depth overflow, missing script or unreadable
or invalid required package.json blocks repair with
`tests_failed_after_repair:guard`. Both regular entrypoints and symlink targets
are removed from the product allowlist in the run and persisted stage worktrees.
This resolves command strings only; it does not trace entrypoint file contents.
Dependency and VCS trees are excluded from guard enumeration and classification:
any path containing a node_modules, .git, .venv, venv, __pycache__, .bun or
.pnpm-store segment, at any depth. This also excludes declared commands and
package scripts inside those trees, including `bash node_modules/.bin/check.sh`.
Other ignored paths obey the same freeze and new-file rules; an ignore pattern
does not exempt new tests, runner configuration or marker-bearing helpers.
Only regular files can be executable test infrastructure. Directory symlinks
inside the worktree are not file entrypoints and are not frozen. A declared
file outside the excluded trees reached through a directory link is frozen
along with its resolved file target. External targets still block when the
link is itself a declared entrypoint, test file or test-infrastructure path.

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

The guard also freezes the resolved in-worktree targets of symlinked declared
scripts, test files and package test entries. A missing target or a target outside
its worktree blocks repair with `tests_failed_after_repair:guard`. Repointing the
link, editing the resolved target or deleting it is a frozen-file violation in
both the run worktree and persisted stage worktrees.
The same target freeze applies to symlinks elsewhere in the frozen-file set.

The guard does not trace helpers called or sourced by a frozen entrypoint.
Every build-changed file in the test-infrastructure class is removed from the
allowlist and frozen by SHA-256. Product source outside that class remains
allowed by the guard. Named helpers invoked or sourced by declared entrypoints
use their snapshot bytes during trusted final verification (bdc-xo#5217);
this is not runtime execution tracing.
Final run output and the PR's stamped manifest section list
repair changes to shell scripts, test/runner configuration, CI files, scripts or
test directories, declared command files and executable files under
`Repair touched test infrastructure`, one path per line. Product-only repairs
and runs without repair print `Repair touched test infrastructure: none`.
A non-empty listing fails closed with `tests_failed_after_repair:guard`, even
if a frozen-file check was bypassed. Each file also has a plain diagnostic:
`test guard: repair changed test infrastructure: <path> (frozen; a human must change it)`.
The shared guard core computes this disclosure against the snapshot, including
new files and stage worktrees. It does not change the test verdict.

After merge and an operator-authorized runtime rebuild, from the serving checkout:

```bash
bun run cli workflow run bdc-evidence-replay 'PR_NUMBER=1234'
```

The workflow creates its own isolated clone at `$ARTIFACTS_DIR/replay-checkout`.
Only that clone's config receives the disabled origin push URL; the serving
checkout and its linked worktrees keep their existing config. It fetches and
checks out the PR ref detached, resolves the WO spec using the standard
read-spec fallbacks and executes the same resolver, runner and guarded repair
nodes as the feature lane. `WO_ID` may be supplied in the environment to override
the PR body's `WO:` line. An unresolved spec is empty and does not fabricate one.
The path saved in `evidence/replay-checkout` directs resolver, test, repair and
report steps to the owned clone. The repair agent must edit that clone as well.

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
a fresh detached worktree of the replay clone (including the recorded local
repair), checks that PR
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
