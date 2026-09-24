# Archon lanes

## Declaring a repair target and operator-recorded stops in a WO

Feature-development work orders can declare an existing pull request as their repair
target:

```text
Repair target: PR #826 (branch feat/example-repair)
```

The declaration authorizes plan review to record
`repair_target_authorized_by_spec: #826`; it does not require a separate question
about whether the pull request is canonical or should be replaced. Before any push,
the lane verifies with GitHub that the pull request is open in the target repository
and that its live head branch exactly matches the declared branch. A missing or closed
pull request, or a branch mismatch, fails closed. A successful repair checks out and
pushes to that existing branch, allowing the existing pull request to be reused.

A stop condition that must be completed outside the builder lane can be marked by
ending its specification line with one of these forms:

```text
-- recorded by XO
-- recorded by the operator
(operator-recorded)
```

These markers place the stop outside the builder's gate. Plan and diff review must not
escalate merely because the stop is still outstanding. Until XO or the operator records
the result, the manifest represents it as `OPERATOR-RECORDED (pending)` rather than
`FAIL` or `N/A`.

Neither declaration suppresses genuine ambiguity or weakens a repository's staging
crossing gate. Repair-target validation still fails closed, and unmarked stop conditions
remain normal builder requirements.

## Checkpoints and salvage

Feature-development lanes commit changes produced by `diff-repair` before capturing
the final review patch. The `checkpoint-diff-repair` node is a no-op for a clean
worktree; otherwise it creates a `checkpoint(diff-repair): <n> files` commit so
`diff-review-final` judges the repaired HEAD.

For non-interactive runs that remain blocked, `noninteractive-salvage` also preserves
any remaining working-tree changes in a `salvage(uncommitted): <n> files` commit and
pushes the salvage branch for human review. This preservation does not authorize the
normal `commit-and-push` node or bypass its blocked-run approval rules.

## manifest-evidence-check admission policy (counts_unparsed, SPEC_DEFECT, HARNESS_REFUSED)

For CODE and MIXED work orders, `manifest-evidence-check` admits an executed test
command that reports `tests_status=counts_unparsed` only when `tests_exit=0`. The
manifest keeps the existing N/A-style explanation because the command produced no
parseable counts. A nonzero exit, `failed`, `no_command_declared`, or missing test
evidence still fails closed with `EVIDENCE_ERROR`.

Declared grep stop conditions are handled by their observed status. `passed` is
admitted. `incomplete` is admitted only when at least one grep executed and no grep
mismatched; its Stop conditions line publishes `unparsed=<names>; dropped=<n>`.
`mismatch` remains an `EVIDENCE_ERROR`. `all_dropped`, meaning zero conditions
executed, fails with `SPEC_DEFECT:` when one or more conditions were unparsed and
includes their names and any `DROPPED:` reasons, attributing the failure to the
stop-condition specification. When every parsed condition was instead removed by
the allowlist, it fails with `HARNESS_REFUSED:` and includes the `DROPPED:` reasons,
attributing the refusal to harness policy rather than to a malformed specification.

The `mec core` block and the `sme_process` / `mec_check` call sites in
`.archon/workflows/defaults/bdc-feature-development.yaml` are the source of truth;
their mirrored lane copies must remain byte-identical. The unit test checks both the
function bodies and these separate argument-passing surfaces so new evidence fields
cannot silently fall back to defaults in a subset of lanes.

## install-worktree-deps (lane dependency install)

Every `bdc-feature-development` lane runs `install-worktree-deps` after
`format-autofix` and before `run-stop-tests`. The node installs the target repo's
pinned dependencies into the run worktree. It is lockfile-driven and
repo-agnostic. It always exits 0: it reports and does not gate.
`run-stop-tests` and `manifest-evidence-check` remain the gates.

It considers the repo root and up to three depth-1 directories that contain
their own lockfile (at most four directories, root first, then depth-1 names
in `LC_ALL=C` order). `node_modules`, `.git`, `dist`, and `build` are skipped.
Manager selection follows lockfile precedence: `bun.lock` or `bun.lockb`
(bun), else `package-lock.json` or `npm-shrinkwrap.json` (npm), else
`yarn.lock` (yarn), else `pnpm-lock.yaml` (pnpm). Installs are frozen:
`bun install --frozen-lockfile`, `npm ci --no-audit --no-fund`,
`yarn install --frozen-lockfile`, `pnpm install --frozen-lockfile`.

`DOCUMENTATION` and `OPERATOR` work orders are not installed
(`DEPS_STATUS=not_required`).

Stdout keys:

- `DEPS_CLASS` -- WO class (`CODE`, `INFRA`, `MIXED`, `DOCUMENTATION`, `OPERATOR`)
- `DEPS_STATUS` -- overall: `not_required`, `installed`, `failed`, or `skipped`
- `DEPS_DIRS` -- semicolon list of `<dir>:<status>`
- `DEPS_SECONDS` -- wall time in seconds
- `DEPS_CACHE_DIR` -- colocated bun cache path, or `default` when the worktree path has no `/worktrees/` segment
- `DEPS_CACHE_SAME_FS` -- `true`, `false`, or `unknown` (GNU `stat -c %d`)
- `DEPS_LOG` -- path of the full log (`${ARTIFACTS_DIR:-.}/evidence/deps-install.log`)

Per-directory status is one of: `installed`, `cached`, `skipped_no_package_json`,
`skipped_no_lockfile`, `skipped_no_tool`, `skipped_not_ignored`,
`skipped_low_disk`, `skipped_budget`, `failed_exit_<n>`, `failed_timeout`,
`dirty_reverted`.

Overall status is `failed` if any directory failed, `installed` if any
directory is `installed` or `cached` and none failed, and `skipped` otherwise.

Env overrides:

- `WDI_TIMEOUT_SECS` -- per-directory install timeout (default 600)
- `WDI_BUDGET_SECS` -- total budget across directories (default 900); directories not started in time are `skipped_budget`
- `WDI_MIN_FREE_KB` -- minimum free KiB on the worktree filesystem (default 2097152). Below that, the directory is `skipped_low_disk`

When the worktree path contains `/worktrees/`, bun installs set
`BUN_INSTALL_CACHE_DIR` to `<repo-workspace>/.deps-cache/bun` (the parent of
`worktrees/`, outside every git tree, on the worktree filesystem) so bun can
hardlink instead of copying the install.

A stamp file `node_modules/.archon-wdi-stamp` records
`<manager> <sha256 of the lockfile>` after a clean successful install. A
matching stamp on a later run reports `cached` and does not invoke the
package manager. Install side effects that show up in
`git status --porcelain=v1 --untracked-files=all` are reverted and the
directory reports `dirty_reverted` with no stamp.

Unit test:

```bash
bash .archon/workflows/defaults/__tests__/install-worktree-deps.sh
```
