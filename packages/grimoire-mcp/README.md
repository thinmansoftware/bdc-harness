# Grimoire blocked PR card

Grimoire renders a read-only joined view of one pull request. It names the blocker and next permitted action but never performs an action, mutation, merge, review, or database write.

CLI: `bun run packages/grimoire-mcp/src/cli.ts card owner/repo#123 [--json]`

Docker: `docker exec archon-app-1 bun run /app/packages/grimoire-mcp/src/cli.ts card <ref>`

MCP stdio entry: `bun run packages/grimoire-mcp/src/mcp-server.ts`. Example `.mcp.json`:

```json
{"mcpServers":{"grimoire":{"command":"bun","args":["run","packages/grimoire-mcp/src/mcp-server.ts"]}}}
```

The sole tool is `pr_card`, with input `{ "pr": "owner/repo#123" }`. Output includes PR and owner identity, exact-head review and checks, findings, linked WO and Cauldron runs, blocker, next permitted action, source health, and generation time.

GitHub access uses the shared metered read-only PAT client and is capped at ten requests per card. If complete authoritative evidence cannot be retrieved inside the cap, Grimoire reports GitHub unavailable and must not report the PR merge-ready. Event-store and Taskmaster failures degrade independently.
