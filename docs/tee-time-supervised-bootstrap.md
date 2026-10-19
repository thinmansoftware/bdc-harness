# Tee-time supervised bootstrap source preparation

## Source-only minimal remote controller branch

The uninstalled run-teetime-auth-canary.py source now has an explicit
--task minimal-diagnostic --diagnostic-source <40hex> branch. Artifact/demo
arguments cannot be mixed with it. Arguments, including help, fail silently
before setup. This is not an admitted operator/account route; the operator
entry has no corresponding selector and no diagnostic claim exists.

teetime_minimal_protocol.py verifies the selected helper closure, a distinct
READY identity and raw RESULT with closed nested worker/proxy evidence. New
manifest helpers are mandatory with an exact selected key set; old manifests
cannot launch this branch. Full installed source custody and approved policy
remain the future governed launcher's responsibility. Existing artifact and
filesystem protocol shapes/defaults are unchanged.

The branch reuses Docker inspection, restricted worker/masks, auth receiver,
watchdog and owned cleanup. Gateway uses --diagnostic-receipt with unchanged
network/parser policy. Fixed bounds: watchdog300seconds, worker sleep330,
worker capture180/output8192, proxy capture at most295 with5seconds reserved for
its process reaping. Require >265seconds at READY and >225 after installation.
Use one monotonic controller deadline for setup, shutdown and cleanup; do not
reset it. cleanup has an optional finite monotonic deadline on this route only;
legacy default timeout behavior remains unchanged. Owned-label absence is
checked after known-ID cleanup so a lost create response cannot imply cleanup.
Unknown capture IDs are null, not invented. Cleanup reasons are a closed enum.

A validated worker diagnostic survives outer proxy/cleanup failure as evidence,
but the controller cannot pass without verified credentials, proxy and cleanup.
Missing/malformed worker output stays null with unknown model invocation count.
No app artifact output or acceptance exists on this route. Raw JSON duplicate
validation precedes nested parsing. A valid diagnostic does not prove served
model identity, entitlement, an application build or client acceptance.

Offline checks: test_teetime_minimal_protocol.py, test_teetime_minimal_controller.py
and test_teetime_watchdog.py through unittest discover. The actual controller
main is exercised with a fully synthetic Docker/watchdog/credential-frame driver
for success and cleanup failure; no Docker/account/model is contacted. New
operator integration and Cauldron one-use admission remain separate reviewed
work before installation or authentication. No attempt5 or automatic retry.

## Unregistered minimal diagnostic worker source

teetime_minimal_worker.py and teetime_minimal_worker_result.py define a separate
worker receipt, not an artifact result. The source-only remote branch above now
calls them. A future admitted image could invoke the worker with fixed --nonce
and --source arguments only after source custody, READY and account-delivery
gates. This source does not establish those gates or authorize invocation.

The worker reuses unchanged preflight, fixed environment, bounded process-group
capture, workspace snapshot and OOM observation from teetime_canary_worker.py.
It validates syntax/image-source/UID/cwd before auth reads, checks all6 preflights
and unchanged auth/workspace before one capture of the fixed-response entry.
Child timeout100s is independent of the cooperative query timer90s; the future
outer container still needs a deadline and owned-resource removal.

taskStarted means capture attempted, not proof of child/model startup. A capture
exception does not claim reaping. A returned abnormal child exit can establish
reaping while exposing null taskExitCode/taskReceipt. Missing/malformed receipt
leaves invocation count unknown. An independently validated failed child receipt
stays failed. Final cleanup/OOM uncertainty overrides task success but preserves
already validated diagnostic evidence. No private auth hash or raw errors leave
the worker; identity fields are source/nonce only. It cannot accept app source.

Offline check: `python -m unittest discover -s scripts/staging -p test_teetime_minimal_worker.py`.
Synthetic metadata normalization is test-only. No installed image, operator
account route, persisted claim or real diagnostic is registered by these files.
Actual-script invalid-argument subprocess tests use a synthetic auth-access trap;
unknown/missing/help arguments exit1 with empty stdout/stderr before auth access.

## Unregistered fixed-response diagnostic entry source

teetime-minimal-diagnostic-entry.ts is called only by the new source worker path
and is not admitted for execution. It rejects extra argv before any
guarded logger/collector/provider import. It silences console, stdout and stderr
before dynamic imports, preserving a single private emitter for the closed
receipt. Initialization failure without a valid collector receipt exits1 with
no packet. No caller prompt, model/path/duration override or stdin input is read.

The runner delegates exactly once to collectMinimalDiagnostic with its fixed
literal. A lazy async generator creates the existing restricted canary provider
and sends with /workspace, no resume and abortSignal only. Factory/import errors
remain unknown unless the actual provider tagged them. The measured policy hash
and fixed run label are not approved custody or persisted authority.

Its fixed90000ms timer begins before lazy initialization, is cleared on iterator
closure and in finally, and cannot abort a closed iterator. This is cooperative:
noncooperative imports/streams require the future worker's outer deadline and
process reaping. Clock injection is a source-test seam only, with no runtime
argv/env selector. Offline verification:
`bun test ./scripts/staging/teetime-minimal-diagnostic-runner.test.ts`.
Tests include independent Python validation, held-stream abort, private failure
and cleanup handling, and exact entry bytes with invalid argv plus an import
sentinel outside the repo's pre-entry duplicate-yaml warning. No account/model
is contacted. Worker/report source integration is described above; image, full
source custody, operator route and one-use execution remain unimplemented gates.

## Unregistered proxy diagnostic receipt

The source-only `--diagnostic-receipt` flag on teetime_connect_proxy.py selects a
separate version1 ready/final receipt. Existing callers do not set it; default
ready/final output and connection policy are unchanged. All accounting stays in
the existing measured module, with no new proxy runtime import dependency.

Only five fixed parser denial counters and six fixed non-parser phase counters
are exposed, alongside legacy aggregates. Count one outer handled failure per
connection; concurrent pump failures can increment legacy byte_limit twice.
Normal EOF, cancellation and suppressed cleanup errors are not handled failures.
Unknown parser exceptions explicitly invalidate the diagnostic even if totals
coincidentally agree. Reports require settled active0, closed enums, exact bounded
integers and consistent totals. No raw headers, values, destinations or errors
are returned. Aggregate reasons cannot establish which request caused inference
failure, nor prove account entitlement.

`parse_proxy_diagnostic_receipt` in teetime_proxy_diagnostic_receipt.py validates
the separate two-line ASCII receipt independently (4096-byte maximum, duplicate
and nonfinite JSON rejection). It rejects legacy receipts; the legacy parser
rejects diagnostic receipts. Offline checks:
`python -m unittest discover -s scripts/staging -p 'test_teetime_proxy_diagnostic*.py'`,
plus existing connect-proxy, native-header and legacy-receipt suites.

This is not proxy activation, image installation, diagnostic execution authority
or an implementation retry. A future one-use diagnostic needs a separately
reviewed worker protocol, immutable inputs, lifecycle and execution gates. No
attempt5 or automatic retry is registered.

## Unregistered minimal diagnostic data contract

`collectMinimalDiagnostic` in scripts/staging/teetime-minimal-diagnostic.ts is a
source-only collector, not an executable or account entrypoint. It sends only
`Reply with exactly OK.` to a supplied query callback, once. It requires one
assistant chunk then one clean result, normal closed completion and no abort.
Thinking is bounded and discarded. ASCII trim is explicit; malformed Unicode,
unexpected tools/routes/system chunks, ordering, excess chunks/content and
cleanup uncertainty reject. Only closed origin/hint/code and bounded lifecycle
counts leave the collector; no response, app source or private error text.
Failure records keep primary code/provenance plus an explicit cleanupFailure
boolean. A later SDK return or callback exception cannot overwrite a latched
bound or provider failure. Chunk65 stays chunk_limit with categorized count64;
callback-only cleanup is cleanup_failed/true with no normal provider end.

scripts/staging/teetime_minimal_diagnostic.py independently validates the exact
version1 teetime-minimal-diagnostic schema and actual child exit0/1. A valid
failure packet is still failed; passing proves only the tiny protocol. It grants
no wrapper custody, served-model identity, general entitlement or app acceptance.
Existing demo/fixed-artifact/worker/historical packets are unchanged.

Source verification: `bun test ./scripts/staging/teetime-minimal-diagnostic.test.ts`,
`python -m unittest discover -s scripts/staging -p test_teetime_minimal_diagnostic.py`,
and `bun test src/codex/restricted-provider.test.ts` from packages/providers. The
last command includes actual mocked native-event to collector to Python-parser
integration. Offline CI runs all three. The source-only remote selector above
does not register account delivery, an installed image or a diagnostic claim.
A real diagnostic still requires reviewed immutable inputs, exact carrier,
operator integration, authority and one-use execution gates. No
implementation attempt5 and no automatic retry.

## Source-only failure origin preservation

After consumed attempt4, provider.ts retains a private WeakMap record with only
version1 and a closed origin. It tags actual SDK iterator acquisition/advancement,
native turn.failed, unrecovered native error without a terminal, and client/thread
initialization boundaries. Interpretation errors and ordinary incomplete streams
remain unknown; recovered native errors do not mark successful results. Existing
enrichment copies only trusted identity metadata, without inspecting arbitrary
properties. Direct-file helpers are internal/testing APIs, not package exports.

No message, header, path, identifier, private-message hash or arbitrary error
property is retained in this record. It does not infer an HTTP status or
entitlement. Existing hints, errors/chunks, retry/fallback and acceptance remain
unchanged. It stays within the already measured provider file, adding no runtime
dependency or artifact-manifest shape. No worker/report protocol or proxy policy
changes occur in this slice. No installed image or account operation is implied.

Verification commands from packages/providers:
`bun test src/codex/failure-provenance.test.ts` and
`bun test src/codex/restricted-provider.test.ts`.
The offline qualification workflow runs both. Later strict failure-only receipts,
separately versioned CONNECT reason counts and any minimal authenticated
diagnostic require their own concrete reviews. No implementation attempt5.

## Closed transport-repair successor source

Version4 is only implementation attempt4, with exactly three ordered immutable
predecessor identities. Existing versions1-3 remain unchanged; version5 is not
supported. V2's single predecessor must equal history1; V3's entire ordered pair
must equal histories1-2. All historical preparation/authority/base bindings must
equal the new package. The third retained failure remains stream/model_access_hint,
with no source, unchanged auth/workspace and verified cleanup. History2 retains
its old absent-diagnostic schema and unknown invocation count.

The source-owned observer checks all15 retained files and twelve resource
queries under the existing shared20-second/30-second-freshness bounds. The claim
requires exactly three terminal rows and their full16-field hashes twice, then
reads back four rows and all historical hashes before READY and after completion.
Predecessor descriptors are snapshotted before operational callbacks.

The only new controller flag is --claim-transport-repair. Its source directory is
transport-repair-execution-harness, inventory
transport-repair-execution-source-manifest.json, and exclusive control-attempt-4.
The PC operator selects this fixed route only for a parsed v4 package. Invocation
uses the existing `invoke-teetime-auth-canary.py --task supervised-demo` options:
--image, --expected-sha, --artifact-source, --demo-package-hash, --plan-head,
--input-sha256 and --source-manifest-sha256. Every value must come from the newly
frozen reviewed carrier; never substitute or recover consumed input roots.

This is source preparation only. The corrected transport passed separate
credential-free synthetic compatibility, but neither that result nor this code
authorizes installation, a new image/package, credentials or another attempt.
Those require their own concrete scripts, measurements and independent reviews.
If a corrected authenticated attempt again yields model_access_hint, preserve
the result and stop full implementation attempts; investigate account/model
provenance rather than adding attempt5. No automatic continuation or fallback.

## Closed diagnostic successor source

Version 3 is only implementation attempt 3, with exactly two ordered immutable
predecessor identities. The retained V2 package must link to predecessor 1;
both packages must preserve the same preparation, authority and assets. Existing
V1/V2 package contracts remain unchanged. The second historical receipt retains
its null invocation count and absent diagnostics; the new diagnostic field is
not imposed retrospectively.

The observer checks both consumed packages/claims/locks/results/manifests and
historical resource IDs/owners under one 20-second budget and 30-second freshness
window, then rereads all historical bytes. The model phase requires exactly the
two terminal rows, checks both full 16-field hashes twice before claim, and
verifies both unchanged hashes alongside the inserted third row. Completion
checks all three rows again. This is point-in-time reconciliation, not an atomic
Docker/SQLite snapshot.

The fixed new selector is `--claim-diagnostic-successor`, source directory
`diagnostic-execution-harness`, inventory
`diagnostic-execution-source-manifest.json`, and exclusive `control-attempt-3`.
It neither reuses attempt-2 mode nor resumes generic execution. An existing third
row, consumed claim, changed history or rejected gate cannot cause a relaunch.

This is source preparation only. Image qualification, fresh frozen execution
package and independent exact-carrier plan review remain necessary before any
new account delivery or authenticated attempt. No candidate or demo is implied.

## Failed task diagnostic preservation

The demo worker may retain a strict failure-only packet after a normally captured
exit 1. It contains bounded counts, lifecycle flags, a closed stage, an exception
category hint, and the last event type only. It never contains raw errors, event
contents, credentials, or source bytes. Failure packets require `collected=false`
and a null artifact. Exit/status contradictions, extra or duplicate fields,
malformed packets, timeout, overflow, and uncertain reaping remain failures with
unknown task diagnostics. Legacy fixed-artifact subprocess handling is unchanged.

These diagnostics do not authorize another authenticated attempt or turn a failed
task into a candidate. Both existing attempts remain terminal and preserved. The
underlying second task failure remains unknown; this repair addresses the proven
loss of its bounded diagnostics at the subprocess boundary.

`test_teetime_worker_capture.py` exercises real POSIX child exit, timeout, combined
output limits, input, and reaping without credentials or networking. Windows skips
these four tests because pipe selection and process groups require POSIX; that
skip is not execution evidence. Run them in the isolated Linux test container.

Parent: thinmansoftware/bdc-xo#3332.
Governing proposal: bdc-xo PR3391, merged ccde0e9db705400523c4fec740aff2be0b8d0658.

This slice provides the existing Cauldron lifecycle join, a distinct v2 policy,
bounded real Git observations, and one-use controller file guards. It exposes no
operational launch, model, publication, server or scheduler entry. The ordinary v1
tee-time intake remains held. It is not a ready lane or an implemented demo.

## Invocation and verification

From a normal frozen bdc-harness dependency installation:

```
bun test ./packages/paths/src/tee-time-supervised-policy.test.ts
bun test ./packages/workflows/src/reliability/tee-time-supervised-bootstrap.test.ts
bun test ./packages/workflows/src/reliability/tee-time-supervised-prepare.test.ts
python -m unittest discover -s scripts/staging -p test_teetime_git_base.py
bun ./scripts/staging/qualify-teetime-supervised-sqlite.ts
```

The last command rejects DATABASE_URL, creates an exclusive synthetic temporary
root and a real registered Git worktree, validates the isolated ARCHON_HOME before
database imports, sets and reads back WAL/FULL, and calls existing core/store APIs.
It checks pending -> saved/read-back RunAuthority -> running -> operator-paused,
spec bytes, policy, codebase/conversation and source binding. On success it closes
the database and removes only the owned synthetic fixture and registered worktree.
Failure retains the root for reconciliation. No account, provider, real course,
booking or production database is involved. This is synthetic integration evidence,
not an operational project registration. Offline staging CI executes it too.

The Git reader preserves its original three-argument CLI. Its separate observation
form is `python -I -B teetime_git_base.py ABS_GIT ABS_CANONICAL_REPO BASE_SHA
--observe-worktree ABS_REGISTERED_WORKTREE RUN_SCOPE_SHA NAMED_BRANCH`. All values
come from trusted frozen controller custody. The actual backlink/common directory,
named HEAD and both staging refs are checked before and after object capture.
The helper does not fetch or prove the remote server is current. A fresh bounded
remote staging observation is still needed immediately before the eventual action.

## Filesystem and crash boundary

One control root belongs to one immutable run/node/attempt binding. Only the trusted
operator may write it; it must never be a model or tester mount. Exclusive creation,
file flush, exact readback, persistent claims and no automatic stale-lock recovery
provide the process-crash fence. Claim/release operations on one controller reject
concurrency. The local Windows child-process test kills the owned process after a
claim is flushed, verifies the lock and claim persist, and rejects reacquisition.
Sudden power-loss durability is unqualified. Do not claim POSIX parent-directory
fsync occurred on Windows or ignore a required flush failure. A failed/uncertain
phase remains consumed pending explicit operator reconciliation.

Claim helpers require the caller to read an actual independent GitHub approval,
head and complete binding immediately before claiming. A typed object is not
approval. Before actual invocation, the entry must also persist the existing
ProviderAttempt and require its unique insertion succeeds. Neither source helper
alone provides model or publication authority.

## Fresh environment evidence, October 18, 2026

One independently reviewed credential-free repair acquisition from harness
f98bf393d13d03cc72b07a1dcdc7561ddb0f5363 succeeded on the BDC Docker laptop.
Its first failed xz acquisition remains retained as failure; no automatic retry.

- Minimal two-file context SHA256:
  269c3c2903378e2ca2e2f71d46012890b61d4b16c351a37936210f4e6f7bde82.
- Actual Linux amd64 image:
  sha256:41cccc7d75787aae96695a5ad64a5b209553e95c2f511e482abc7b24201cccbe.
- Exact package643 bytes, SHA256
  815244c8bed999c701f6f92510133b089f7cdd62ac24dccf33095ac8609752d7.
- Complete bun.lock15708 bytes, SHA256
  cd0c2e062091dfc8a463bdd67b7e97ccc12de06dca0be3aa787ce737a22f15ba.
- Node24.22.0, Bun1.3.11, Next16.4.2, React19.3.1, TypeScript5.9.3,
  Playwright1.64.1; version checks and Next native SWC load passed without network.
- A separate owned read-only/no-network container read the complete manifest/lock
  and installed command/version output. Its container absence was verified.

The complete acquisition outputs are retained under scripts/staging/teetime-demo-assets.
Their eventual prepared-base merge must reject collisions, preserve original and
prepared identities, and exclude these assets from model writes. Browser sandbox,
frozen reinstall, readonly build, operational entry, native artifact attempt, app
CI/CD, accessible preview and physical iPhone acceptance are still unverified.

Fresh actual registered Hetzner source HEAD/local staging/origin staging and GitHub
staging all read bf6e8935768cf39ebb56b3ef44535830fd71ea7f. The laptop does not have
that registered source at its normal ARCHON_HOME path. Do not invent a checkout
from a registry name; explicitly prepare/register the distinct isolated staging
checkout before operational use. Windows laptop Bun1.3.13 exists. This is separate
from the Linux app/test image Bun1.3.11 and must remain explicit in runtime records.

## Remaining execution boundary

Finish the full simulated walkthrough case/WO and immutable assets, closed loader
mode, reviewed staging entry, complete-artifact launcher, actual source/isolation
CI and independent exact-case approval before ONE account-bearing attempt. Preserve
no Claude/Fable/fallback, existing account integrity and all cleanup checks. Then
test the complete app, review the candidate, verify app CI/CD, deploy only its
isolated staging preview, and verify that served journey before reporting ready.

## Browser environment failure and proposed source repair

The ONE approved static browser smoke under Docker's default restrictions failed
with Chromium reporting no usable sandbox. It used chromiumSandbox:true, no
network/account/app, UID1001, read-only root, no capabilities, no-new-privileges,
private IPC256MiB, memory1GiB and tmpfs/tmp512MiB. The container was removed and
its exact absence verified. The failed result is preserved; it is not acceptance.

Playwright's official Docker documentation describes adding namespace permissions
for clone/setns/unshare to Docker's default seccomp profile while using a separate
user: https://playwright.dev/docs/docker . The pinned upstream source is
https://raw.githubusercontent.com/microsoft/playwright/v1.64.1/utils/docker/seccomp_profile.json .
The new teetime-browser-seccomp.json extends our retained default with only that
documented three-call rule. Its pure source test proves this exact difference.
The native cause is not yet established: AppArmor or another host restriction
could still prevent a sandbox. Source publication grants no retry. One new
source/hash-bound environment-only smoke needs independent review before use.
Keep Chromium sandboxing enabled and preserve all other controls; no SYS_ADMIN,
privilege, host IPC, AppArmor disable or broad daemon-policy change is proposed.

The first profile selection attempt was rejected before start; its receipt folder
contains only result.json and cleanup was verified. The next independently reviewed
operator correction passed no-new-privileges:true explicitly and recorded closed
preflight diagnostics. Preflight passed; Chromium then failed at
sys_chroot("/proc/self/fdinfo/"). Client/container exit1, no OOM, and cleanup passed.
The retained default permits chroot only with CAP_SYS_CHROOT, which CapDrop=ALL
excludes. The independently reviewed source repair adds exactly one unconditional
chroot allow rule. Seccomp cannot restrict its pathname or attest it runs only
inside a child namespace; kernel capability checks and the outer container controls
remain. No capabilities are added. The precise source comparison test now requires
only the namespace rule and this chroot rule over the unchanged default.
One fresh hash-bound static smoke is conditionally approved after commit/freeze;
preserve failure and stop if it fails. No application/account run follows from it.

The source809ecbfd48c6dd2570144406a344e8e852c2dfe2 smoke subsequently passed:
Chromium156.0.8078.4, sandbox enabled,390px static fixture, client/container exit0,
no OOM and owned-container absence verified. Profile SHA256
971a338323570a78dbfcb6337720373afab0fa9b621e6a0f48be404fb5a4dae6.
This qualifies only that static browser environment. Source CI39168977518 also
passed on the809ecbfd source lineage; it did not execute an account/model case.

## Proposed ONE synthetic framework qualification

qualify-teetime-framework.py is a source template that rejects its unfrozen source
markers. Before use an operator must freeze its exact source revision, public
payload/hash and derived helper/hash under independent review. It is not an app
or an operational build entry. Fixed image/profile remain the qualified values.

The source fixture is deliberately titled Framework environment only. Six trusted
prepared assets are combined with the four source-owned fixture texts. A first
unprivileged, no-network container uses one fresh owned volume, copies only the
public image Bun cache, performs --frozen-lockfile --ignore-scripts install, and
runs installed Next typegen. It records complete generated config bytes. Its sole
writer is removed before a second container mounts that source/dependency volume
read-only. Only .next, /tmp and /results are writable tmpfs paths. That verifier
runs the fixed unit, Next webpack build, typecheck and two-viewport browser commands,
checks source hashes unchanged, and closes the owned resources. Each role is capped
at3GiB RAM/swap,2 CPUs,256 PIDs, private IPC256MiB and a300-second phase deadline.
No account, host mount, Docker socket, host port, provider, production or product
feature is involved. A failed/unknown result remains failed and needs a new review.

The Next declaration/config asset contents were grounded in the installed16.4.2
writeAppTypeDeclarations/writeConfigurationDefaults sources. In particular this
version also imports .next/types/root-params.d.ts. Generated config is an output
to inspect/freeze, not a reason to silently rewrite a later reviewed candidate.
The complete case/WO and model execution remain unadmitted until this and the
remaining source/controller/launcher checks are satisfied.

Independent pre-execution review required four controller corrections: reject any
existing exact volume name and validate local driver/options/mountpoint; bound stdin
delivery and reap the attach process; verify the complete security/argv/tmpfs/mount
preflight; and bind verifier initial/final hashes to accepted writer bytes. These
are implemented with custody regressions observed failing before implementation
and then passing. Only next-env.d.ts and tsconfig.json may be generated changes;
their complete bytes are retained for inspection/freeze. All other fixture bytes
must remain identical. The300-second outer deadline intentionally overrides the
sum of the individual120-second command limits. Timeout remains failure.

The one frozen framework case at acdbbd0236bf9eff12be3bc2114e838dd9d5afe6 passed
on the actual BDC Docker laptop. Helper SHA256
22108e6eb04104b302f6ad91d72b994cd6cc1251166ff0ddaff817bf9f436368;
payload28342 bytes, SHA256
9ed29a047e9805bc4d440ab4bd7b9ed84b74c80bbd21c0c5379dfa8c587a2f7a.
Cached frozen install/typegen, Bun unit tests, Next webpack production build,
TypeScript noEmit and both390/1440px browser checks returned0. All ten accepted
source hashes matched before/after; generatedChanges was empty. Both containers
exited normally with no OOM, attach clients reaped, exact container and volume
absence verified. No account/model/product feature/host port was involved.
Source CI39170996165 also passed for that source lineage. This is framework
qualification only; the complete app case/WO and operational entry remain gates.

The full app source-case draft now separates seven model-editable source paths
from nine immutable prepared dependency/configuration/acceptance assets. The model
may write its product unit tests; the trusted walkthrough and CI gates are excluded.
Preparation retains original and prepared manifest/tree identities, rejects base
drift/collisions and preserves every immutable asset. Six pure regressions include
an exact65536-byte artifact and rejection at65537 bytes. The new demo-only complete
frame bound is147456 bytes; original global/fixed canary limits are unchanged.
Ruling: required matching-filter and in-flight-refresh acceptance expanded the
trusted test source beyond the earlier131072-byte conservative full-frame bound.
The new finite bound covers the derived closed inventory without reducing coverage
or expanding model output. Actual launcher support/packet bounds are still pending;
this pure helper does not prove transport readiness or grant an account attempt.

## Preparation-only staging entry source

teetime-supervised-controller.ts and teetime-supervised-entry-guard.ts add the
fixed Windows/Bun1.3.13 preparation entry from Task2. They are not yet installed,
qualified on the staging host, registered through XO intake or execution-admitted.
The sole accepted action is --prepare --input-sha256; there is no run/publish mode.
The reviewed outer command must enforce Bun --no-env-file before entry. Reject
DATABASE_URL (including empty), foreign assistant or ARCHON_HOME before DB imports.

The fixed owned root is homedir()/teetime-supervised-01, with frozen source under
harness/, operator-input.json and harness-source-manifest.json, four complete plan
files under plan/ and the isolated archon/ project tree. The source-file inventory,
workspace link targets, binary/helper/case/asset bytes and all plan hashes are read
back. Host dependencies still need frozen acquisition/readback; links alone do not
attest third-party package bytes. Existing unrelated checkout dependencies are not
silently reused. Actual laptop inspection found the old project package but no
root pino/pg/zod or workspace-link package paths, so it is not a qualified runtime.

The preparation entry checks the actual Git origin, named worktree/staging refs,
and absence of archon.db plus SQLite -wal/-shm/-journal sidecars. It retains claims
on failure; normal real-store readback/close is required before lock release. A
separate original-app bundle was acquired on the PC only: bf6e8935, tree3b6c5d68,
README93 bytes, bundle1027 bytes SHA256
0dce582e29f0ba9035a77882f4ac6c898f34d790327297422c46f641701495ca.
GitHub staging was rechecked. No working tree/BDC source/account/run was created.

Six local entry/guard tests pass26 assertions, including real sidecar fixtures,
wrong-origin rejection and a child entry rejecting shared DB before core imports.
These do not exercise successful operational preparation. The actual source/store
qualification and future authenticated launcher/candidate/CI/CD gates remain separate.

## Owned host dependency acquisition

Source93b6bb611fb424aac3b756993f0c1a8dc702f7ca passed CI39173214668.
A local Git archive contains2082 files/40352772 source bytes; archive SHA256
695b3c49b38bc1d1b92fffdbd0d00c58846498cec0eb7d5af3d8169c212db1f3,
manifest SHA25613cd53880ca4180158711640a6dde69c6ab727864a758fae595c1555820588ce.
The laptop Bun1.3.13 binary hash was read directly:
8dc0cd4351f596df6bb71c03575168078bb0f9872ef4d5ff1b8579dd9507cf70.
The intended teetime-supervised-01 root was absent at that observation.

The draft scripts/staging/acquire-teetime-controller-deps.py accepts only these
fixed public inputs under teetime-controller-input-93b6 in the laptop home. It
creates a fresh staging root, rejects archive links/unsafe paths, verifies all
source bytes, and runs only the pinned Bun frozen-lockfile install with lifecycle
scripts disabled. The environment has owned empty home/config/cache/temp paths
and no inherited credentials, proxy or preload settings. The install has a600s
deadline and2MiB output bound; failure retains the owned directory without retry.
Source bytes, workspace links and dependency inventory are checked afterward.
Existing Claude SDK package bytes are inert dependencies of this harness; the
installer does not import or execute them or any provider. This does not qualify
the actual controller or authorize account delivery.

Invocation after independent wrapper review and frozen-input readback:
`C:/Program Files/Python312/python.exe -I -B <frozen-wrapper-path>`.
No invocation has been made at this source checkpoint. A successful install must
retain its actual receipt before the complete preparation package is evaluated.

Subsequent actual execution on the BDC laptop succeeded with wrapper45b66ba9
(full SHA25645b66ba9ad8796b93060850f2a37ffa9e77925b6db919450ef05343297a0573e).
The install process returned0 and was reaped; lifecycle scripts remained disabled.
All2082 archived source files were unchanged, including the lock. The complete
dependency inventory covered69388 entries and has SHA256
eb1f4fff70bbe3708ad1b4d34e63ca0e102d90ea554647e77d48abe09469a129.
No account, model invocation or controller start occurred. The exact receipt and
process receipt are retained in the local audit directory.

The separate app source and named demo/simulated-walkthrough-01 worktree were also
created beneath the isolated ARCHON_HOME from the verified bundle. Actual HEAD,
local staging and origin/staging all matched bf6e8935768cf39ebb56b3ef44535830fd71ea7f;
GitHub staging was read back at that same commit. No feature was implemented.

The complete UI-contract/prepared-base prompt helper now has7 passing pure tests,
including rejection of contract drift and wrong prepared-base identity. It supplies
complete immutable source references and exact artifact binding, without truncating
the contract or granting execution. Actual demo task/protocol wiring remains pending.

## Actual isolated preparation and demo collector checkpoint

The preparation-only entry now succeeded on the BDC laptop, with actual child
exit0 and reaped=true. Run6e1379d3959a5e5b373130cb11742018 was created and read back
paused through the real isolated Cauldron store. It used source93b6bb611fb424aac3b756993f0c1a8dc702f7ca.
Case hash: sha256:e03c392ccbc926e097e113e80a472591d70e772b8630d0e8d2027bfebc351084.
Authority hash: sha256:52a48f0855ef52bbf2b2530e8e932b256b658a010c591c7badd984dcffe17e32.
Prepared binding: sha256:4288d5136730fc31b67cf11f136dfdbc2abed73ac064805dd89bf630199bf7e7.
No account was supplied and modelInvocations=0; operationalLaneReady=false.
Actual stdout/process receipts are retained in the local audit directory and
the laptop prepare-evidence-complete-archive directory.

Two earlier preparation attempts rejected before store creation because hashes
from Git blobs did not match CRLF bytes in the Windows-produced Git archive.
The final input explicitly binds actual archive case/helper bytes, with no
runtime hash normalization. Original inputs and failed receipts remain retained.

The new unregistered demo task collector reuses the existing stream collector
and SDK lifecycle unchanged. It returns collected data, never a passed build.
The separate Python validator checks actual task exit, canonical bounded base64,
normal single invocation/terminal evidence and parse_demo_artifact against the
prepared base and actual expected binding. A complete65536-byte artifact fits
the90112-byte task-result bound; overflows and immutable-file changes fail closed.
The entry takes only a bounded stdin packet and uses the actual supplied run ID,
verified worker-policy bytes and an explicit600s model deadline. It does not
load an arbitrary prompt file, grant authority, or implement a fallback provider.

Local verification:12 Bun tests pass (including unchanged fixed canary),10 Python
tests pass. Local full scripts typecheck is BLOCKED by missing provider/ACP SDK
dependencies in this checkout; no clean typecheck is claimed. Source checkpoint
a97a12be5 passed CI39185176814 before these new collector files.

Still required before any model invocation: finish the closed demo selector and
READY/result transport, freeze the new execution-package identity referencing the
existing prepared binding, independently review the exact current plan/head,
consume the model-phase claim and persist the real provider attempt. The prepared
authority is not rewritten to pretend it covered the new execution package.
Then validate and test the actual app candidate and publish only isolated staging.

The prompt builder now requires and hash-checks the complete work order and
implementation plan too. A local size rehearsal with the frozen plan documents
produced120041 prompt bytes and123553 encoded input bytes, within131072/160000
bounds. This is sizing evidence, not a frozen operational execution package.
Architect source review approved publication of this collector slice, with these
limitations: modelInvocations counts attempted query calls, the600s timer covers
the query only, and the outer launcher must bound the complete process and align
proxy/watchdog/credential lifetimes. No independent plan approval was fabricated.

## Demo transport integration checkpoint

Head5e2bd3e0fe808373fc00b01e8899f2312f54c594 passed CI39186188069.
The next source slice adds a closed immutable execution package, complete prepared
base reconstruction and READY/RESULT binding to that package hash. The existing
worker now has a supervised-demo branch that uses the same auth/workspace/OOM
checks and independently parses the source candidate. The remote controller can
carry that bounded packet. The operator CLI deliberately rejects this selector
before SSH/account access until the persisted review/claim/attempt join exists.

Frozen demo timing is query600s, complete worker630s, controller proxy720s,
watchdog780s and idle container810s. One worker deadline starts before preflight;
the provider cannot start unless at least610s remain after a5s cleanup reserve.
The task receives only that remaining budget, with the unchanged600s query timer.
The outer capture allows650s for process reaping. Setup must leave690s before
READY and660s after credential delivery on the original watchdog clock. Canary
defaults remain unchanged. The proxy retains its30s idle-tunnel limit.

The package binding is immutable after parsing, including a regression against
changing its run ID after hash validation. Exact hash matching remains data
integrity evidence, not independent approval or authority. Actual prepared binding,
source/image inspection and the phase claim still need the trusted controller join.

Credential-free Linux qualification on the cached laptop image exercised the
actual nonblocking160000-byte task stdin writer, a child that stopped reading
until its deadline, and an early-exit child. All passed with process reaping and
zero model invocations. Receipt demo-stdin-worker-qualification-final.json retains
worker source hash fed874a67da698341d1927a74f9b322b6c4bcab80d74256383f247c7ac41b7bc.
No authenticated demo run, app candidate or preview exists at this checkpoint.

## Supervised model phase transition

The source-only claimSupervisedModelAttempt helper now joins current independent
exact-head review, the prepared binding, the existing exclusive model-phase claim,
and creation/readback of the sole restricted provider attempt. It rechecks current
state before claiming, snapshots observations before later awaits, rejects stale or
superseded approvals using submission time, and retains the consumed claim after
persistence failure. The attempt records codex-native-strict/text_generation and
does not assert a served model. Fourteen focused transition/bootstrap tests pass,
including shared-object mutation and wrong persisted-attempt readback regressions.
Independent architect source review accepted the corrected helper for publication.

These callbacks are not operational authority by themselves. The existing PC
operator must fetch the real current PR/head, exact execution-package bytes and
every review page before supplying the bounded observation over authenticated SSH.
The laptop GitHub CLI is installed but its read-only user request returned401;
GitHub credentials remain on the PC. The accepted narrow route uses no token copy
or new approval service. The remote entry still verifies its actual prepared run,
base/source/package, and persists the claim/attempt before any account delivery.
Observation-to-claim must have a short fixed validity window and cannot be queued
or automatically replayed. GitHub/SQLite are not an atomic transaction.

The operational PC observation packet and remote entry join are still outstanding.
No model-phase claim has been consumed by these source tests. New demo collector,
execution/result and phase-transition tests are explicitly included in offline CI.

## Live plan observation source checkpoint

CI39187639845 passed at25f06984880139f5c192b87b04633a0f04799785.
The PC observer now reads the actual private PR3392, exact-head package bytes,
all review pages and a final PR head. It emits a closed packet bound to the run,
package, prepared binding, remote and fresh nonce. The remote parser rejects
expired, foreign or malformed packets and freezes its parsed review snapshot.
Five Python and four Bun tests pass, including a Python-produced packet consumed
by the TypeScript parser. The live PC GitHub read succeeded; the execution package
has not yet been published, so no approval or execution is claimed.

The45-second collection window is a freshness rejection window, not an overall
process deadline. Individual reads are bounded; GitHub observations are not an
atomic snapshot. The operational join must recheck expiry on every callback and
must accept only the live authenticated SSH packet, never a saved receipt. The
remote persisted-run join and authenticated launcher remain outstanding.

## Supervised model launcher connection

The source now connects the fresh PC observation to the existing paused run and
one-use claim, persists/reads the restricted provider attempt, and only then starts
the existing authenticated launcher. The original preparation archive and authority
stay unchanged. The new execution archive is separately inventoried; prepared
runtime-revision inputs must match, and full authority readback remains active.
The PC observation also reads the actual app staging ref before emission.

The operational entry uses Bun1.3.13 with --no-env-file from the separately frozen
ROOT/execution-harness source. Its closed argument sequence is:

```
bun --no-env-file scripts/staging/teetime-supervised-controller.ts --claim-model --input-sha256 INPUT_HASH --execution-sha256 PACKAGE_HASH --source-manifest-sha256 INVENTORY_HASH --source-sha SOURCE_SHA --review-head PLAN_HEAD --nonce FRESH_NONCE
```

Use only the PC operator entry to invoke it over authenticated SSH. That entry now
accepts --task supervised-demo with --image, --expected-sha, --artifact-source,
--demo-package-hash, --plan-head, --input-sha256 and --source-manifest-sha256. It
reads the frozen local demo-execution.json, obtains fresh actual GitHub observations
and writes one bounded observation line. Login remains unread until independently
validated READY. No saved observation file is an accepted authority input.

The same single remote stdin reader then carries the bounded credential frame.
Raw READY/RESULT bytes reach the independent Python validator unchanged; duplicate
keys cannot disappear through JSON normalization. All child/input/output waits are
bounded. Cancellation, pump settlement and reaping are all attempted even when one
cleanup promise fails. An uncertain outcome retains the consumed claim and lock;
there is no automatic retry. The run remains paused throughout.

Verification includes eight real-child transport tests, two bounded operator-write
failure tests, two independent candidate/cleanup parser tests, and both entry
rejection paths. Existing protocol, worker, model-phase and entry-guard tests pass.
Local scripts typecheck remains blocked by missing pre-existing provider SDK
dependencies; no errors for these new files remained in its diagnostic output.
CI39188515400 passed at6de728c3b56872ac868f4947c6900a5f72998aff, before this slice.
This connection still needs frozen-source CI, image/package publication, actual
independent plan review and operational qualification. No authenticated model call,
app candidate, preview or app acceptance is claimed by these source tests.

## First actual supervised artifact attempt and workspace repair

The exact independent plan approval was recorded/read back as review5566379440 on
private XO PR3392 head87752712da99215e31b94de945f9326a6e5e094c, package
9c78858430bb9a2b4f367ca61a0c4b8741e9d6b7070e4bb4628bae7a8e48032d.
The source was e06e33948b6d2a52d47e27d93eacf014ce5cf16e and measured worker
9d80557360897e64268ee5f245c1e82d25dc09665de71544700d3a587e531945.
The native base actually reports3a9fbee193100897c5064dabfdc2cd6697b7618e;
an incorrect historical base assumption and initial LF/CRLF policy-hash mismatch
were rejected before controller/account use and retained separately.

Actual attempt ec3fd06e-5f27-4eda-9af1-2f759e4157ae on the existing paused run
completed at2026-10-19T02:43:09.062Z. Six authenticated preflights, one query,
one assistant/terminal, normal stream/iterator closure and candidate parsing ran.
Final workspaceUnchanged was false, so every artifact byte/identity was scrubbed.
The result is FAILED: quality/required_stage_failed, not an accepted app candidate.
Worker auth remained unchanged, OOM delta0, proxy and owned cleanup verified.
A fresh read found no owned containers/networks. First result SHA256:
131db951dc23fff63896c9fb581783e0da86cb9abe72521b2acb67e17b4608b5.
The first claim, lock, authority and receipts remain retained; no automatic retry.
The failed packet does not identify the workspace delta; its cause is unproven.

The source repair removes writable /workspace tmpfs in artifact/demo modes only,
requires an image-owned empty directory and retains the two read-only masks.
Before READY, actual write/create denial must be EROFS and rename must fail with
EROFS/EBUSY. Filesystem-canary mounts remain unchanged. The new image must separately
prove the underlying ordinary two-directory inventory before runtime masks apply.
No such repaired-image qualification or second authenticated attempt is claimed yet.

Demo-only diagnostics contain a closed category and capped counts, no names/content
or raw exception. They remain subject to strict consistency and cannot convert a
failed workspace check into success. Four workspace tests, eleven protocol tests,
six worker tests, four existing operator tests and two controller-parser tests pass.

```
python -m unittest discover -s scripts/staging -p test_teetime_artifact_workspace.py
python -m unittest discover -s scripts/staging -p test_teetime_auth_artifact_protocol.py
python -m unittest discover -s scripts/staging -p test_teetime_auth_artifact_worker.py
```

Any successor needs a separately reviewed package binding the terminal first
attempt/result and explicit reconciliation, a fresh attempt-specific control root,
supersedesAttemptId, fresh approval and the existing store/claim readback. The
existing first-attempt rejection is not bypassed or reset. App implementation,
actual app tests, app CI/CD, candidate review and preview remain outstanding.
# Bounded successor source preparation

The first simulated-app source attempt failed its workspace check. It remains
consumed. A version-2 execution package can describe exactly attempt 2, with a
closed predecessor ID/completion time/row hash/execution hash/result hash/claim
hash/resource owner/manifest hash/lock hash. Version 1 remains first-attempt-only.

The model-phase helper can validate a separately reviewed successor using two
fresh source-owned reconciliation observations and complete stored-row readback.
It inserts attempt 2 with supersedesAttemptId and preserves attempt 1. It rejects
stale or uncertain observations, changed rows, existing successors and concurrent
duplicate claims. This is a point-in-time operator observation, not an atomic
Docker/SQLite transaction or a generic retry service.

Successor OPERATIONAL EXECUTION IS NOT ADMITTED yet. Source now provides a closed
`--claim-successor` entry in `successor-execution-harness`, requiring the complete
`successor-execution-source-manifest.json` inventory. It creates the deterministic
`control-attempt-2` directory exclusively, never reusing or recovering an existing
directory. Original preparation custody always remains `control` and `harness`.

Before the successor claim, a source-owned callback verifies the actual paused
run and authority, original package/claim/lock/result/manifest hashes, terminal
workspace failure and cleanup, absent exact Docker IDs (even without labels), and
absent additional owned resources. Files are reread for stability. Both
reconciliations expire after 30 seconds. Failed queries or uncertain state reject.
The bounded observer has no account access and makes no Docker mutations.

Remaining operational gates are a freshly frozen/installed source, measured image
including its actual parser/helper bytes, complete attempt-2 prompt/package, and
new independent exact-head approval. No source fixture authorizes an authenticated
successor. Do not invoke the closed entry from the existing consumed installation.

## Third-attempt diagnostic source (no retry authority)

Attempt 3 is terminal and consumed, with no app candidate. Its retained
model_access_hint is derived from message classification, not an observed server
status. The mocked provider provenance regression demonstrates that a local
catalog error can become the same account-access wording. Run it with:

`bun test ./packages/providers/src/codex/provider.test.ts`

The CONNECT parser now raises a ValueError subclass with five fixed reasons.
Its acceptance rules, aggregate counters and receipt shape are unchanged. The
reason contains no host/header/payload values. Verify with:

`python -B -m unittest discover -s scripts/staging -p test_teetime_connect_proxy.py`

The native diagnostic helper `scripts/staging/teetime_native_transport_fixture.py`
is not a production worker or authenticated-canary entrypoint. It requires a
separately reviewed owned container: pinned image, network none, read-only root,
user 1001, fresh tmpfs /tmp, no host mounts, account files, ports or Docker socket.
The wrapper must inspect these properties before start, bound/reap the process,
remove only the exact owned container and prove absence. The helper uses the
pinned SDK/binary, a synthetic API credential and an empty temporary HOME.
A loopback mock feeds native CONNECT bytes to the parser and always returns403;
it never resolves or dials an upstream or terminates TLS. Only finite reason
counts and fixed event/cleanup fields may leave it. Fixture-specific base URL and
proxy values must never enter production configuration.

Passing this API-auth transport fixture does not establish ChatGPT-login
transport parity, entitlement, completed inference or the original failure's
cause. No real account access, binary/model change, proxy policy relaxation or
fourth authenticated attempt is authorized by these source changes.

## Contract Amendment: bounded User-Agent metadata

Two separately reviewed synthetic ChatGPT-mode fixtures reproduced eleven
unsupported_header denials; the closed header classifier identified user_agent
in all eleven. The API-key framing fixture had no such denials. These are
credential-free compatibility observations, not proof of attempt3's cause or
model entitlement. Original receipts and frozen parsers remain immutable.

The independently reviewed source-only amendment permits one case-insensitive
User-Agent field: its value must be at most256 bytes before trimming, contain
only ASCII0x20 through0x7e, and contain a non-space character after existing space
trimming. No value is logged, hashed or persisted. Destination/method/port,
duplicate detection, total-header bound, DNS validation, tunnel byte/time limits
and every other header rule remain unchanged. Authorization, Proxy-Authorization
and Accept still fail closed. This is a new parser/source identity, never an edit
to a consumed package or live proxy installation.

Source stop conditions:

- `python -B -m unittest discover -s scripts/staging -p test_teetime_connect_proxy.py`
- `python -B -m unittest discover -s scripts/staging -p test_teetime_native_header_diagnostic.py`
- New exact-head CI, then separate review of one frozen synthetic ChatGPT fixture
  using the amended parser. Require local mode proof, no unsupported headers,
  no upstream/turn completion and verified process/resource cleanup.

This amendment is source preparation only. It grants no authenticated retry,
model/binary change, egress expansion or production deployment.
