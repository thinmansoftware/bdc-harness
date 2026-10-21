# Container GitHub App Auth (Thinman Overseer)

**WO**: WO-HARNESS-OVERSEER-APP-AUTH-01
**Board anchor**: M-141 (CARRIED 3-0, 2026-08-12) Q2 -- board chose a GitHub App
over a second user account; M-141 Q3 (unanimous) -- do NOT enable required review
at transfer-complete.
**Companion doc**: `container-github-auth.md` (the PAT boundary this extends).

> **NOT YET DEPLOYED.** This WO wires the code and documents the container
> configuration. It does NOT edit `/opt/bdc/archon/.env`, `docker-compose.yml`, or
> `docker-entrypoint.sh` on the Hetzner host, and it does NOT restart any
> container. Deploy is a separate, gated action. Nothing below changes runtime
> behavior until an operator applies it on the host.

## Why

Overseer merges pull requests using the classic PAT (see `container-github-auth.md`).
That PAT belongs to the `bluedevilcollectibles` org account -- effectively "John".
GitHub forbids a user from approving their own pull request, and John is the only
human in the `thinmansoftware` org, so the PAT identity can never record an
approving review. Turning on required PR review while Overseer merges as John would
deadlock every merge forever.

The **Thinman Overseer** GitHub App is a second, non-human identity. When Overseer
authenticates as the App installation, its API calls are attributed to
`thinman-overseer[bot]`, which CAN approve a PR that `bluedevilcollectibles`
opened. This unblocks required review as a later, separate action (M-141 Q3 keeps
that flip explicitly out of scope here).

## Auth precedence (implemented in `packages/overseer/src/adapters/github-real-deps.ts`)

`createRealOctokitClient()` resolves auth in this order:

1. **App auth (preferred when complete):** if `GITHUB_APP_ID`,
   `GITHUB_APP_INSTALLATION_ID`, and a resolvable private key are all present,
   Overseer authenticates as the App installation. API calls are attributed to
   `thinman-overseer[bot]`.
2. **PAT fallback (when App vars are entirely absent):** falls back to
   `GH_TOKEN`/`GITHUB_TOKEN` exactly as before. No behavior change.
3. **Fail loud (when App vars are present but broken):** if any App var is set but
   the trio does not fully resolve to a valid-looking PEM, construction THROWS
   naming the missing/broken variable. It does **not** silently downgrade to the
   PAT -- a half-configured App quietly merging as John is the exact failure this
   WO exists to prevent.

## App coordinates (live-verified 2026-08-12)

| Field | Value |
|-------|-------|
| App name | Thinman Overseer |
| App ID | `4574893` |
| Installation ID | `153295654` (org-wide, "All repositories") |
| Owner | `@thinmansoftware` |
| Permissions | contents RW, pull_requests RW, checks RO, statuses RO, metadata RO |
| Private key (host) | `~/.claude/reference/thinman-overseer-app.private-key.pem` (RSA) |

Secret material (the PEM contents and key fingerprint) lives in
`~/.claude/reference/credentials.md` under "GitHub App: Thinman Overseer" and is
NOT duplicated into this repo.

> Note: an installation token returning "Resource not accessible by integration"
> from `GET /user` is expected -- Apps are not users. Do not treat it as a failure.

## Container env vars (three new, all optional)

Add to `/opt/bdc/archon/.env` for `archon-app-1`. Provide the private key by
**either** inline contents **or** a mounted file path (inline wins if both set):

```
# GitHub App auth: Thinman Overseer
GITHUB_APP_ID=4574893
GITHUB_APP_INSTALLATION_ID=153295654
# Option A -- mounted PEM file (recommended):
GITHUB_APP_PRIVATE_KEY_PATH=/opt/bdc/archon/secrets/thinman-overseer-app.private-key.pem
# Option B -- inline PEM contents (literal \n sequences are normalized to newlines):
# GITHUB_APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n
```

When all three App vars are unset, Overseer uses the existing PAT path unchanged.

## Mounting the PEM (Option A, recommended)

The private key must never be committed to git and must never appear in
`docker-compose.yml`. Bind-mount the PEM from the host into the container:

1. Place the PEM on the host outside any git repo, e.g.
   `/opt/bdc/archon/secrets/thinman-overseer-app.private-key.pem`. The owner,
   group, and mode are NO LONGER plain `0600` -- lane UID isolation requires a
   specific owner/group/mode per key so a builder lane cannot read the reviewer
   key. See "Lane key isolation" below for the required table and the exact host
   commands. (WO-HARNESS-APP-KEY-ISOLATION-01)
2. In `docker-compose.yml`, add a read-only bind mount for the app service:
   ```yaml
   volumes:
     - /opt/bdc/archon/secrets:/opt/bdc/archon/secrets:ro
   ```
3. Set `GITHUB_APP_PRIVATE_KEY_PATH` in `.env` to the in-container path
   (identical here because the mount preserves the path).
4. Recreate the container: `cd /opt/bdc/archon && sudo docker compose up -d`.

### Alternative: inline via `GITHUB_APP_PRIVATE_KEY` (Option B)

If passing the PEM as an env var value, newlines must survive. Two safe forms:

- A single line with literal `\n` between the PEM lines (Overseer normalizes
  `\n` back to real newlines at resolution time), or
- A genuinely multi-line value if your `.env` loader supports it.

Prefer the mounted file (Option A) -- it keeps the key out of `docker compose
config` output and process environment listings.

## Merge Manager requirement (WO-HARNESS-MM-THINMAN-APP-WIRE-01)

The Merge Manager / overseer real-mode GitHub client authenticates through the
same App-preferred chain described above (`resolveGitHubAppAuth` ->
`createRealOctokitClient`), wired by default in `resolveDefaultDeps()`
(`packages/overseer/src/service.ts`). No merge-path code change is needed to use
the App identity; the wiring already routes real-mode GitHub calls through it.

**Startup wiring lives in git; only the secret VALUES are operator-supplied.**
The `app` service in `docker-compose.yml` (and `docker-compose.staging.yml`)
passes these vars into the container `environment:` explicitly via `${VAR:-}`
interpolation -- the same pattern used for `GH_TOKEN` -- so they are present in
the container startup environment and visible to bash subprocesses, not only the
app process. The compose file NEVER holds a literal: the operator sets the values
in the gitignored `.env` (`/opt/bdc/archon/.env` for `archon-app-1`). Option A
(mounted PEM) additionally uses the commented `:ro` volume + a host path in `.env`.

**Env vars Merge Manager requires** (wired in compose, valued in `.env`):

| Var | Required | Notes |
|-----|----------|-------|
| `GITHUB_APP_ID` | yes | `4574893` |
| `GITHUB_APP_INSTALLATION_ID` | yes | `153295654` |
| `GITHUB_APP_PRIVATE_KEY_PATH` | one of PATH/inline | mounted PEM (Option A) |
| `GITHUB_APP_PRIVATE_KEY` | one of PATH/inline | inline PEM (Option B) |

**PAT is off the merge path once App auth is complete.** When all three App vars
resolve to a valid PEM, `resolveRealOctokitAuthOptions()` selects the App
installation strategy and the `GH_TOKEN`/`GITHUB_TOKEN` PAT is NOT used for
overseer/merge GitHub calls -- API calls are attributed to
`thinman-overseer[bot]`, not John's admin PAT. A partially-configured App fails
loudly rather than silently downgrading to the PAT. This must be true before any
soft-merge / auto-merge path is activated (a later, separately gated step).

### Verify command (done-when #2 + #3)

`packages/overseer/package.json` exposes a runnable check that mints an
installation token and calls the Checks API against a known repo
(`thinmansoftware/bdc-harness@dev`). Because the App auth strategy mints the
installation token lazily on the first signed request, a successful Checks call
proves BOTH the mint (#2) and the HTTP 200 response (#3):

```
# from packages/overseer/ inside the container:
bun run verify-github-app
# or:
docker exec archon-app-1 bun run verify-github-app
```

Exit `0` = App auth configured and a live Checks API call succeeded. Exit `1` =
App auth absent, partially configured (loud failure), or the API call failed. The
script logs only non-secret identifiers (appId, installationId, owner/repo/ref);
it never logs the PEM, the private key, or the raw installation token.

### Live verification is operator-side (post-deploy)

Done-when #1 (`printenv` names-only check), #2 (token mint), and #3 (Checks 200)
require the real App credentials for App ID `4574893` / installation `153295654`
to be mounted in `archon-app-1`, plus network access to GitHub -- neither is
available in the CI/build sandbox. The build only delivers and unit-tests (mocked,
network-free) the verify command. Actually satisfying done-when #1-3 is an
operator action run AFTER this change deploys:

```
docker exec archon-app-1 printenv | grep -E '^GITHUB_APP_(ID|INSTALLATION_ID|PRIVATE_KEY_PATH)='
docker exec archon-app-1 bun run verify-github-app
```

Never dump the PEM: check env var NAMES only, never values.

## Verification (post-deploy, when the separate deploy action runs)

Not part of this WO, but the outcome to confirm later (WO section 8): an APPROVED
review exists on a real PR, authored by `thinman-overseer[bot]`, on a PR that
`bluedevilcollectibles` opened. Until that row exists somewhere observable, the
capability is built but dark.

## Per-service identities, quota pools, and metering

The source of truth is `SERVICE_GITHUB_AUTH_PRECEDENCE` in
`packages/core/src/github/service-identity.ts`. First complete match wins; any
partially configured App step throws and names the missing variables.

| Service | Precedence |
|---|---|
| overseer, pr_discovery | service App; shared `GITHUB_APP_*`; existing PAT |
| merge_manager | `GITHUB_APP_MERGE_MANAGER_*`; `MERGE_MANAGER_GH_TOKEN`; hold |
| taskmaster | service App; `GITHUB_APP_TASKMASTER_*`; shared `GITHUB_APP_*`; existing PAT |
| duty_officer | service App; `GITHUB_APP_TASKMASTER_*` alias; shared `GITHUB_APP_*`; existing PAT |
| smart_cauldron, run_nodes | service App (`GITHUB_APP_SMART_CAULDRON_*` / `GITHUB_APP_RUN_NODES_*`); existing PAT -- no Taskmaster alias, no shared `GITHUB_APP_*` fallback (see "Builder App" below) |

The supported override is
`GITHUB_APP_<SERVICE>_{ID,INSTALLATION_ID,PRIVATE_KEY_PATH}` (or
`PRIVATE_KEY`). The Taskmaster trio is an explicit alias for Duty Officer only.
Smart Cauldron and run nodes (the Cauldron builder lanes) never borrow the
Taskmaster alias or the shared `GITHUB_APP_*` reviewer App -- see the "Builder
App (run_nodes / smart_cauldron)" section below. The default BDC deployment uses
the ONE shared thinman-overseer App (4574893, installation153295654) for
Taskmaster and Duty Officer. Merge Manager never uses the reviewing Overseer App
or shared user PAT.

Existing shared App configuration becomes eligible for those services after
the reviewed rebuild; activation must therefore verify this routing change.
CLI commands resolve credentials per operation through the existing merge guard;
git's credential helper also resolves at operation time. Parent PAT environment
values are preserved, and only an explicitly permission-denied CLI call retries
on the original PAT. Quota backoff is
shared by `(pool_id, resource)`, so services on one installation share fate
while `core`, `search`, and `graphql` remain independent. Calls and latest quota
state are metered by service. An App 403 containing "Resource not accessible by
integration" retries only that call with the PAT and increments
`github_app_permission_fallbacks`.

All deployment defaults are empty:

```dotenv
GITHUB_APP_MERGE_MANAGER_ID=
GITHUB_APP_MERGE_MANAGER_INSTALLATION_ID=
GITHUB_APP_MERGE_MANAGER_PRIVATE_KEY_PATH=
GITHUB_APP_TASKMASTER_ID=
GITHUB_APP_TASKMASTER_INSTALLATION_ID=
GITHUB_APP_TASKMASTER_PRIVATE_KEY_PATH=
```

## Builder App (run_nodes / smart_cauldron)

The Cauldron builder lanes (`run_nodes` and `smart_cauldron`) open PRs and push
branches. They must NEVER share a GitHub identity with the reviewer (the
thinman-overseer App) and must NOT borrow Taskmaster's identity -- "builders
build, then the reviewer reviews." If a builder PR is authored by
`thinman-overseer[bot]`, Overseer ingest refuses it with disposition
`custody_conflict` / reason `reviewer_is_pull_request_author`.

**Precedence (for these two services only):** own App -> PAT. There is no
Taskmaster-alias fallback and no shared `GITHUB_APP_*` (reviewer) fallback.

1. **Own builder App (preferred):** if `GITHUB_APP_RUN_NODES_*` (or
   `GITHUB_APP_SMART_CAULDRON_*`) is complete, the lane authenticates as that
   App.
2. **PAT (when no own App is set):** falls back to `GITHUB_TOKEN`/`GH_TOKEN`
   (the `bluedevilcollectibles` user). A lane on a host that has only the shared
   reviewer trio (`GITHUB_APP_*`) or only `GITHUB_APP_TASKMASTER_*` therefore
   pushes and opens PRs as the PAT -- never as the reviewer or Taskmaster App.

**Equality guard:** if a configured builder App's `appId` equals the reviewer
App's `appId` (resolved via `GITHUB_APP_OVERSEER_*` then `GITHUB_APP_*`),
`resolveServiceGitHubAuth` throws
`builder_identity_equals_reviewer: <service> App id equals the reviewer App id`
instead of returning an identity. `docker-entrypoint.sh` mirrors this: it
installs the App git-credential helper only when `GITHUB_APP_RUN_NODES_ID` is
set AND differs from `GITHUB_APP_ID`; if they are equal it logs an error and
leaves the PAT as the git credential.

**Env var names:**

```dotenv
GITHUB_APP_RUN_NODES_ID=
GITHUB_APP_RUN_NODES_INSTALLATION_ID=
GITHUB_APP_RUN_NODES_PRIVATE_KEY_PATH=
# or GITHUB_APP_RUN_NODES_PRIVATE_KEY= (inline PEM)
```

**Required permissions** (must be a DIFFERENT App from Thinman Overseer, App ID
4574893): Repository contents: Read and write; Pull requests: Read and write;
Metadata: Read-only. No other permissions. Install on the `thinmansoftware` org
with "All repositories".

**Runtime canary** (recorded by XO after the forward rebuild):

```bash
# 1) builder App is present AND distinct from the reviewer App
ssh hetzner-prod docker exec archon-app-1 sh -c \
  'test -n "$GITHUB_APP_RUN_NODES_ID" && test "$GITHUB_APP_RUN_NODES_ID" != "$GITHUB_APP_ID" && echo distinct'
# 2) a canary lane PR is authored by a login that is NOT the reviewer
gh pr view <N> --repo <repo> --json author --jq .author.login   # != thinman-overseer
# 3) no custody_conflict in the last 10 minutes of container logs
ssh hetzner-prod docker logs --since 10m archon-app-1 2>&1 | grep -c custody_conflict   # 0
```

### HUMAN-STEPS

1. Do not use thinmangithub (4572556): it belongs to Vercel, not BDC. No BDC key-generation step exists for it. XO reports the existing thinman-overseer installation pool measured15000/hour after the enterprise upgrade; it is one shared pool, not15000 per service. Recheck capacity with a real authenticated call before activation.
2. The app currently lacks Issues:write. Issue comments/labels remain on the original user credential via permission fallback unless John separately grants that app permission. Do not change permissions or copy credentials as part of a source repair.
3. Preserve M-153: review and merge must use distinct identities. The existing dedicated merge PAT remains the merge route, or merge holds if it is absent. Reusing the reviewing App for merge does not satisfy that guard. An optional second BDC App would require John to create it; none is assumed.
4. XO owns the rebuild and action-time configuration/custody verification after the source merge. The shared App fallback changes effective service routing on that rebuild even without new service-specific environment names. Production authorization, active-work and rollback checks remain separate; this runbook is not execution authority.

### Short-lived CLI command metering

The existing command driver captures gh HTTP diagnostics in memory, consumes
only response status and quota headers, and discards trace headers/URLs/bodies
before returning stderr. It persists each observed HTTP response to the existing
usage tables before exit or the single permission fallback. A command without
an HTTP response is counted separately as resource `cli` with status0, not as
a successful API request. Before starting each child it rereads the shared
pool state for core/graphql/search/cli, so another CLI process cannot ignore a
recorded exhaustion. This conservative preflight may hold a mixed CLI command
when any resource in its pool is exhausted. Secondary retry deadlines use
`backoff:<resource>` state rows without overwriting measured quota remaining.
Explicit GraphQL integration-permission errors can use the preserved PAT once;
rate limits and transport failures cannot. No trace or credential values are
stored by metering. These source changes do not activate credentials or a pool.

The CLI driver leaves stdin inherited for ordinary commands such as `gh pr
list` and `gh pr view`. It must not read an unused pipe: Smart Cauldron's
`execFile` callers leave that pipe open. Input is buffered for permission-retry
replay only when the command declares a stdin source (`--input -`,
`--body-file -` / `-F -`, API `--field name=@-` / `-F name=@-`,
`auth login --with-token`, `workflow run --json`, or `gist create -`).
The focused regression uses the real `execFile` launch with an open stdin pipe;
it also checks payload forwarding and identical-byte permission retry:

```bash
bun test ./scripts/github-service-exec.test.ts
```

## Lane key isolation (WO-HARNESS-APP-KEY-ISOLATION-01)

A Cauldron builder lane runs untrusted, AI-authored code inside `archon-app-1`.
Before this change the reviewer server and every lane ran as the same UID (1001)
in one process tree, so a lane could read the Overseer (reviewer) App private
key, the merge-manager / user PATs, and the server process environment
(`/proc/1/environ`), and could therefore sign or act as the reviewer. `chmod`
alone cannot fix this because the keys and the lane share a UID.

The fix gives every lane subprocess a distinct unprivileged identity
(`laneuser`, UID 1002) via a root-owned, `setcap`'d launcher
(`/usr/local/libexec/archon/lane-setpriv`, invoked through
`/usr/local/bin/archon-lane-exec`). The server (`appuser`, UID 1001) keeps the
keys; lanes get a scrubbed environment, a separate `/home/laneuser`, and no read
access to the reviewer key, the server environment, or the database. Lanes keep
the Builder 2 (`run_nodes`) key because lanes ARE Builder 2.

### Required host owner/group/mode for the key mounts

The container image creates these groups: `laneuser` (GID 1002), `archon-secrets`
(GID 1100), `archon-launch` (GID 1101). `appuser` is a member of all three;
`laneuser` is a member of none of `archon-secrets`/`archon-launch`. The HOST PEM
files map their group by GID (the host does not need matching group names), so
set them by numeric GID:

| Host PEM file                         | Mounted at                              | Owner | Group (GID)         | Mode | Lane can read? |
|---------------------------------------|-----------------------------------------|-------|---------------------|------|----------------|
| `thinman-overseer.private-key.pem`    | `/run/secrets/thinman-overseer.pem`     | root  | `archon-secrets` (1100) | 0440 | NO (reviewer)  |
| `thinman-builder-2.private-key.pem`   | `/run/secrets/thinman-builder-2.pem`    | root  | `laneuser` (1002)   | 0440 | YES (Builder 2)|
| `thinman-builder.private-key.pem`     | (none -- REMOVE this mount)             | -     | -                   | -    | -              |

The previous runbook said host mode `0600`; that is replaced by the table above
(0440 with the owning group doing the read-gating). `appuser` reads the reviewer
key through its `archon-secrets` membership; `laneuser` cannot.

### Post-merge rebuild step: lane key isolation

Applied ONLY on the host by the operator (Rule 11.5 rebuild, John pinged). Never
performed by a lane.

```bash
# 0) Record current state for rollback.
cd /opt/bdc/archon
cp docker-compose.override.yml docker-compose.override.yml.bak.$(date +%s)
ls -ln /opt/bdc/archon/secrets/*.private-key.pem > /opt/bdc/archon/secrets/.pre-isolation-ls-ln.txt
ls -ldn /.archon /home/appuser 2>/dev/null >> /opt/bdc/archon/secrets/.pre-isolation-ls-ln.txt || true

# 1) Re-own the host PEMs (numeric owner/group; 1100=archon-secrets, 1002=laneuser).
chown 0:1100 /opt/bdc/archon/secrets/thinman-overseer.private-key.pem
chmod 0440   /opt/bdc/archon/secrets/thinman-overseer.private-key.pem
chown 0:1002 /opt/bdc/archon/secrets/thinman-builder-2.private-key.pem
chmod 0440   /opt/bdc/archon/secrets/thinman-builder-2.private-key.pem

# 2) Remove the unused thinman-builder.pem line from docker-compose.override.yml
#    (the single-builder key is no longer mounted). Edit the file and delete the
#    line that bind-mounts thinman-builder.pem (NOT thinman-builder-2.pem).

# 3) Rebuild + recreate per the proven M-181 plan (worktree protection, DB
#    backup, image pin, explicit fetch, build, verify), then recreate:
sudo docker compose build && sudo docker compose up -d

# 4) Run the Section 8 runtime checks (Stops 4-12) below and paste output on the
#    WO issue.
```

### Runtime verification (Stops 4-12; paste output on the WO issue)

```bash
# Stop 4: reviewer key unreadable by the lane UID
docker exec -u 1002:1002 archon-app-1 cat /run/secrets/thinman-overseer.pem > /dev/null   # non-zero, Permission denied
# Stop 5: server env unreadable by the lane UID
docker exec -u 1002:1002 archon-app-1 head -c0 /proc/1/environ                            # non-zero, Permission denied
# Stop 6: Builder 2 key still readable by the lane UID
docker exec -u 1002:1002 archon-app-1 test -r /run/secrets/thinman-builder-2.pem          # exit 0
# Stop 7: server holds the secrets group; reviewer key mode
docker exec archon-app-1 grep -c '^Groups:.*1100' /proc/1/status                          # 1
docker exec archon-app-1 stat -c '%a %u %g' /run/secrets/thinman-overseer.pem             # 440 0 1100
# Stop 10: no auth errors after rebuild
docker logs archon-app-1 --since 30m 2>&1 | grep -c 'github_app_auth_private_key_unreadable'   # 0
# Stop 11: database + server config closed to the lane UID
docker exec archon-app-1 stat -c '%a %u' /.archon/archon.db /.archon/archon.db-wal /.archon/archon.db-shm   # 600 1001 each
docker exec -u 1002:1002 archon-app-1 test -w /home/appuser/.gitconfig                    # non-zero
docker exec -u 1002:1002 archon-app-1 test -r /.archon/archon.db                          # non-zero
# Stop 12: lane provider auth still works 24h after rebuild (OAuth refresh-rotation)
docker logs archon-app-1 --since 24h 2>&1 | grep -ic 'refresh_expired'                    # 0
```

Stops 8 (Overseer still reviews a canary PR authored by Builder 2) and 9 (no
worktree process at UID 1001 for the whole canary run) are the end-to-end canary
checks in the WO Section 8.

### In-image self-test

The image tests in `scripts/container/lane-isolation.test.ts` (Tests 4, 7, 8)
run inside `archon-app-1`:

```bash
docker exec -e ARCHON_LANE_ISOLATION_IMAGE_TEST=1 archon-app-1 \
  bun test /app/scripts/container/lane-isolation.test.ts
```

### Rollback (minutes)

1. Host: restore the backed-up `docker-compose.override.yml` and the recorded
   owner/modes from `/opt/bdc/archon/secrets/.pre-isolation-ls-ln.txt`
   (`chown 1000:1000`, `chmod 0644` on the PEMs; restore `/.archon`,
   `archon.db*`, `/home/appuser`).
2. Or set `ARCHON_LANE_UID_ISOLATION=0` in `.env` and recreate the container:
   lanes run as 1001 again (previous behavior), the launcher is bypassed.
3. Or redeploy the previous pinned image tag from the M-181 backup, and revert
   the PR on `dev`.
