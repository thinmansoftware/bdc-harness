# Minimal diagnostic remote controller integration - source proposal

Status: design independently approved for source implementation/offline tests
with the constraints below. Final source review required. No runtime authority.

Review constraints: one monotonic deadline, selected import closure and exact
host/image hash key sets, raw strict JSON before reserialization, honest null
resource IDs, closed bounded cleanup failures and no success before completed
proxy capture/cleanup. Valid nested diagnostic evidence survives outer failure.
Source implementation adds an optional finite monotonic cleanup deadline to
the proven watchdog cleanup helper; default callers retain current behavior.
After known-ID cleanup, a bounded owned-label scan must prove no lost-ID
resources remain. No cleanup success follows solely from an initial empty list.

Goal is the simulated client demo, still without accepted app source/build or
preview. Four implementation attempts remain consumed. This slice joins the
reviewed tiny diagnostic worker and closed proxy reasons to the existing remote
controller. It does not implement an operator/account-delivery route, image
installation, persisted one-use diagnostic claim or application attempt5.

## Extend the existing path

Modify run-teetime-auth-canary.py only at a new explicit --task
minimal-diagnostic branch requiring --diagnostic-source40hex. Reject artifact
source/demo package arguments in this branch; reject diagnostic source on all
other selectors. Existing defaults and filesystem/artifact/demo schemas remain
unchanged. Use a silent parser for this script so invalid arguments cannot print
private values. No existing duration/destination/model override is added.

Reuse current Docker inspection, seccomp validation, internal/egress networks,
read-only UID1001 worker, read-only .agents/.codex masks, auth receiver, watchdog,
bounded capture and ownership cleanup. For this branch use artifact read-only
workspace restrictions but never artifact result acceptance. Image must match
exact base source and TEETIME_AUTH_ARTIFACT_SOURCE_SHA=diagnostic-source.

Add teetime_minimal_protocol.py for separate helper identity/READY/RESULT checks.
Reuse artifact_hashes to verify every existing helper; require additional exact
hashes for minimal collector/runner/entry, worker/validator, diagnostic proxy
parser and this protocol. Read the same bounded source-manifest.json with extra
required helper entries. Existing artifact_hashes continues returning its same
subset. This is selected helper measurement, not complete package custody; the
future governed launcher must independently freeze the full installed source.
The new IMAGE_PATHS union adds those worker runtime files; existing image list
is unchanged. Measure all selected image bytes before emitting READY.

## New fixed operational bounds for this selector only

Keep proxy canary duration300 and every connection/network policy unchanged.
Gateway command gets only --diagnostic-receipt, never a custom destination.
Its first line is strict diagnostic ready version1; final output uses the
already reviewed diagnostic parser. Legacy tasks keep their old ready/parser.

The diagnostic watchdog deadline is300seconds; default watchdog canary already
allows that maximum. Gateway capture timeout295, idle worker container330,
actual worker capture180seconds/output8192bytes. Require remaining deadline
>265seconds at READY and >225 after credential installation. These are fixed
constants, not caller/environment options. A slow setup fails before auth;
uncertain deadline/capture/cleanup fails closed. No authenticated operation
is attempted by source tests. Future operator needs bounded32768-byte lines
and65536-byte total with its own outer timeout, not implemented in this slice.

## Separate handshake and result

READY exact keys retain type/nonce/image/sourceSha/owner/manifestSha256/workerId/
gatewayId/hashes and add task=minimal-diagnostic, diagnosticSourceSha and
diagnosticContractHash. Contract hash is SHA256 of compact sorted ASCII JSON
binding version1, kind=teetime-minimal-controller, nonce/image/baseSource/source
and the entire selected hashes map. Labels/hashes are observations, not authority.
Validate exact hash-map key set, hex identities, fixed task and contract before
the future operator reads any credential. No artifact field is accepted.

Result report retains type/nonce/owner/cleanupErrors/receiptDirectory/proxyMetrics,
plus matching task/diagnosticSourceSha/diagnosticContractHash and result exact:
passed, cleanupVerified, credentialReceived, proxyMetricsVerified,
workerExitCode(null or exact0/1), workerResult(null or validated worker receipt).
No worker result is invented when absent/malformed/abnormal; model calls remain
unknown. Retain an independently validated nested worker diagnostic even when
outer cleanup or proxy observation fails. A nested passing diagnostic cannot
make the outer result pass without all outer observations.

RESULT validation takes actual controller exit0/1 and the validated READY. It
revalidates nested worker with its actual workerExitCode, expected nonce/source,
and the diagnostic proxy record through the independent strict parser. Worker
receipt implies credentialReceived=true and workerExitCode0/1. An abnormal
worker exit may leave both null. Verified proxy flag iff non-null valid record.
Cleanup flag iff empty closed errors. passed iff credentials received, worker
passed, proxy verified and cleanup verified. Actual exit must agree with passed.
Ready/report owner and bindings must match, no extra fields or mixed schemas.

Sanitize cleanup failures to fixed fields kind(container/network/capture),
id null or64hex and failure closed known class or UnknownFailure. No arbitrary exception
message/class, path or request data. Up to5 failures. Receipt directory is the
existing bounded printable ASCII owned path. It is not accepted as resource proof.

## Tests and gates

Test strict helper/source identities, new READY/RESULT success and failure,
duplicate/unknown fields, counter/schema/binding mismatches, malformed/absent
worker output, nested pass with outer cleanup failure, actual exit disagreement,
mixed legacy/new receipts and unknown cleanup reason. Execute only invalid
argument subprocesses with auth-access traps. Test controller branch command/
limits/dispatch through source-owned pure helpers or a completely mocked Docker
driver; never call Docker/account/provider for these source tests. Cover actual
new branch selection and parser behavior, not a mirror of intended constants.

Run existing artifact protocol, auth receiver/frame, watchdog, bounded process,
worker/minimal/proxy tests plus scripts typecheck/ASCII/diff. Independent final
source review, source publication and exact-source CI required. No release merge.

After this source slice, separately design the operator and Cauldron one-use
diagnostic admission: reconcile all four terminal attempts/resources, verify
paused run and ownership, exact frozen source/image and approved policy, fresh
independent execution approval and persisted single-use claim. No current
implementation claim, consumed approval, source verdict or READY can authorize
that execution. No generic executor resume or full product prompt retry.
