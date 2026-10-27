# Cursor Cloud Agents (cursor-lane implement)

The cursor lane (`bdc-feature-development-cursor`) keeps planning and repair on the local `cursor` provider (`cursor-agent` in the container). Only the `implement` loop uses provider `cursor-cloud`. That step creates one Cursor Cloud Agent per Cauldron workflow run and sends later loop iterations to the same agent. Checkpoint, evidence, manifest, review, and merge gates are unchanged. They judge the git head the agent pushed.

## Dispatch

`CursorCloudAgentProvider.sendQuery` runs when the implement node fires.

1. Read `CURSOR_LANE_IMPLEMENT_TRANSPORT` (see below).
2. Require `options.env.ARCHON_WORKFLOW_RUN_ID` and `options.env.WO_ID`. The loop executor sets those from the workflow run id and `getRunAuthority().woId`. If either is missing the node fails with `CURSOR_CLOUD_CONTEXT_MISSING`. It does not guess and it does not fall back to the CLI.
3. Resolve `origin` to `https://github.com/<owner>/<repo>`. An unparseable remote fails with `CURSOR_CLOUD_REPO_UNRESOLVED` before any Cursor API call.
4. Read `git rev-parse --abbrev-ref HEAD`. If HEAD is detached, create `cauldron/<WO_ID>-<first 8 of the run id>` first.
5. Record that pre-dispatch SHA, then `git push -u origin <branch>`. A failed push stops the node before the API call.
6. Create or reuse the cloud agent and poll its run.

Auth is `Authorization: Basic` with `CURSOR_API_KEY` as the username and an empty password. A missing key throws `CURSOR_API_KEY required for cursor-cloud transport`. The key is never logged, never placed in an error message, and never placed in a URL.

The create body sends the node prompt plus a fixed suffix: commit and push every change to the run branch, and never open a pull request. `autoCreatePR` is false. `workOnCurrentBranch` is true. `mode` is `agent`. `model.id` is the node model (`grok-4.7-high` on this lane). `env.type` is `cloud`.

## Agent id and name

The client-supplied agent id is `bc-` plus the RFC 4122 UUID v5 (SHA-1, DNS namespace) of the raw workflow run id. No extra UUID library is used.

The agent name is `Cauldron <WO_ID> run <first 8 of the run id>`, cut at 100 characters.

The first `sendQuery` for a run calls `POST /v1/agents` (that call creates the agent and its first run). A later iteration on the same provider instance calls `POST /v1/agents/{id}/runs`. If create returns HTTP 409, the provider GETs the deterministic agent id and sends a follow-up run. Routes after create use the id and `url` the API returned.

## Where the URL appears

Right after the agent is created or reused:

- Workflow run metadata JSON key `cursor_cloud_agent`: `{ agent_id, url, run_ids, created_at }`. A recorder failure is a warning and does not fail the build.
- One comment on the WO tracker issue in `thinmansoftware/bdc-xo` (the issue whose title contains the WO id). The comment includes the WO id, the Cauldron run id, and the `url` exactly as the API returned it. The marker is `<!-- cauldron-cursor-cloud-agent:<run id> -->`. If that marker is already on the issue, no second comment is posted. Zero or multiple title matches are a warning and skip the comment. A comment failure is a warning and does not fail the build.
- An assistant chunk `CURSOR_CLOUD_AGENT_URL=<url>` in the run event log.

The agent is never deleted and never archived. There is no DELETE call.

## Fallback flag

`CURSOR_LANE_IMPLEMENT_TRANSPORT`:

| Value | Behavior |
| --- | --- |
| unset or `cloud` | Cloud transport (the default). |
| `cli` | The whole `sendQuery` is delegated to `CursorAgentProvider` (in-container `cursor-agent`). No Cursor API call. |
| anything else | `CURSOR_LANE_IMPLEMENT_TRANSPORT invalid`. Neither transport starts. |

Flip back to the CLI for one process by setting `CURSOR_LANE_IMPLEMENT_TRANSPORT=cli` in the harness environment and restarting that process. Unset it, or set `cloud`, to use Cloud Agents again. This repository does not change the host environment; that is an operator step.

## Cancel

The provider polls `GET /v1/agents/{id}/runs/{runId}` every 10 seconds. It yields a progress chunk only when `status` or `updatedAt` changes, so the implement node's `idle_timeout` (570000 ms) still sees a stalled run and `wall_timeout_ms` (3600000 ms) still bounds the step. There is no separate wall timer in the provider and it does not read the SSE stream.

On `abortSignal` (Cauldron cancel, idle timeout, or wall timeout) the provider calls `POST /v1/agents/{id}/runs/{runId}/cancel` once, reads the run again, accepts `CANCELLED` or another terminal status, yields `CURSOR_CLOUD_CANCELLED=<runId>`, and returns. It does not throw for that abort.

Without an abort, terminal `ERROR`, `EXPIRED`, or `CANCELLED` throws an error that names the status and the agent id and does not contain the API key.

## Head verification

When the Cursor run status is `FINISHED`:

1. `git fetch origin <branch>`.
2. Resolve `origin/<branch>`. If the fetch fails or the branch is missing, the node throws `CURSOR_CLOUD_HEAD_MISSING`.
3. Require the pre-dispatch SHA to be an ancestor of the fetched head (`git merge-base --is-ancestor`). Otherwise throw `CURSOR_CLOUD_HEAD_DIVERGED`.
4. `git merge --ff-only` the fetched head.
5. Require `git rev-parse HEAD` to equal that fetched head.
6. Yield `CURSOR_CLOUD_HEAD_VERIFIED=<sha>` and only then return.

`checkpoint-push`, `assert-implement-produced-work`, stop tests, stop greps, and the manifest then see the agent's pushed head.

## John steps (not done by the builder)

1. Cursor GitHub app repo access. Open https://github.com/organizations/thinmansoftware/settings/installations, choose the Cursor app, and Configure. Under Repository access, select `thinmansoftware/shopops-woo-theme`, `thinmansoftware/thinman-freight`, and the comicstoreos-infra repo (the map names `bluedevilcollectibles/comicstoreos-infra`; Cursor sees `thinmansoftware/comicstoreos-infra`). Repository permissions need Contents: Read and write. Pull requests and Issues write are not required. If the bluedevilcollectibles org still holds the live copies, do the same under https://github.com/organizations/bluedevilcollectibles/settings/installations. Save.

2. Fuelglass cursor budget. Pick a monthly cents number for harness cloud-agent spend (for example `20000` means 200 USD of raw cost) and set `FUELGLASS_CURSOR_MONTHLY_BUDGET_CENTS`. Without it the cursor seat stays a reasoned UNKNOWN. A cursor.com session cookie can also measure the account, but it has no documented refresh, it expires, and it must never be copied from a desktop. Prefer the budget. See `docs/fuelglass-seat-gate.md`.
