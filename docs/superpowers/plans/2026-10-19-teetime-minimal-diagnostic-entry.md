# Fixed-response diagnostic entry - next source slice

Status: design approved for source implementation/offline tests with the
clarifications below; final source review still required. Not execution authority.

The four full implementation attempts are terminal and remain immutable. No
attempt5, generic executor resume or full product-prompt retry is authorized.
The new closed proxy counters and minimal collector exist as separate source
contracts. They are not yet installed or integrated with account delivery.

## Purpose and boundaries

Next implement a small unregistered Bun task entry for the literal prompt
`Reply with exactly OK.` through the existing restricted Codex canary factory.
This diagnoses the same transport/provider path without application generation.
No caller prompt, model override, file output, resume, arbitrary environment
selector, artifact schema change, fallback, credential access or network call in
source tests. This entry alone cannot authorize authentication or execution.

Use an exported, dependency-injected task runner for deterministic offline
tests, plus a thin entry with the existing silent root logger/console pattern.
The runner owns one AbortController and a fixed 90000ms query deadline, clears
the timer when the iterator is closed and in finally, and invokes the published
collector exactly once. It delegates the fixed literal and stream handling to
collectMinimalDiagnostic, without duplicating acceptance logic.

The runner invokes a supplied fixed provider query callback only through the
collector. Runtime callback lazily creates the existing restricted canary
provider, using fixed runId teetime-minimal-diagnostic, measured policy digest
and /workspace. Its single sendQuery uses /workspace, no resume, abortSignal
only. Current restricted factory pins model/transport and denies fallback.
No public provider or registry additions. An initialization failure inside that
callback becomes the collector's closed failed receipt, never a fabricated OK.

Review clarifications: silence before dynamic collector/provider imports; the
factory must be genuinely lazy inside an async generator. Hash measurement is
not approval/custody, and the run label is not persisted authority. Timer abort
is cooperative; never abort a closed iterator. No provenance tags are invented
for factory/import failures. Test clock stays within runner, not argv/env.

The entry rejects all extra argv before file/provider access. It accepts no
stdin payload. Policy is read only at its existing immutable /app path. Emit
only the already reviewed minimal diagnostic JSON, with actual exit0 on passed
and exit1 on failed. An entry initialization/import failure that cannot create a
valid collector receipt produces no success packet; the eventual worker must
reject absent/malformed output. Never emit raw exceptions, console diagnostics,
private response text or an invented failure record outside the schema.

## Tests before implementation

1. Fixed prompt and one callback invocation; no caller query/model/path inputs.
2. Success, native tagged failure, malformed/unexpected chunks, and callback
   initialization failure roundtrip through the independent Python validator.
3. Deadline abort of a cooperative held stream; timer cleanup on normal end,
   provider failure, local rejection and cleanup error. Tests use fake timers or
   an injected clock whose runtime adapter remains fixed to90000ms.
4. Real executable entry with extra argv fails before provider/policy access,
   no stdout private data, no model/account invocation. Do not execute the normal
   authenticated entry on this desktop as an offline test.
5. Existing collector/provider tests and scripts typecheck remain green. Add the
   new task-runner tests to offline CI. ASCII and diff checks, independent final
   source review, then publish to the existing draft branch and inspect exact CI.

## Explicit later work, not granted by this source slice

The Windows operator/controller and Python worker still need separately reviewed
diagnostic selectors and exact worker/report contracts. Reuse existing verified
credential delivery only after READY, preflight, immutable source/image identity,
account/workspace unchanged checks, bounded process capture and reaping, and
owned-resource cleanup. They must use diagnostic proxy ready/final parsing only
for the new selector and retain legacy behavior for existing tasks. A new
diagnostic result must never enter app artifact acceptance or reuse an old claim.

Before a real diagnostic: fresh reconciliation of four terminal attempts and
their cleanup, exact source CI, measured image, frozen inputs/operator closure,
independent execution-plan approval and one-use authority through the established
governed path. No installation or live model call follows from a source verdict.
Only after diagnosis and a reviewed corrective plan may a new demo implementation
attempt be considered. A tiny OK and aggregate proxy reasons do not prove served
model identity, provider entitlement, an app build or a client preview.
