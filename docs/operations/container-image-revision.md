# Container image revision

`archon-app-1` used to report `org.opencontainers.image.revision` as `a04817ce`. That value was inherited from the base image `oven/bun:1.3.11-slim`. It is not a commit in this repo: `git cat-file -e` could not resolve it. `ARCHON_BUILD_SHA` inside the container was `unknown` because the image build did not set the build arg.

The production stage now sets `org.opencontainers.image.revision` from `ARCHON_BUILD_SHA`. The wrapper below stamps that arg with `git rev-parse HEAD` and checks the label on the built image.

## Build

Run from a clean checkout of the repo root:

```bash
bash scripts/container/build-app-image.sh
```

The wrapper does not restart, stop, remove, or recreate containers. Its only Docker commands are `docker compose build app` and `docker image inspect` of image `archon`. Inspect `archon-app-1` only after the separate governed recreate.

## Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Success. Stdout is `built archon revision=<SHA>`. |
| 3 | Dirty tree (`git status --porcelain` printed something), or HEAD is not 40 lowercase hex. Docker is not called. |
| Docker status | `docker compose build app` failed. The wrapper exits with that status and does not inspect the image. |
| 4 | Image `archon` revision label does not match HEAD. Stderr is `revision label mismatch: expected <SHA> found <found>`. |

## Post-merge acceptance

On the harness host, after merged `dev` is checked out in `/opt/bdc/archon` with a clean tree:

```bash
cd /opt/bdc/archon && bash scripts/container/build-app-image.sh
```

Then recreate `archon-app-1` under the governed rebuild, and verify:

```bash
L=$(docker inspect archon-app-1 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
git -C /opt/bdc/archon cat-file -e "$L" && test "$L" = "$(git -C /opt/bdc/archon rev-parse HEAD)" && echo LABEL_OK
docker exec archon-app-1 printenv ARCHON_BUILD_SHA
```

Expected: `LABEL_OK`, and `printenv` prints the same 40-hex value.
