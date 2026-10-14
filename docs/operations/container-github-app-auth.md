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
   `/opt/bdc/archon/secrets/thinman-overseer-app.private-key.pem`, mode `0600`.
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
| taskmaster | service App; `GITHUB_APP_TASKMASTER_*`; existing PAT |
| duty_officer, smart_cauldron, run_nodes | service App; `GITHUB_APP_TASKMASTER_*` alias; existing PAT |

The supported override is
`GITHUB_APP_<SERVICE>_{ID,INSTALLATION_ID,PRIVATE_KEY_PATH}` (or
`PRIVATE_KEY`). The Taskmaster trio is an explicit alias for Duty Officer,
Smart Cauldron, and run nodes. Those services never use the Overseer App.
Merge Manager never uses the reviewing Overseer App or shared user PAT.

With none of the new names set, identities are unchanged. Quota backoff is
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

### HUMAN-STEPS

1. Confirm that XO/the host already holds a private key for thinmangithub (App 4572556). The only key file found in the reference directory is the thinman-overseer one. If none exists: GitHub org Settings, Developer settings, GitHub Apps, thinmangithub, "Generate a private key", and save the .pem straight to the Hetzner host at /opt/bdc/archon/secrets/thinmangithub-app.private-key.pem with mode 0600. Never paste key contents into chat, an issue, or git.
2. Check thinmangithub's permissions include Contents RW, Pull requests RW and Issues RW (it lists them today, access level unverified) and that it is allowed to merge into protected bases (allowed merge actor or bypass actor, John's call, because merge must stay a different actor than the reviewing Overseer App per M-153). Optional: if John prefers Overseer also to read issues, add Issues Read to thinman-overseer (App settings, Permissions); not required.
3. Set these env var NAMES in the archon .env on the host (values are the ids and the in-container key path, none are secret except the key file itself): GITHUB_APP_MERGE_MANAGER_ID=4572556, GITHUB_APP_MERGE_MANAGER_INSTALLATION_ID=153246775, GITHUB_APP_MERGE_MANAGER_PRIVATE_KEY_PATH, GITHUB_APP_TASKMASTER_ID=4572556, GITHUB_APP_TASKMASTER_INSTALLATION_ID=153246775, GITHUB_APP_TASKMASTER_PRIVATE_KEY_PATH (this one trio is the documented alias also used by duty_officer, smart_cauldron and run_nodes; a GITHUB_APP_<SERVICE>_* trio overrides it for that service). Overseer and pr_discovery keep the existing GITHUB_APP_ID trio unchanged.
4. XO rebuilds archon-app-1 after the harness merge (M-181 plan) and notifies John; nothing activates until the env names are set, so merging the code first is safe.
