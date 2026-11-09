# Local builder verification record

WO: WO-HARNESS-TEST-LOOP-BEFORE-EVIDENCE-GATE-01 (bdc-xo #3436)
Branch: wo/harness-test-loop-before-evidence-gate-01
Pinned base: 548c859060a3470b8eb638cd2efbaf584bad9d0c

The shared origin/dev ref advanced during the build to
f1611cc5f30ea554b3631b6a09a3508b40a26c40 (unrelated XO lease-cap PR #1527).
This branch remains on the assigned base. No fetch, rebase or unrelated edit was
performed here. Changed-file checks use the pinned base to avoid including files
added by that newer remote commit. The owner must account for that drift.

Local implementation and verification only. This is not live acceptance or a
VALIDATION: PASS manifest: literal Stop 8f differs from its stale expectation,
and Stop 9 is reserved for the owner after merge and runtime rebuild.
No push, PR, GitHub comment/label write, container rebuild or server action ran.

## New test files: initial red -> final green

Counts are passed/failed. Red fixtures target the immutable baseline lane (saved
from the base SHA); classifier red used the baseline classifier and decision files.

- test-repair-guard.sh: 23/39 -> 70/0.
- stage-evidence.sh: 3/12 -> 33/0.
- test-evidence-classes.test.ts: 1/6 -> 7/0.
- evidence-test-lib.sh is a fixture driver sourced by the two shell suites.
- Additional timeout/assertion-token regressions: new-cases 0/3 -> 3/0.
- Selection regression: stage-evidence 31/2 -> 33/0 after fixing Windows shim
  resolution and LF output. The final dry-run fixture proves no engine invocation.

Existing suites also recorded red: runner 714/2, gate 95/3, stamp 44/2.
No assertion was removed or relaxed. The old timeout assertion now strictly
requires the WO's BLOCKED status and named reason. Final-consumer wiring asserts
the new node instead of the superseded node.

## Process deviations

Implementation began before the first batched red run had fully settled. Clean
baseline red runs were subsequently recorded; the strict instruction that all
initial red runs finish before any implementation was not met.

An early Windows selection fixture resolved the real gh.exe instead of the shell
stub and issued a read-only PR-list query. No workflow fired and no remote write
occurred. The final fixture resolves the shim through Bash and passes with stubbed
GitHub and engine executables. Thus the initial no-network-in-tests requirement
was not met, although the final new fixtures use stubs.

## Exact stop outputs

### Stop 1 (exit 0)

```text
run-stop-tests.sh: 719 passed, 0 failed
```

### Stop 2 (exit 0)

```text
manifest-evidence-check.sh: 98 passed, 0 failed
```

### Stop 3 (exit 0)

```text
stamp-manifest-evidence.sh: 46 passed, 0 failed
```

### Stop 4 (exit 0)

```text
test-repair-guard.sh: 70 passed, 0 failed
```

### Stop 5 (exit 0)

```text
stage-evidence.sh: 33 passed, 0 failed
```

### Stop 6 (exit 0)

```text
 7 pass
 0 fail
 13 expect() calls
Ran 7 tests across 1 file. [320.00ms]
```

### Stop 7 (exit 0)

```text
$ bun run scripts/generate-bundled-defaults.ts --check
bundled-defaults.generated.ts is up to date (36 commands, 106 workflows, 1 policies, 4 lane scripts).
```

### Stops 8a-8i and 10 (literal commands)

```text
Stop 8a:
1
exit=0
Stop 8b:
1
exit=0
Stop 8c:
4
exit=0
Stop 8d:
2
exit=0
Stop 8e:
5
exit=0
Stop 8f:
2
exit=0
Stop 8g:
3
exit=0
Stop 8h:
1
exit=0
Stop 8i:
0
exit=1
Stop 10:
exit=1
```

Stop 8f cannot meet the stated count of 1: the existing diff-repair loop at
origin/dev already contains `max_iterations: 20`, which this substring grep counts.
The new repair loop correctly has `max_iterations: 2`, producing the literal
count 2. The unrelated 20-iteration limit and the specified grep were preserved.
This item is reported rather than replaced with a different stop command.
Stop 8i's exit 1 with count 0 and Stop 10's empty output/exit 1 are expected.

### Stop 9a (dry run only, exit 0)

```text
1526
1523
1524
1509
1472
1451
1411
1409
1286
1197
```

Dry run returns before CLI, database or worktree operations. The stub test verifies
that the engine is never invoked. The production event store was not queried.

Stop 9 was not run: the brief prohibits live replay before merge and rebuild.

## Additional checks

### Type-check (exit 0)

```text
$ bun --filter '*' type-check && bun x tsc --noEmit -p scripts/tsconfig.json
@archon/persona-context-loader type-check: Exited with code 0
@archon/git type-check: Exited with code 0
@archon/paths type-check: Exited with code 0
@archon/security-watchdog type-check: Exited with code 0
@archon/isolation type-check: Exited with code 0
@archon/fusion type-check: Exited with code 0
@archon/companion-mcp type-check: Exited with code 0
@archon/grimoire-mcp type-check: Exited with code 0
@archon/smart-cauldron type-check: Exited with code 0
@archon/overseer type-check: Exited with code 0
@archon/web type-check: Exited with code 0
@archon/providers type-check: Exited with code 0
@archon/canary-suite type-check: Exited with code 0
@archon/core type-check: Exited with code 0
@archon/workflows type-check: Exited with code 0
@archon/server type-check: Exited with code 0
@archon/adapters type-check: Exited with code 0
@archon/cli type-check: Exited with code 0
```

### ESLint (exit 0)

Command: bun x eslint --max-warnings 0 --no-warn-ignored, with every changed TS file
including the generated file. No output. The ignored generated file is not linted.

### Prettier (exit 0)

Command: bun x prettier --check --ignore-unknown, with all changed files. Repository
ignore rules apply; unsupported shell files are skipped.

```text
Checking formatting...
All matched files use Prettier code style!
```

### Overseer package suite (bun run test, exit 0)

Exact batch summary lines (full output is in the raw log):

```text
 9 pass
 0 fail
 45 expect() calls
Ran 9 tests across 1 file. [3.98s]
 43 pass
 0 fail
 91 expect() calls
Ran 43 tests across 1 file. [852.00ms]
 35 pass
 0 fail
 113 expect() calls
Ran 35 tests across 1 file. [741.00ms]
 51 pass
 0 fail
 1229 expect() calls
Ran 51 tests across 1 file. [1067.00ms]
 10 pass
 0 fail
 28 expect() calls
Ran 10 tests across 1 file. [6.78s]
 5 pass
 0 fail
 14 expect() calls
Ran 5 tests across 1 file. [926.00ms]
 20 pass
 0 fail
 57 expect() calls
Ran 20 tests across 1 file. [246.00ms]
 126 pass
 0 fail
 510 expect() calls
Ran 126 tests across 2 files. [1.83s]
 23 pass
 0 fail
 130 expect() calls
Ran 23 tests across 1 file. [334.00ms]
 22 pass
 0 fail
 111 expect() calls
Ran 22 tests across 1 file. [19.38s]
 46 pass
 0 fail
 111 expect() calls
Ran 46 tests across 1 file. [95.00ms]
 12 pass
 0 fail
 21 expect() calls
Ran 12 tests across 1 file. [360.00ms]
 19 pass
 0 fail
 48 expect() calls
Ran 19 tests across 2 files. [2.40s]
 26 pass
 0 fail
 155 expect() calls
Ran 26 tests across 1 file. [18.18s]
 24 pass
 0 fail
 123 expect() calls
Ran 24 tests across 1 file. [7.48s]
 2 pass
 0 fail
 9 expect() calls
Ran 2 tests across 1 file. [1.64s]
 1209 pass
 1 skip
 0 fail
 4440 expect() calls
Ran 1210 tests across 60 files. [42.29s]
 14 pass
 9 skip
 0 fail
 43 expect() calls
Ran 23 tests across 2 files. [2.00s]
 18 pass
 0 fail
 41 expect() calls
Ran 18 tests across 1 file. [196.00ms]
 17 pass
 0 fail
 32 expect() calls
Ran 17 tests across 1 file. [84.00ms]
 8 pass
 0 fail
 72 expect() calls
Ran 8 tests across 2 files. [314.00ms]
 2 pass
 0 fail
 12 expect() calls
Ran 2 tests across 1 file. [865.00ms]
 44 pass
 0 fail
 123 expect() calls
Ran 44 tests across 1 file. [29.93s]
 18 pass
 0 fail
 43 expect() calls
Ran 18 tests across 1 file. [1011.00ms]
 6 pass
 0 fail
 24 expect() calls
Ran 6 tests across 1 file. [484.00ms]
 13 pass
 0 fail
 116 expect() calls
Ran 13 tests across 1 file. [846.00ms]
 1 pass
 0 fail
 14 expect() calls
Ran 1 test across 1 file. [1239.00ms]
 6 pass
 0 fail
 60 expect() calls
Ran 6 tests across 3 files. [611.00ms]
```

Totals across 28 Bun invocations: 1829 pass, 10 skip, 0 fail.

### Workflow wiring (exit 0)

```text
 125 pass
 6 skip
 0 fail
 1445 expect() calls
Ran 131 tests across 1 file. [69.80s]
```

### Workflow parser (exit 0)

```text
Workflow validation: 14 valid; every test-repair uses persona overseer and max_iterations 2
```

The registered built-in and community providers are required by the parser.
Core parity covers all 13 feature lanes and the replay lane. Each lane's repair
node reuses its existing diff-repair provider/model settings with persona overseer.

### ASCII and whitespace

Stop 10: empty stdout, exit 1 (clean). The brief's Perl scan across all changed
source/test/doc/generated files also emitted nothing, exit 0. git diff --check
emitted nothing, exit 0.

## Invocation and raw evidence

Runbook: docs/operations/test-evidence-replay.md.
Raw red/green outputs, full Overseer output and all additional-check logs are in
.p0b-evidence/ in this local worktree. They are local evidence, not runtime proof.
Oracle search could not run: ORACLE_BASE_URL is required in the environment. The
binding WO and current source supplied the implementation contract.

Live replay/provider operation, container rebuild, merge and runtime acceptance
remain unverified and outside this builder's authorized work.
