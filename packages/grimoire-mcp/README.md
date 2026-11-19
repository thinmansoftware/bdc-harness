# Grimoire blocked PR card

Grimoire renders a read-only joined view of one pull request. It names the blocker and next permitted action but never performs an action, mutation, merge or review.

Database reads are genuinely read-only. The event-store and Taskmaster reads open their own connection and never go through core's `getDatabase()`, whose SQLite adapter creates and migrates the file. With `DATABASE_URL` set, each query runs in its own transaction that starts with `SET TRANSACTION READ ONLY` (transaction-scoped, never a session setting, so nothing outlives the card on a pooled backend). Otherwise `~/.archon/archon.db` is opened by bun:sqlite with `readonly: true`; a missing file is reported unavailable and is never created. The one write a card can cause is outside Grimoire: the shared metered GitHub client (below) records its own API usage in the harness quota meter, as every harness GitHub client does.

stdout carries only protocol output: both entry points import `src/log-to-stderr.ts` first, which sets `ARCHON_LOG_STDERR=1` so `@archon/paths` sends dependency logs to stderr. Keep that import first in any new stdio entry point.

CLI: `bun run packages/grimoire-mcp/src/cli.ts card owner/repo#123 [--json]`

Docker: `docker exec archon-app-1 bun run /app/packages/grimoire-mcp/src/cli.ts card <ref>`

MCP stdio entry: `bun run packages/grimoire-mcp/src/mcp-server.ts`. Example `.mcp.json`:

```json
{"mcpServers":{"grimoire":{"command":"bun","args":["run","packages/grimoire-mcp/src/mcp-server.ts"]}}}
```

The sole tool is `pr_card`, with input `{ "pr": "owner/repo#123" }`. Output includes PR and owner identity, exact-head review and checks, findings, linked WO and Cauldron runs, blocker, next permitted action, source health, and generation time.

GitHub access uses the shared metered read-only PAT client and is capped at ten requests per card. If complete authoritative evidence cannot be retrieved inside the cap, Grimoire reports GitHub unavailable and must not report the PR merge-ready. Event-store and Taskmaster failures degrade independently.

`merge_ready` needs all of: the latest Overseer review APPROVED on the exact head (a COMMENTED or DISMISSED review is a review blocker), green checks, and a KNOWN branch-protection required-context set in which every required context reported on the exact head. A required context that never reported makes `checks_verdict` read `required checks not reported: <names>` (blocker `checks_pending`); a failed or unknown required-context lookup marks `sources.github` unavailable.

Credentials: the PAT client reads `GH_TOKEN` (or `GITHUB_TOKEN`). Live check: `bash packages/grimoire-mcp/scripts/live-check.sh owner/repo#N ...` prints `LIVE_CARD_OK` or `LIVE_CARD_FAIL` per ref.
