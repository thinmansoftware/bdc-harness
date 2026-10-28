# Harness credential inventory

Values are never printed here. This list is the refresh contract for credentials the harness process can see.

| Credential | Used by | Refresh method | Self-refresh | Owner | Expiry |
| --- | --- | --- | --- | --- | --- |
| GITHUB_APP_ID + key (thinman-overseer App) | Overseer, shared fallback | App JWT -> installation token, 1h | yes | harness | key: none; token 1h |
| GITHUB_APP_MERGE_MANAGER_* | merge manager | installation token | yes | harness | 1h |
| GITHUB_APP_RUN_NODES_* | run nodes / builders | installation token | yes | harness | 1h |
| GITHUB_APP_TASKMASTER_* (currently empty) | Taskmaster, duty officer | installation token; falls back to shared App | yes once wired | harness | 1h |
| GH_TOKEN, GITHUB_TOKEN, MERGE_MANAGER_GH_TOKEN, GH_AUTH_TOKEN_INTERNAL | legacy PAT fallbacks | none (manual rotation) | no: alert and retire | John | PAT expiry per GitHub settings |
| CURSOR_API_KEY | Overseer Cursor judge, Cursor lanes | none (static API key) | no: follow-up | John | until revoked |
| /home/appuser/.codex/auth.json | Codex lanes | Codex CLI refreshes its OAuth token itself | yes (CLI) | harness | refresh token lifetime |
| /home/appuser/.claude/.credentials.json | Claude lanes | Claude CLI refreshes OAuth itself; host file mounted via CLAUDE_CREDS_HOST_PATH | partial (CLI refreshes; re-login is manual) | John | refresh token lifetime |
| XAI_API_KEY | Grok lanes | none (static API key) | no: follow-up | John | until revoked |
