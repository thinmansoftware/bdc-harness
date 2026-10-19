# Minimal diagnostic worker - next source proposal

Status: independently approved for source implementation and offline tests with
the receipt clarifications below. Final source review required; no execution authority.

Review clarifications: taskStarted is capture attempted, not model invocation;
reaping is independent of actual child exit classification. A nested receipt
requires completed preflight, attempted capture, reaping and actual exit0/1.
Unknown cleanup observations cannot be unchanged=true. Keep validated nested
failure/success evidence when outer cleanup fails, but never pass the worker.
Authentication rejection comes only from the unchanged preflight observation.
Use silent argument rejection before auth, including unknown/missing/help args.

The fixed-response entry is source only. The next source slice will add an
unregistered Python worker and independent worker-result validator, without
changing existing filesystem/artifact/demo selectors or acceptance. No account
delivery, image installation, claim, retry or full product prompt follows from
this proposal. Four consumed implementation attempts stay untouched.

## Reuse and exact work

Use teetime_canary_worker.py's proven preflight, bounded_process, oom_kills,
artifact_workspace_snapshot, fixed AUTH/ROOT and process environment. Import it
as a module only; its main guard must never execute. Reuse validate_selector for
bounded nonce/source syntax only, not authority. Source image environment must
match the supplied source before reading auth. Assert assertion-enabled UID1001,
cwd/workspace, ordinary UID1001 mode0600 bounded auth file, empty ordinary owned
workspace .agents/.codex masks and absent alternate discovery roots as before.
The outer controller will later own image/source/approved policy comparisons;
worker-local observations cannot substitute for that custody.

Record auth bytes privately and exact workspace snapshot, run unchanged six
preflights, and recheck both before starting a task. Never return auth bytes,
account/config records or hashes of private data. Measure OOM before/after.
Invoke only `bun /app/scripts/staging/teetime-minimal-diagnostic-entry.ts` through
bounded_process with timeout100, DEVNULL stdin, fixed environment and actual
exit-code capture. No prompt/input arguments. Independently validate the child
exit and4096-byte ASCII diagnostic receipt before retaining that receipt.
No app/source/artifact output field or app acceptance path is present.

The reused process capture rejects output overflow, enforces timeouts and kills
and reaps its owned process group in finally. A returned capture proves normal
child reaping; an exception does not produce a positive reaping assertion even
when its cleanup may have succeeded. The future outer controller still needs
its own fixed deadline, container removal and uncertain-cleanup failure path.

## Separate exact receipt

Proposed worker version1 kind teetime-minimal-worker fields:
version, kind, nonce, source, passed, preflightPassed, preflightChecks,
authenticationRejected, authUnchanged, workspaceUnchanged, taskStarted,
taskProcessReaped, taskExitCode, taskReceipt, oomKillDelta, elapsedMs,
failureCategory. nonce32hex/source40hex are caller-bound public identities only.
Boolean fields are exact bools. preflightChecks0..6 and elapsedMs0..180000 are
exact ints; oomKillDelta is null (unknown) or bounded nonnegative int.
taskExitCode is null or exact0/1. failureCategory is none/preflight/task/cleanup.
taskReceipt is null or independently validated minimal diagnostic, never raw
output. No counts are fabricated if child output is absent, malformed, exits
abnormally or capture fails. In those cases invocation count remains unknown
through taskReceipt=null; never infer zero model calls from an absent receipt.

Passed requires taskReceipt.passed, taskStarted/reaped, exit0, all6 preflights,
auth/workspace unchanged, authenticationRejected=false, OOM0 and failure none.
A valid failed task receipt remains failed, with failureCategory task. Any final
auth/workspace/OOM uncertainty overrides task success with cleanup failure.
Preflight failure starts no task. Set taskStarted immediately before capture;
never retry a failed capture. A capture with abnormal exit has no valid child
receipt, while taskProcessReaped can still be true if capture returned normally.
This implies the implementation needs to retain actual abnormal exit privately
and expose taskExitCode=null for it; the independent validator must reject any
claim of successful task/receipt/reaping based on null exit alone.

Validator accepts exact expected nonce/source and actual worker exit0/1 plus
bounded ASCII JSON, rejects duplicate/unknown fields, invalid enum/type/bounds,
contradictory passes and task/receipt/phase combinations. Worker exits0 only for
passed and1 otherwise. Failed but well-formed diagnostics are not app success.

## Tests first and later gates

Use existing synthetic auth/workspace fixture metadata normalization only in
tests. Mock preflight/capture, never contact account/model. Cover success,
preflight rejection/mutation, child failed/malformed/missing/oversized receipt,
abnormal exit, timeout, workspace/auth mutation, OOM unknown/increase and cleanup
uncertainty; demonstrate exact child command/no caller input. Validate emitted
worker record independently; run existing worker/capture/minimal regressions,
scripts typecheck, ASCII and diff checks. Independent design and final source
review, source publication and exact-source CI remain required.

Later controller/operator integration must separately measure the expanded
source closure, use diagnostic proxy ready/final parsing only for this new
route, preserve existing legacy schemas, verify READY before auth read/delivery,
enforce single use, establish fresh governed approval and preserve all prior
attempt evidence. This proposal creates no selector in those controllers and
grants no operational authority. No implementation attempt5.
