# Tee-time persisted controller-input loader plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, task-by-task.

**Goal:** Read existing isolated-run authority and complete committed base into a frozen controller-input record without dispatch or mutation.

**Architecture:** Load current records through IWorkflowStore and the existing frozen authority/path conventions. A narrowly scoped image-owned or explicitly frozen Python helper reads binary Git objects with constrained configuration and recomputes the complete base using existing snapshot/Git/frame validators.

**Tech Stack:** TypeScript/Bun, Python unittest, local trusted Git object reads.

**Spec:** BDC_XO docs/behavior-specs/tee-time-admission-contract-draft.md Amendment A. Architect pre-build review approved this source-only scope with artifact-root, metadata-indirection, process-bound and helper-custody corrections.

## Global Constraints

- No Claude/Fable, model/provider call, auth access, production, authority creation, refs, fetch/reset or dispatch.
- Only project-scoped getRunArtifactsPath(owner,repo,runId)/authority; no worktree fallback search.
- Resolve real paths inside configured trusted roots; reject symlink/junction escapes and ambiguous custody.
- Existing current bundled policy/workflow matching does not admit future v2 workers.
- Keep baseSha and runScopeSha distinct. Read committed objects, never index, working files, attributes, filters or export archives.
- Helper output at most65536 bytes, ASCII JSON. Larger evidence blocks without truncation.

## Review Focus

- Foreign or changed store/spec/workflow/policy records reject before base reads.
- Unsafe Git includes, replacements, alternates, promisor/partial/shallow metadata reject without fetching.
- Binary blob bytes and modes survive exactly; unsupported entries and path collisions reject.
- Object/aggregate/process/stderr/transport bounds reject complete evidence rather than shortening it.
- Frozen-helper evidence is distinct from actual pinned-image invocation proof.

## Task1: Bounded committed-base reader

Files: scripts/staging/teetime_git_base.py and test_teetime_git_base.py.
Interface: read_git_base(git_binary,repository,commit) returns exact base commit/tree/manifest and complete base frame. CLI accepts only three fixed arguments; process diagnostics are not emitted. Use absolute trusted executable/repository, lowercase SHA-1 commit, no unsafe metadata indirection, scrubbed Git environment and no replacements/lazy fetching. Inspect object type/size before bounded binary reads; verify commit identity and recomputed root tree. Reuse build_git_objects, SnapshotFile/valid_path and encode_frame.

- [x] Write failing actual temporary-Git tests for binary preservation, working-tree independence, missing commit, unsupported entries, unsafe metadata, bounds and timeout; observe RED.
- [x] Implement the minimal read-only reader; no metadata/config writes or repository repair.
- [x] Run tests and required syntax/ASCII checks.

## Task2: Existing persisted-run loader

Files: packages/workflows/src/reliability/tee-time-controller-input.ts and adjacent tests; existing offline CI and staging runbook.
Interface: loadTeeTimeControllerInput(deps,runId,controllerConfig) loads records itself; no caller replacement authority/policy/spec/workflow. Validate existing project-scoped frozen artifacts and trusted worktree/repository ownership, resolve current bundled policy without assertExecutionEnabled, then invoke the exact helper/dependencies through bounded process capture. Return copied/frozen authority, policy, spec and base-frame identities only. Recheck records/helper identity before return. Controller configuration supplies trusted roots/executables/helper hashes, never model output. No image attestation is inferred from a configured path.

- [x] Add failing persisted-record/path/helper-custody tests, including real path escapes and actual temporary Git base integration.
- [x] Implement loading/identity checks and bounded helper invocation using established source paths.
- [x] Run new and relevant existing authority/policy/Git tests, workflow/provider/scripts typechecks, lint/format/ASCII and diff checks.
- [x] Independent source review before publication/CI; no runtime qualification or admission follows.

## Remaining runtime gate

This source does not create a run. Existing executor captureRunAuthorityInput/persistRunAuthority must establish real isolated foundation authority through the reviewed workflow/policy and separate frozen plan. The next adapter must connect this verified base to the actual builder artifact, authentic candidate commit, meaningful reviewed test commands and exact reviewer package. Atomic approval consumption remains separate.

## Local verification record

Observed RED for missing loader, provider parser metadata, explicit executable
identity enforcement and Windows fixture teardown. A read-only OS handle check
identified Code.exe holding one failed fixture's .git directory; it did not
establish the cause of every earlier lock. Architect approved moving only fresh
fixtures to an existing Git-ignored node_modules/.cache pool, with symlink and
containment checks. Existing failed roots remain retained; no editor settings or
processes were changed. Python retains its original TemporaryDirectory cleanup
behavior for read-only Git objects, after validating the exclusive owned root.

Current result:8 loader tests/23 assertions and8 committed-base reader tests pass,
including teardown;8 bounded-process tests and32 existing Git-object/commit/
snapshot/frame tests pass. Existing authority/policy/review tests:29 pass/135
assertions. Workflow/provider/scripts typechecks, loader lint and formatting pass.
Head/branch custody and pinned-image invocation are explicitly unverified in the
returned record. Independent architect source review approved publication to
existing draft PR1145 and exact-source CI. Publication and exact committed-source
CI remain pending until separately recorded; runtime admission is not approved.
