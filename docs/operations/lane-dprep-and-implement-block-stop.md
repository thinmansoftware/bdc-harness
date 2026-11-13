# Lane dependency prep in package folders, and the implement-block gate

Work order: WO-HARNESS-LANE-DPREP-PACKAGE-FOLDER-AND-IMPLEMENT-BLOCK-STOP-01 (bdc-xo #5970).
Applies to the 13 `bdc-feature-development*.yaml` lanes. The `bdc-evidence-replay.yaml` lane is unchanged.

## Why

Run f1656d75 (shopops, lane bdc-feature-development-codex, 2026-11-13) could not run its guard tests and then
wrote code and opened a pull request after its implement step had declared BLOCKED. Two causes:

1. `dprep_ensure_js_deps` looked only at the top folder of the worktree. shopops keeps its lockfiles in
   `shopops-api/`, so prep printed "no package.json with a supported lockfile ... skipping" and installed
   nothing. Run 6c722c87 passed only because its implement step ran `npm ci` itself. (The exact cause of the
   "trusted infrastructure unavailable" line in f1656d75 is not recoverable from the event store: stderr is not
   stored. Missing dependencies are the cause the first test run reported; it is not proven for the final run.)
2. Nothing read an implement BLOCKED as terminal: the repair, push, commit and pull request nodes were gated only
   by `repair-gate` (which concerns PR-repair targets) and by review verdicts.

## Package folders (scripts/lane/dprep.sh)

`dprep_ensure_js_deps` behaves exactly as before when the current folder holds a lockfile file (`bun.lock`,
`bun.lockb`, `pnpm-lock.yaml`, `package-lock.json`): bun first, then pnpm, then npm, and no subfolder is scanned.

When the current folder holds NO lockfile file it scans the immediate subfolders in bytewise name order,
skipping names that start with a dot, `node_modules`, `dist` and `build`, and installs in each of the first 3
that have a `package.json` plus a supported lockfile. It prints `dprep: package folder <name>` before each.

- Installer in a package folder: `package-lock.json` wins over a bun lockfile when npm is on PATH
  (`npm ci --no-audit --no-fund`, retry `npm install --no-audit --no-fund`). So `shopops-api`, which holds both,
  is installed with npm, as shopops's own workflows do; its `bun.lock` is four months older than its
  `package-lock.json`. Otherwise the order above applies.
- The install must not change what the repo tracks, and it never runs over earlier work (REFUSE-ON-DIRTY, the
  acting XO's ruling after three Overseer rounds on restore logic in PR 1597). Inside a git work tree a package
  folder is installed ONLY on a clean tree: nothing modified, staged, deleted or untracked (an untracked
  `node_modules` is ignored). On a dirty tree dprep prints `dprep: working tree has uncommitted changes; install
  skipped in <folder> (refuse-on-dirty: nothing installed, nothing touched)`, returns 1 for that folder, and does
  nothing else: no snapshot, no restore, so no earlier edit can be lost. This costs nothing on the normal path:
  `prep-dependencies` installs on the clean tree BEFORE implement, so a later call (`run-stop-tests`) finds
  `node_modules` and skips. On a clean tree every tracked change after the install is the install's own, and each
  is put back with `git checkout -- <file>` (`dprep: restored <path>`). Outside a git work tree the folder's
  `package.json` and lockfiles are copied aside and restored (a failed copy skips the install). (Reason:
  `commit-and-push` tolerates lockfile changes only at the top level, so a rewritten `shopops-api/bun.lock` could
  otherwise ship in the build PR.)
- A failed install in one folder does not stop the others; the return code is nonzero when any attempted
  install failed.

The trusted final test run installs nothing (Amendment 3). `trg_execute_trusted` copies the worktree to a scratch
folder excluding only `.git` and the artifacts folder, so the `node_modules` that prep installed in the real
worktree (package folders included) is in the copy when the saved test commands run. An install inside the
trusted context would run lifecycle scripts after the trusted test files were restored and verified, which could
rewrite them; so none runs there.

## The implement-block gate

New node `implement-block-gate` (after `assert-implement-produced-work`, `trigger_rule: all_done`, always exits 0).
It prints one JSON line: `{"terminal":"yes","reason":"..."}` when at least one file
`$ARTIFACTS_DIR/blocked-preserve/implement-iter-*/blocked-reason.txt` exists (the executor writes it when the
implement loop declares BLOCKED, WO-HARNESS-BLOCKED-BUILDER-STOPS-01), otherwise `{"terminal":"no"}`. The reason is
the first `blocked_reason=` line with quotes, backslash, backtick, dollar and control characters removed, at
most 300 characters. It reads no other file.

Gated nodes (each lists the gate in `depends_on` and carries `&& $implement-block-gate.output.terminal == 'no'`
on every OR clause of its `when:`): `test-repair`, `run-stop-greps`, `diff-repair`, `checkpoint-diff-repair`,
`opus-repair`, `noninteractive-salvage`, `apply-suggested-fix`, `decide-push-target`, `commit-and-push`,
`open-pr-if-needed`. A missing, empty or failed gate output makes the condition false, so they skip (fail
closed). With the default `all_success` trigger rule a skipped node also skips its dependents, so the review
chain between `run-stop-greps` and `block-classify` skips too; `block-classify` is `all_done` and still runs.

`block-classify` reads the gate. `"terminal":"yes"` forces status BLOCKED with the note
`implement_blocked: <reason>`, whatever the build outcome and review verdict were. A missing or unreadable gate
output forces BLOCKED with the note `implement_block_gate_missing`. `"terminal":"no"` behaves exactly as before.
`block-reclassify` keeps a prior BLOCKED note that begins with `implement_block`, so `blocked-terminal-gate`
prints `build_blocked: BLOCKED implement_blocked: <reason>` (or `... implement_block_gate_missing`) and
`blocked-issue` labels and comments as before.

Work the implement step did before blocking stays in `blocked-preserve/` and on the branch `checkpoint-push`
already pushed; no pull request is opened.

### Known divergence from doctrine

A blocked run still ends **failed** through `blocked-terminal-gate` (exit 1, `build_blocked: ...`).
doctrine/blocked-gate-pauses-not-fails says a blocked gate should pause (resumable) instead. This change keeps
the existing behaviour for both the declared blocker and the gate-missing case; changing it to a pause is a
separate decision and a separate work order.

### Lanes without blocked-issue

`fusion-cx-kimi`, `fusion-cx-qwen` and `kimi-k3` have no `blocked-issue` node, so a blocked run there is not
labeled `status:blocked`. That was already the case and is not changed here.

## Tests

- `bash .archon/workflows/defaults/__tests__/dprep-package-folder.sh` (package-folder rules, installer choice,
  tracked files unchanged)
- `bash .archon/workflows/defaults/__tests__/trusted-copy-node-modules.sh` (no dprep in the trusted context;
  worktree node_modules reaches the trusted copy)
- `bash .archon/workflows/defaults/__tests__/implement-block-gate.sh` (gate output, block-classify,
  block-reclassify, blocked-issue and blocked-terminal-gate for all 13 lanes)
- `bun test ./packages/workflows/src/lane-implement-block-stop.test.ts` (gate wiring and fail-closed conditions
  for all 13 lanes; also runs the shell suites above on POSIX CI)

## Reading a blocked run

`ls <artifacts>/blocked-preserve/implement-iter-*/` shows `blocked-reason.txt` (run id, node, iteration, reason),
`last-output.txt`, `git-status.porcelain`, `git-diff-HEAD.patch` and `git-untracked.txt`.
