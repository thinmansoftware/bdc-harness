# Non-model Codex sandbox qualification

This is a diagnostic gate, not a credentialed builder lane or demo. It invokes no
model and uses synthetic credentials only. Demo implementation remains on hold.
It does not establish SDK initial/resume options, fallback confinement, provider
transport, independent review, registry reconciliation or app CI/CD readiness.

Run against an exact built harness image:

```
python scripts/staging/run-codex-sandbox-probe.py --image IMAGE --expected-sha SHA
```

The runner inspects a newly created disposable container before starting it.
Network none, read-only root, UID1001, all capabilities dropped, no privilege
escalation, no published ports, no host devices/binds or persistent mounts.
Only four owned tmpfs paths exist. It sends the probe over stdin and removes its
own uniquely named container even after failure. No shared service is altered.
Output contains image digest, source SHA, profile/script hashes and assertion codes.
CLI version must equal 0.153.3. Unsupported environments fail rather than skip.

The named permission profile denies the root filesystem, allows minimal runtime
and read-only /app, grants the workspace through :workspace, denies tool network,
and disables general temporary-directory access. Probe children receive an explicit
environment, not inherited provider credentials. Positive baselines and command
start markers prevent startup failure from masquerading as access denial.

Assertions cover workspace effects, protected file integrity, direct/nested auth
reads, symlink read/write, parent process root access, direct/nested networking,
invalid-profile fail-closed behavior, and network control before and after tests.

## Seccomp provenance and limits

Baseline: Moby profiles commit 4b8214fc4971e06172938a1f1554ccff6647ee80,
seccomp/default.json. License retained as MOBY-PROFILES-LICENSE.
https://github.com/moby/profiles/tree/4b8214fc4971e06172938a1f1554ccff6647ee80

codex-probe-seccomp.json preserves all baseline rules and adds the 12 reviewed
rules recorded in codex-probe-minimization.json. The runner checks this exact
additive relationship. Each addition was separately removed on the BDC laptop;
each removal caused the recorded startup failure, and the complete profile passed.
These are diagnostic permissions, not authorization to use the profile in a
credentialed runtime. Seccomp cannot constrain mount path/type strings. The outer
container boundary and denied mounts/capabilities are essential.

No privileged mode, CAP_SYS_ADMIN, unconfined seccomp or host kernel changes.
The legacy Landlock path failed the required contract and is not used.

## Initial evidence

BDC laptop, Docker29.8.2, image source71625bfbe6b8b72590340e6c9059475184e90704,
image sha256:a12e527c95bf6299722ad346e9df70a81d6cf37ce34030ab0fbe2e6402694295:
18 runtime probes passed with zero model invocations. Source typecheck and lint
passed. CI uses the PR's own built image; laptop proof is not substituted for CI.
