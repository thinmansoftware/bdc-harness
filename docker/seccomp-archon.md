# Archon app seccomp profile

This profile is the Docker/Moby 29.3.0 default seccomp profile plus a six-rule
delta for `services.app`: the five user-namespace rules below (#1289) and one
bubblewrap mount rule (WO-HARNESS-REVIEW-SANDBOX-BUBBLEWRAP-01). It is paired
with the AppArmor profile `docker/apparmor/archon-bwrap`. It is not full native
sandbox acceptance.

## Pinned upstream

- Moby commit: `83bca512aa7ffc1bb4f37ce1107e0d3e3489ad43`
- Engine line: Docker 29.3.0 (`83bca51`), linux/amd64
- Upstream path: `vendor/github.com/moby/profiles/seccomp/default.json`
- Fixture path: `docker/seccomp-upstream-29.3.0.json`
- Fixture SHA256: `01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28`
- Candidate profile: `docker/seccomp-archon.json`

The fixture is the bytes of that Moby commit. It is not Moby `main`. Do not
reformat `docker/seccomp-upstream-29.3.0.json`.

## Five-rule user-namespace delta

Every upstream field and every existing syscall rule stays as an ordered
prefix. That includes both original filtered `clone` rules and the complete
`clone3` rule. The unprivileged `clone3` rule stays `SCMP_ACT_ERRNO` with
errnoRet 38 and the `CAP_SYS_ADMIN` exclusion. These five rules are appended first:

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
unnecessary on every sandbox path. These five rules allow no `mount`,
`umount2`, or other syscall; the sixth rule below adds the bwrap mount
syscalls. There is no unconfined profile, no privileged mode, and no added
capability.

## Sixth rule: bubblewrap mounts (WO-HARNESS-REVIEW-SANDBOX-BUBBLEWRAP-01)

codex 0.159.2 refuses legacy Landlock for a restricted filesystem policy
(`linux_run_main.rs`: "filesystem-restricted execution requires bubblewrap to
isolate app-server sockets") and builds the reviewer sandbox with bubblewrap.
bwrap creates a new user, mount, IPC, PID and network namespace with one
`clone` (already allowed by rule 3 above), then:

- `mount`: make `/` a slave mount, bind and tmpfs mounts, read-only remounts,
  a fresh `/dev` and devpts, and optionally `/proc`.
- `pivot_root`: switch into the new root.
- `umount2`: detach the old root.

The image pins Debian bookworm's bubblewrap 0.8.0-2+deb12u1 (sha256 in the
Dockerfile). Docker always refuses a fresh `/proc` mount inside the container,
and codex 0.159.2 drops `--proc` only when bwrap's error names
`/newroot/proc`; bubblewrap 0.12 (trixie) prints `/proc` instead, so codex
never falls back and the sandbox fails.

One rule is appended:
`{"names":["mount","umount2","pivot_root"],"action":"SCMP_ACT_ALLOW","excludes":{"caps":["CAP_SYS_ADMIN"]}}`.
The container still has no `CAP_SYS_ADMIN`, so the kernel refuses these calls
everywhere except inside a user and mount namespace the caller just created.
`setns`, `mount_setattr`, `move_mount`, `open_tree`, `fsopen`, `fsmount`,
`umount`, `clone3`, `CLONE_NEWUTS` and `CLONE_NEWCGROUP` stay denied.

## AppArmor profile archon-bwrap

Seccomp is per container, so the per-program limit is AppArmor.
`docker/apparmor/archon-bwrap` is docker-default (moby/profiles template,
ABI 3.0) with its names changed. It keeps `deny mount,` for every container
process. Only an exec of `/usr/bin/bwrap` transitions (`Cx`) into the child
profile `archon-bwrap//bwrap`, which adds `mount,`, `umount,` and
`pivot_root,`. Builder lanes that do not run bwrap still cannot mount: the
docker-build smoke asserts `unshare -Urm true` fails as appuser.

`docker-compose.yml` loads it with `apparmor=archon-bwrap`. Docker refuses to
start the app container if the profile is not loaded on the host, so the host
step runs BEFORE the first recreate that includes this change:

```bash
# load (or reload after an edit); re-run after every host reboot
sudo apparmor_parser --replace /opt/bdc/archon/docker/apparmor/archon-bwrap
# to survive reboots without a manual step, install it with the system profiles:
sudo install -m 0644 /opt/bdc/archon/docker/apparmor/archon-bwrap /etc/apparmor.d/archon-bwrap
sudo apparmor_parser --replace /etc/apparmor.d/archon-bwrap
# verify
sudo aa-status | grep archon-bwrap
```

Rollback: recreate the container from the previous commit (no
`apparmor=archon-bwrap`), confirm `docker inspect -f '{{.AppArmorProfile}}'
archon-app-1` prints `docker-default`, then unload:

```bash
sudo apparmor_parser --remove /etc/apparmor.d/archon-bwrap   # or the /opt/bdc/archon path used to load it
sudo rm -f /etc/apparmor.d/archon-bwrap
```

CI (`.github/workflows/test.yml`, docker-build) loads the same file with
`sudo apparmor_parser --replace` and runs the smoke container with this
seccomp profile and `apparmor=archon-bwrap`.

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

The observed mount denial was outside the original five-rule delta. The
sixth rule and the archon-bwrap AppArmor profile are the authorized widening
(John 2026-11-02, WO-HARNESS-REVIEW-SANDBOX-BUBBLEWRAP-01). Do not widen
either further without a new WO.

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
