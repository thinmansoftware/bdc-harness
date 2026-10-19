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
