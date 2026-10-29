# Credential inventory

This inventory records credential ownership and refresh behavior. Secret values must never be added to this document.

| Credential | Used by | Refresh method | Self-refresh? | Owner | Expiry |
|---|---|---|---|---|---|
| GITHUB_APP_ID + key (thinman-overseer App) | Overseer, shared fallback | App JWT -> installation token, 1h | yes (this WO) | harness | key: none; token 1h |
| GITHUB_APP_MERGE_MANAGER_* | merge manager | installation token | yes (this WO) | harness | 1h |
| GITHUB_APP_RUN_NODES_* | run nodes / builders | installation token | yes (this WO) | harness | 1h |
| GITHUB_APP_TASKMASTER_* (currently EMPTY) | Taskmaster, duty officer | installation token; falls back to shared App | yes once wired | harness | 1h |
| GH_TOKEN, GITHUB_TOKEN, MERGE_MANAGER_GH_TOKEN, GH_AUTH_TOKEN_INTERNAL | legacy PAT fallbacks | none (manual rotation) | NO -> alert + retire | John | PAT expiry per GitHub settings |
| CURSOR_API_KEY | Overseer Cursor judge, Cursor lanes | none (static API key) | NO -> follow-up | John | until revoked |
| /home/appuser/.codex/auth.json | Codex lanes | Codex CLI refreshes its OAuth token itself | yes (CLI) | harness | refresh token lifetime |
| /home/appuser/.claude/.credentials.json | Claude lanes | Claude CLI refreshes OAuth itself; host file mounted via CLAUDE_CREDS_HOST_PATH | partial (CLI refreshes; re-login is manual) | John | refresh token lifetime |
| XAI_API_KEY | Grok lanes | none (static API key) | NO -> follow-up | John | until revoked |
