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

## Merge Manager required container env vars

Merge Manager and every Overseer GitHub client use the shared App-aware Octokit
constructor. Before enabling soft merge, `archon-app-1` must receive
`GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and at least one of
`GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`. `docker-compose.yml`
passes all four names through from `/opt/bdc/archon/.env`; it contains no secret
values. Provide the private key by
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

The PAT variables `GH_TOKEN` and `GITHUB_TOKEN` remain available to git and `gh`
workflows, but are off the Merge Manager / Overseer GitHub path whenever the App
variables are configured. A partial or broken App configuration fails loudly and
never downgrades that path to the PAT. The all-App-vars-absent PAT fallback is for
pre-activation compatibility only and must not be used when soft merge is enabled.

## Mounting the PEM (Option A, recommended)

The private key must never be committed to git and must never appear in
`docker-compose.yml`. Bind-mount the PEM from the host into the container:

1. Place the PEM on the host outside any git repo, e.g.
   `/opt/bdc/archon/secrets/thinman-overseer-app.private-key.pem`, mode `0600`.
2. The committed `docker-compose.yml` mounts `${GITHUB_APP_SECRETS_DIR:-./secrets}`
   read-only at `/opt/bdc/archon/secrets`. The production default resolves to
   `/opt/bdc/archon/secrets` because Compose runs from `/opt/bdc/archon`:
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

## Verification (post-deploy, when the separate deploy action runs)

Not part of this WO, but the outcome to confirm later (WO section 8): an APPROVED
review exists on a real PR, authored by `thinman-overseer[bot]`, on a PR that
`bluedevilcollectibles` opened. Until that row exists somewhere observable, the
capability is built but dark.
