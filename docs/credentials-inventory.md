# Credentials Inventory

Every credential the bdc-harness uses to reach an external service, with how it
refreshes, whether the harness can refresh it on its own, who owns it, and when
it expires. Verified live 2026-10-27. Secret VALUES are never printed here --
only names, refresh methods, and ownership.

GitHub App installation tokens are minted and refreshed on demand by the shared
provider in `packages/core/src/github/service-identity.ts`
(`getServiceGitHubToken` / `getGitHubTokenForService`): a token is re-minted
once fewer than 10 minutes of its ~1 hour life remain, concurrent mints for the
same App pool are single-flighted, and a 401 clears the cache and re-mints once
(`packages/core/src/github/request.ts`). A credential that cannot mint or
refresh raises one deduped operator alert
(`packages/core/src/github/credential-alert.ts`).

| Credential | Used by | Refresh method | Self-refresh? | Owner | Expiry |
|---|---|---|---|---|---|
| GITHUB_APP_ID + private key (thinman-overseer App) | Overseer, shared fallback for Taskmaster / Duty Officer / clone / board + WO sources | App JWT -> installation token, ~1h | yes (this WO) | harness | key: none; installation token ~1h |
| GITHUB_APP_MERGE_MANAGER_* | merge manager (distinct merge identity) | App JWT -> installation token | yes (this WO) | harness | ~1h |
| GITHUB_APP_RUN_NODES_* | run nodes / builder lanes | App JWT -> installation token | yes (this WO) | harness | ~1h |
| GITHUB_APP_TASKMASTER_* (currently EMPTY) | Taskmaster, Duty Officer | App JWT -> installation token; falls back to the shared overseer App when empty | yes once wired | harness | ~1h |
| GH_TOKEN, GITHUB_TOKEN, MERGE_MANAGER_GH_TOKEN, GH_AUTH_TOKEN_INTERNAL | legacy PAT fallbacks (last precedence entry) | none (manual rotation) | NO -> alert + retire | John | per GitHub PAT settings |
| CURSOR_API_KEY | Overseer Cursor judge, Cursor lanes | none (static API key) | NO -> follow-up credential-health WO | John | until revoked |
| /home/appuser/.codex/auth.json | Codex lanes | Codex CLI refreshes its own OAuth token | yes (CLI) | harness | refresh-token lifetime |
| /home/appuser/.claude/.credentials.json | Claude lanes | Claude CLI refreshes its own OAuth; host file mounted via CLAUDE_CREDS_HOST_PATH | partial (CLI refreshes; re-login is manual) | John | refresh-token lifetime |
| XAI_API_KEY | Grok lanes | none (static API key) | NO -> follow-up credential-health WO | John | until revoked |

## Notes

- The legacy PAT row groups four env var names that all serve the same "last
  resort" role. Each use of a PAT logs a throttled (once per hour per service)
  warning so the dependency is visible until the PATs are retired.
- Static API keys (CURSOR_API_KEY, XAI_API_KEY) and the Codex / Claude OAuth
  files cannot be minted by the harness. A scoped follow-up WO adds a daily
  credential-health check that calls each provider's cheapest authenticated
  endpoint and alerts on a 401 -- that work is NOT part of this WO.
- Rotating or deleting any existing PAT on GitHub is John's action after this
  change lands.
