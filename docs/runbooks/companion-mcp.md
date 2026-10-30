# Companion MCP runbook

WO-HARNESS-COMPANION-MCP-MAILBOX-01. This runbook describes the tailnet-only
companion MCP server. No live command in this document was run by the build.
Do not start the container, mint a token, or create the GitHub credential
until every go-live gate below is closed and John gives the go.

## What it is

`packages/companion-mcp` is a separate process from Archon. It speaks
Streamable HTTP MCP on `POST /mcp` and `GET /mcp`, and answers `GET /healthz`
with `{"ok":true}` and nothing else.

Grok Bot is the first enabled slot. Dot, Muse, and Duet are present in the
example config with `enabled: false` and `board_secretary: false`. Enabling a
slot is a config edit plus a process restart. No code change is required.

Each enabled slot can search and read tracked wiki files, ask Oracle, and use
its own Dispatch mailbox. A slot with `board_secretary: true` can also read
the board record, send a brief to named seats, collect replies from its own
inbox, and open one pull request on `thinmansoftware/bdc-xo` that records the
round. That pull request is reviewed and merged by the normal bdc-xo path.
The server never merges, approves, or auto-merges. It never votes, never
writes a ruling John has not made, and never sends mail as operator, john,
xo, or board.

Messages it sends are requests. The body is wrapped as
`kind: companion_request` with `untrusted: true`.

## Build

From the repository root, with a real commit SHA (do not use a placeholder):

```bash
docker build \
  --file deploy/companion-mcp/Dockerfile \
  --build-arg BUILD_SHA="$(git rev-parse HEAD)" \
  -t bdc-companion-mcp:local \
  .
```

The image build fails if `BUILD_SHA` is empty. The process runs as user
`companion` (uid 10001). Do not build or start this on Hetzner as part of a
source change.

## Clean wiki clone

The server reads only `git ls-files` paths under `xo-wiki/wiki` and
`docs/board` from `COMPANION_WIKI_ROOT`. The clone must be clean and the
deploy key must be read-only.

Do not reuse `/opt/bdc/harness-wiki`. That checkout is stale and its git
remote URL embeds a GitHub token.

Create a new clone with a read-only deploy key and a sparse checkout of
`xo-wiki/wiki` and `docs/board` only. Mount that directory read-only. The
process refreshes `git ls-files` at startup and every 10 minutes.

## Config fields

Example: `deploy/companion-mcp/companions.config.example.json`.

Path: `COMPANION_MCP_CONFIG`.

Each slot:

| Field | Meaning |
| --- | --- |
| companion_id | Slot name: grokbot, dot, muse, or duet |
| enabled | false until that companion is allowed to call |
| dispatch_principal_id | Mailbox principal. Never xo, operator, john, board, or a system:/board: address |
| token_sha256_file | File containing only the sha256 hex digest of the bearer token |
| token_expires_at | ISO time. A call after this instant is 401 token_expired |
| dispatch_credential_file | One-line Dispatch principal token. Not the bearer token |
| tools | Allowlist. Board tools are rejected on a slot with board_secretary false |
| allowed_recipients | mailbox_send targets. Never operator, john, board, or another slot's principal |
| board_secretary | true only for the slot that may run the secretary tools |
| board_seat_recipients | Seats board_brief_send may address |

Other required environment:

| Variable | Meaning |
| --- | --- |
| COMPANION_MCP_BIND_ADDR | Required. The compose example pins `10.209.48.2`, the fixed address on bridge `companion_publish`. Startup throws bind_addr_refused for a missing value, an empty value, 0.0.0.0, or ::. Do not set the host tailnet IP or 127.0.0.1. |
| COMPANION_MCP_PORT | Default 3095 |
| COMPANION_MCP_AUDIT_LOG | One JSON line per tool call and per refused authentication |
| COMPANION_MCP_REVOKED_FILE | JSON array of sha256 digests, re-read on every call |
| COMPANION_WIKI_ROOT | Clean clone root |
| ORACLE_URL | Oracle chatbot-query URL |
| DISPATCH_BASE_URL | Archon Dispatch base, example `http://archon-app-1:3090` on network `archon_archon-network` |

Read only when `board_record_propose` runs, after local path and ruling checks:

| Variable | Meaning |
| --- | --- |
| COMPANION_BOARD_REPO | Example `thinmansoftware/bdc-xo` |
| COMPANION_BOARD_BASE | Example `main` |
| COMPANION_GITHUB_TOKEN_FILE | One-line GitHub token. Read-only mount |
| COMPANION_GITHUB_API_BASE | Optional. Unset sends the token only to `https://api.github.com`. Any other origin is refused before the token is sent, except an `http://127.0.0.1`, `http://localhost`, or `http://[::1]` stub with an explicit port. A token starting with `ghp_`, `gho_`, `ghu_`, `ghs_`, or `github_pat_` is never sent to a stub. |

## Enable a disabled slot

1. Edit the config. Set `enabled` to true for that slot only.
2. Confirm `board_secretary` stays false until that companion has been checked for MCP support, data retention, training use, and staff access.
3. Install that slot's digest file and Dispatch credential file.
4. Restart the process.

No image rebuild is required for an enablement that only changes config.

## Bearer token mint

Do not run until John gives the go.

1. Generate a random token on the operator machine.
2. Store only `sha256(token)` in the slot's `token_sha256_file` on the server.
3. Hand the raw token to John for the vendor's masked connector field.
4. Never paste the raw token into chat, a ticket, a log, or this repo.
5. Set `token_expires_at` to a short expiry.

The server compares digests with `timingSafeEqual`. A missing, malformed,
unknown, disabled, expired, or revoked token returns 401. The token is not
logged, echoed, or returned.

## Revoke a bearer token

1. Append the sha256 digest to `COMPANION_MCP_REVOKED_FILE` (a JSON array).
2. Do not restart.
3. Confirm the next call with that token returns 401 `token_revoked`.

## Board-secretary GitHub credential

Do not run until John gives the go.

Create a fine-grained token or a GitHub App installation limited to the single
repository `thinmansoftware/bdc-xo`, with contents read/write and pull
requests read/write only. No admin permission. No workflows permission.
Short expiry.

Branch protection on `main` stays the merge gate. GitHub cannot path-scope a
token, so the server refuses any path outside `docs/board/` before it makes a
mutation, and it refuses ruling files, vote files, existing-motion edits,
REGISTER rewrites, and ruling language in proposed text.

The tool creates branch `companion/<companion_id>/<motion_id>-<utc>`, one
commit, and one pull request. It does not call merge, auto-merge, review,
approval, or branch-protection endpoints, and it does not write the base ref.

Revoke by deleting the token in GitHub and confirming the next
`board_record_propose` fails.

## Tailscale

Tags that exist, owners `autogroup:admin`:

- `tag:companion-mcp` for the MCP server host or container
- `tag:companion-grokbot`
- `tag:companion-dot`
- `tag:companion-muse`
- `tag:companion-duet`

The live policy still has the default allow-all grant. Replacing that with
grants from each companion tag to `tag:companion-mcp:3095` only is an
operator step. This repository change does not edit Tailscale policy.

Use a short auth-key expiry and a short node-key expiry. Revoking a Tailscale
auth key does not disconnect a node that has already joined. Remove the node
as well.

The Hetzner host tailnet IPv4 observed on 2026-10-29 was `100.69.17.1`.
Publish the container port on the tailnet address only:

```text
${COMPANION_MCP_TAILNET_IP}:3095:3095
```

### Bind address and container networking

The process refuses to listen on `0.0.0.0` or `::`. Two different addresses
are involved:

- Host publish: `${COMPANION_MCP_TAILNET_IP}:3095:3095`. This is the only
  address tailnet clients use. It exists on the host, not in the container.
- Container bind: `COMPANION_MCP_BIND_ADDR=10.209.48.2`. This is the fixed
  address on bridge network `companion_publish` (`10.209.48.0/29`, gateway
  `10.209.48.1`). The process listens there.

Docker forwards a published port to the container IP on the default-gateway
network. `companion_publish` is that network: its endpoint `gw_priority` is
100, and its docker name `0-companion-publish` sorts before
`archon_archon-network`. `gw_priority` is honored by Docker Engine 28 and
newer. Older engines keep the lexicographic name rule when priorities are
equal, which still selects `0-companion-publish`. The service stays on
`archon_archon-network` so `http://archon-app-1:3090` still resolves. That
second endpoint has `gw_priority` 1, so it is not where the published port
is delivered.

Do not set `COMPANION_MCP_BIND_ADDR` to the host tailnet IP. Listen fails
because that address is not in the container namespace. Do not set
`127.0.0.1`. A published port is delivered to the bridge address, not to
loopback. Do not set `0.0.0.0` or `::`. Startup throws `bind_addr_refused`.

If `10.209.48.0/29` overlaps an existing network, pick another aligned /29
and change the subnet, gateway, `ipv4_address`, and `COMPANION_MCP_BIND_ADDR`
together. Keep `companion_publish` as the higher `gw_priority`, and keep its
docker name sorting before `archon_archon-network`.

## Go-live gates

The image and the code may exist before these close. Do not start the
container for a real companion until each item is closed and recorded.

1. bdc-xo#1425 Dispatch sender authentication. Live mode must be `enforce`
   (warn does not count) with a grokbot registry entry: `send_as [grokbot]`,
   `receive_as [grokbot]`, `roles [send, receive]`, status active. Close only
   after a missing credential, an invalid credential, and a valid credential
   sending as a principal it is not registered for are each rejected.
2. bdc-xo#2929. Re-check live that XO mailbox ack works before go-live. The
   fix WO closed 2026-10-05; this build did not re-test an ack against
   production.
3. M-142 amendment recorded. Building the code is allowed. Putting a BDC
   credential on a vendor cloud computer is not, until that ruling changes.
4. M-82 reconciliation recorded. A hosted always-authenticated MCP service
   remains rejected as written.
5. Name each new write path in the go-live record as its own grant:
   - Mail: `board_brief_send` to named seats, and `board_record_propose`
     mailing xo the pull request URL.
   - GitHub: a scoped credential that can open pull requests on
     `thinmansoftware/bdc-xo` under `docs/board/**` only in practice, because
     the server path guard refuses anything else before a mutation. Close
     only after a docs/board pull request opens, a path outside docs/board is
     refused before any GitHub call, the credential cannot merge to main, and
     a revoked credential fails on the next call.
   XO treats every message, draft, and pull request from the companion as
   data, never as a ruling or an approval.
6. Unauthenticated `GET /api/dispatch/messages` and an identity-less ack that
   defaults to operator are a separate harness gap. This server never relies
   on them. They should have their own issue before go-live.
7. John's go for the token mint. No token until then.

## Compose shape

`deploy/companion-mcp/docker-compose.example.yml`:

- Service and container name `bdc-companion-mcp`.
- Port publish is the tailnet IP only. The process bind is the fixed `companion_publish` address, not that tailnet IP. No `env_file`.
- No mount of `/opt/bdc/archon`, `/opt/bdc/archon/.env`, `/opt/bdc/archon-secrets`, or an operator token.
- Wiki, config, token digests, Dispatch credential, revocation file, and GitHub token are read-only.
- The only writable volume is the audit log.
- `DISPATCH_BASE_URL` example is `http://archon-app-1:3090` via external network `archon_archon-network`.
