# Tee-time supervised bootstrap source preparation

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
