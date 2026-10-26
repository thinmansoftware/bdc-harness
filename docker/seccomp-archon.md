# Archon app seccomp profile

This profile is the Docker/Moby 29.3.0 default seccomp profile plus a five-rule
user-namespace delta for `services.app`. It removes only the namespace
prerequisite. It is not full native sandbox acceptance.

## Pinned upstream

- Moby commit: `83bca512aa7ffc1bb4f37ce1107e0d3e3489ad43`
- Engine line: Docker 29.3.0 (`83bca51`), linux/amd64
- Upstream path: `vendor/github.com/moby/profiles/seccomp/default.json`
- Fixture path: `docker/seccomp-upstream-29.3.0.json`
- Fixture SHA256: `01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28`
- Candidate profile: `docker/seccomp-archon.json`

The fixture is the bytes of that Moby commit. It is not Moby `main`. Do not
reformat `docker/seccomp-upstream-29.3.0.json`.

## Five-rule delta

Every upstream field and every existing syscall rule stays as an ordered
prefix. That includes both original filtered `clone` rules and the complete
`clone3` rule. The unprivileged `clone3` rule stays `SCMP_ACT_ERRNO` with
errnoRet 38 and the `CAP_SYS_ADMIN` exclusion. Exactly five rules are appended:

1. Non-s390 unprivileged `clone` (flags argument index 0) with `valueTwo`
   `268435456` (`0x10000000`, `CLONE_NEWUSER`).
2. s390/s390x unprivileged `clone` (flags argument index 1) with `valueTwo`
   `268435456`. Argument index 1, the architecture inclusion, the comment, and
   the `CAP_SYS_ADMIN` exclusion stay.
3. Non-s390 unprivileged `clone` (argument index 0) with `valueTwo`
   `2013396992` (`0x78020000`). Those bits are `CLONE_NEWNS`, `CLONE_NEWIPC`,
   `CLONE_NEWUSER`, `CLONE_NEWPID`, and `CLONE_NEWNET`.
4. s390/s390x unprivileged `clone` (argument index 1) with `valueTwo`
   `2013396992`. Argument index 1, the architecture inclusion, the comment, and
   the `CAP_SYS_ADMIN` exclusion stay.
5. `{"names":["unshare"],"action":"SCMP_ACT_ALLOW"}`.

All four added `clone` rules keep mask value `2114060288` (`0x7e020000`) and
`op` `SCMP_CMP_MASKED_EQ`. `SIGCHLD` sits outside that namespace mask, so it
still matches when paired with the allowed namespace bits. No other
`CLONE_NEWUSER` combination is allowed. `CLONE_NEWUTS` and `CLONE_NEWCGROUP`
stay denied. Original no-namespace `clone` behavior stays unchanged.

`setns` was not added. The isolated trace did not reach `setns` before the
mount failure, so necessity is unproven. This is not a claim that `setns` is
unnecessary on every sandbox path. No `mount`, `umount2`, or other syscall was
allowed. There is no unconfined profile, no privileged mode, and no added
capability.

## Historical isolated proof

Recorded 2026-10-26 on hetzner-prod. This is historical evidence from an
isolated container. It is not a deployment and it is not production acceptance.

- Image: `sha256:60140703b12328bafa7bf3ea51b456557758ce0e386724488762b13dd5154212`
- Default-profile `unshare` failed with Operation not permitted, exit 1.
- Candidate-profile `unshare` printed OK as root.
- Candidate-profile `unshare` printed OK as UID/GID 1001.
- `clone3` returned ENOSYS. The fallback `clone` was inspected.
- Combined namespace `clone` succeeded.
- `mount` then returned EPERM.
- No `setns` call occurred before the mount failure.
- bwrap: Failed to make / slave: Operation not permitted
- CODEX_SANDBOX_OK was NOT printed
- Live `archon-app-1` stayed on its original image.
- SecurityOpt was null.
- AppArmor profile: docker-default
- Privileged was false.
- CapAdd was null.

## Runtime boundary

Full native sandbox acceptance is BLOCKED.

The observed mount denial is outside this delta. Do not widen the profile to
make the native sandbox command succeed.

Production activation is UNVERIFIED.

This WO grants no deployment authority.

A separately authorized XO rebuild, scoped to the current environment and
commit, is required before the running container changes. After that rebuild,
userns and the effective profile must be re-proved. Source CI cannot stand in
for that evidence. Missing or failed runtime evidence stays blocked.

Namespace success does not close #3654 or #3258. Issue #3654 remains the
fail-closed review contract. Issue #3258 remains the reliability parent. Full
sandbox acceptance still needs a successful native execution and no
sandbox-start failure in a real review.
