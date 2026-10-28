# Credential inventory

This inventory records credential ownership and refresh behavior. It never records credential values.

| Credential | Used by | Refresh method | Self-refresh? | Owner | Expiry |
| --- | --- | --- | --- | --- | --- |
| `GITHUB_APP_ID` + key (thinman-overseer App) | Overseer, shared fallback | App JWT to installation token | Yes, by the shared provider | harness | Key: none; token: 1 hour |
| `GITHUB_APP_MERGE_MANAGER_*` | Merge manager | App JWT to installation token | Yes, by the shared provider | harness | 1 hour |
| `GITHUB_APP_RUN_NODES_*` | Run nodes and builders | App JWT to installation token | Yes, by the shared provider | harness | 1 hour |
| `GITHUB_APP_TASKMASTER_*` (currently empty) | Taskmaster, duty officer | Installation token; falls back to shared App | Yes once configured; shared fallback refreshes now | harness | 1 hour |
| `GH_TOKEN`, `GITHUB_TOKEN`, `MERGE_MANAGER_GH_TOKEN`, `GH_AUTH_TOKEN_INTERNAL` | Legacy PAT fallbacks | Manual rotation | No; alert and retire | John | Per GitHub settings |
| `CURSOR_API_KEY` | Overseer Cursor judge, Cursor lanes | Static API key | No; follow-up required | John | Until revoked |
| `/home/appuser/.codex/auth.json` | Codex lanes | Codex CLI refreshes OAuth | Yes, by CLI | harness | Refresh-token lifetime |
| `/home/appuser/.claude/.credentials.json` | Claude lanes | Claude CLI refreshes OAuth; host file mounted through `CLAUDE_CREDS_HOST_PATH` | Partial; re-login is manual | John | Refresh-token lifetime |
| `XAI_API_KEY` | Grok lanes | Static API key | No; follow-up required | John | Until revoked |
