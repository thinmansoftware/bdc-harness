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
