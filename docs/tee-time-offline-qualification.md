# Tee-time offline candidate qualification

This profile proves server health and fail-closed execution boundaries with no
provider credentials or network. It is not a live model canary or demo build.
Related: bdc-xo#3332, bdc-harness#1136.

## Start on the BDC laptop

Build a reviewed, committed candidate with the ordinary Dockerfile and its full
SHA as ARCHON_BUILD_SHA. Set QUALIFICATION_IMAGE to that exact image tag and set
QUALIFICATION_OPERATOR_TOKEN to a fresh random token in the invoking process.
Never print the token or run `docker compose config` into logs.

```powershell
docker compose -f docker-compose.qualification.yml up -d
docker inspect archon-teetime-qualification --format '{{.Image}} {{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.Config.User}}'
docker exec archon-teetime-qualification curl --fail http://127.0.0.1:3092/api/health
docker exec archon-teetime-qualification bun scripts/staging/verify-offline-qualification.ts
docker compose -f docker-compose.qualification.yml down
```

Run verification inside the network-none container. There is deliberately no
published port, host directory/socket mount, provider auth home, GitHub write
token, or automatic restart. The qualification database volume is separate from
all existing staging and production volumes. `down` retains that data volume;
do not remove it as routine cleanup. Artifacts and the empty home are uid-1001
tmpfs mounts. Export sanitized evidence before stopping the container.

The normal entrypoint is bypassed because it refreshes provider authentication.
The actual server entrypoint still runs, including database initialization,
operator authentication and HTTP routes. Offline mode is immutable per process,
validates the final loaded environment, rejects credential-bearing homes, blocks
provider construction and workflow execution, and disables automatic work pickup.
All API writes fail after normal authentication. A rejected credential is not
printed. No credential-free-server claim applies to the ordinary profile.

Pass requires real health, unauthorized private read rejection, authenticated
private read success, model/bash/resume request rejection, provider factory
rejection, and external networking failure. Also inspect network mode, mounts,
image SHA/digest, zero published ports, no attached external network and logs for
absent scheduler startup. Curl must exist and return a connection failure (7 or
28); this alone is not proof of isolation. Save results on the parent
issue. HTTP 200 alone does not satisfy this gate.

Normal-mode regressions and live model transport remain separate gates. Do not
use this mode as evidence that Cursor or Codex builder tools are sandboxed.
