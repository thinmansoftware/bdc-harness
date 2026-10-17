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

## Configuration and hostile-project qualification

Run both checks after building the candidate image:

```
python scripts/staging/run-codex-sandbox-probe.py --kind configuration --image IMAGE --expected-sha SHA
python scripts/staging/run-codex-sandbox-probe.py --kind configuration --hostile-project --image IMAGE --expected-sha SHA
```

Configuration checks import the policy helper from the image, then start the pinned
app-server twice without a model call. They require the exact effective policy,
disabled extensions, empty MCP/plugin/skill catalogs and immutable empty project
configuration masks. The null glob_scan_max_depth serializer field is allowed;
extra access entries or non-null metadata are rejected.

The hostile variant creates one labeled, uniquely named workspace volume. A fixed
filesystem-only seeder writes synthetic permissive config, a harmless hook marker
command and a named skill. It runs as UID0 solely to initialize this fresh volume,
with no capabilities, network or writable root. Readers run as UID1001 with a
read-only volume. No Codex process ever runs with the hostile files unmasked.
The configuration probe uses UID1001 and the owned workspace volume under empty
read-only .codex and .agents tmpfs masks. Before and after hashes must match and
marker files must be absent. Cleanup removes only the generated containers/volume.

This proves that seeded files remain hidden/inactive during the tested starts,
not that the fixtures execute unmasked or that authenticated runtime is admitted.
The runner reports its own hash separately from image/source/probe hashes.
Laptop image97cf976b passed both configuration starts and this hostile variant;
the scripts were supplied over stdin, not claimed to be embedded in that image.

## Reachable peer network qualification

```
python scripts/staging/run-codex-sandbox-probe.py --isolated-network --image IMAGE --expected-sha SHA
```

The runner resolves the image to an immutable ID, creates one owned internal Docker
bridge and a fixed synthetic HTTP peer, and inspects both containers before starting.
No public ports, internet route, host mounts or provider credentials are introduced.
The parent must reach the peer and read its exact response before and after the
direct/nested sandbox attempts, which must fail with connection-denial diagnostics.
All22 assertions passed on laptop image97cf976b. The wrapper requires the four peer
results explicitly; skipped peer tests cannot count as success. The inspected peer
address is passed through an exact checked env value, with proxy use disabled.
Container cleanup precedes removal of the uniquely labeled network.

This proves tool denial to a reachable bridge peer. It does not establish permitted
OpenAI transport, internet/DNS policy or real authenticated runtime readiness.

## Hosted-runner mount diagnosis

On sandbox failure only, CI renders a uniquely named AppArmor profile from pinned
Moby template commit4b8214fc4971e06172938a1f1554ccff6647ee80. Source SHA256 is
7da15d81aa5c507f5002b844fdc49a969904681447a2cc29222bd6cbe797163b. Existing Moby
license applies. The sole permission-rule delta is `deny mount` to `audit deny mount`:
mounts stay denied. ABI/includes and parser success are mandatory. No fallback profile.

The runner's --apparmor-profile accepts only generated diagnostic names. It starts
the stdin-waiting interpreter, verifies the applied profile, then supplies synthetic
probe code. Attach and container exit statuses are retained. Expected probe failure
is not evidence without the matching audit record. CI records bounded named-profile
kernel denials; absent records remain inconclusive.

The EXIT cleanup identifies exact-profile users, removes only labeled owned probe
containers and verifies none remain before unloading. A cleanup failure retains the
profile. The docker-default profile, host sysctls and shared services are untouched.
Cleanup ownership/failure behavior has three deterministic tests. This is diagnosis,
not a mount allowance or permission to start a model.

The audit-only run38984030965 captured an actual denied mount at `/` with
`rw, silent, rslave`. The separately named `teetime-probe-mount-*` diagnostic candidate
replaces the blanket mount denial with exactly
`audit mount options=(rw,silent,rslave) -> /,`. All other baseline rules remain;
unmatched mounts remain denied. This single independently reviewed allowance is only
for the disposable CI diagnostic. It does not change the default sandbox test or
admit a credentialed worker. Parser success and new audit evidence are still required.

### AppArmor path diagnosis

The named diagnostic profile now carries architect-reviewed explicit mount rules
from a synthetic strace run. No proc mount is allowed; that attempt failed in the
successful reference trace. Base image was a2cc56ab4068e4126d9ade9dcc74d134b1d0f70761d73a3a4615ec575a95f733;
strace-only derivative was b85a19b86b8dc74482233aa9cdc4d23170c742a16f7b9ce9609eacdbf0df0f77.
The derivative's 18 non-model probes passed with no added caps/seccomp changes.
This is supporting path evidence, not exact-image admission. The runner parses
the named profile before use; unmatched mounts remain denied. Negative destination
and option tests require matching AppArmor audit evidence before admission.
