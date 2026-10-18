# Tee-time offline candidate qualification

This profile proves server health and fail-closed execution boundaries with no
provider credentials or network. It is not a live model canary or demo build.
Related: bdc-xo#3332, bdc-harness#1136.

## Start on the BDC laptop

Build a reviewed, committed candidate with the ordinary Dockerfile and its full
SHA as ARCHON_BUILD_SHA. Set QUALIFICATION_IMAGE to that exact image tag and set
QUALIFICATION_OPERATOR_TOKEN to a fresh random token in the invoking process.
Never print the token or run `docker compose config` into logs.

```powershell
docker compose -f docker-compose.qualification.yml up -d
docker inspect archon-teetime-qualification --format '{{.Image}} {{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.Config.User}}'
docker exec archon-teetime-qualification curl --fail http://127.0.0.1:3092/api/health
docker exec archon-teetime-qualification bun scripts/staging/verify-offline-qualification.ts
docker compose -f docker-compose.qualification.yml down
```

Run verification inside the network-none container. There is deliberately no
published port, host directory/socket mount, provider auth home, GitHub write
token, or automatic restart. The qualification database volume is separate from
all existing staging and production volumes. `down` retains that data volume;
do not remove it as routine cleanup. Artifacts and the empty home are uid-1001
tmpfs mounts. Export sanitized evidence before stopping the container.

The normal entrypoint is bypassed because it refreshes provider authentication.
The actual server entrypoint still runs, including database initialization,
operator authentication and HTTP routes. Offline mode is immutable per process,
validates the final loaded environment, rejects credential-bearing homes, blocks
provider construction and workflow execution, and disables automatic work pickup.
All API writes fail after normal authentication. A rejected credential is not
printed. No credential-free-server claim applies to the ordinary profile.

Pass requires real health, unauthorized private read rejection, authenticated
private read success, model/bash/resume request rejection, provider factory
rejection, and external networking failure. Also inspect network mode, mounts,
image SHA/digest, zero published ports, no attached external network and logs for
absent scheduler startup. Curl must exist and return a connection failure (7 or
28); this alone is not proof of isolation. Save results on the parent
issue. HTTP 200 alone does not satisfy this gate.

Normal-mode regressions and live model transport remain separate gates. Do not
use this mode as evidence that Cursor or Codex builder tools are sandboxed.

## CI qualification

`.github/workflows/offline-qualification.yml` runs on relevant pull requests and
manual dispatch. It uses a fresh hosted runner, read-only repository permission,
pinned checkout/Bun actions, no provider secrets, and a random masked operator
token. It runs the canonical server test command (which isolates mock-bearing
suites in separate Bun processes), builds the exact checkout SHA, starts this
profile, and runs both runtime and host-side isolation checks.

The PR run tests GitHub's merge candidate, not necessarily the PR head SHA.
Evidence identifies the checkout SHA and Docker image ID explicitly. The CI
project and container are unique to run ID and attempt. Cleanup removes only
that disposable CI project's volume; laptop qualification data remains retained.
No promotion or live model execution follows a successful qualification.

Host-side inspection (Python and Docker required):

```text
python scripts/staging/inspect-offline-qualification.py CONTAINER FULL_SHA PROJECT
```

The inspector asserts the image source SHA, UID, root filesystem, network,
capabilities, privilege settings, entrypoint, exact isolated mounts, health, and
absence of published ports/devices. It emits an allowlisted summary rather than
raw Docker inspection data, which would expose the operator token.

## Read-only persisted controller inputs

`loadTeeTimeControllerInput` reads existing workflow-run, codebase and frozen
authority records from the store. It requires the registered tee-time repository,
project-scoped authority artifacts, current bundled policy/workflow revisions,
worktree ownership, exact helper closure and Python/Git executable hashes. It
rechecks records and frozen files after reading the complete committed base.
The Git reader rejects metadata indirection, replacement/promisor/shallow objects,
unsupported entries and incomplete or oversized evidence. It reads binary object
bytes with a closed environment and recomputes the complete root tree.

The returned `worktreeState` is `ownership-only-head-unverified`: frozen
`runScopeSha`/`headBranch` are records, not fresh proof of the checkout's HEAD.
`baseSha` remains the frozen committed base; it is never replaced with HEAD.
The returned `helperExecution` is `frozen-files-no-image-attestation`; configured
file and executable hashes do not prove a pinned-image invocation. A current v1
policy match does not admit a future v2 worker or enable demo features.

These source tests use only disposable Git repositories and synthetic store
records. They create no real run, approval, model/provider client or app feature.
Actual persisted-run capture, candidate adoption, meaningful reviewed tests,
complete reviewer evidence and atomic approval consumption remain separate gates.

## Source-only reviewer catalog reduction

`deriveRestrictedReviewCatalog` accepts only the complete frozen Windows CLI
0.153.3 bundled `gpt-5.6-sol` entry. The ASCII fixture is 42451 bytes, SHA-256
`59f2bbc19bce43c67d6f1cdd99886953a256d948788d85810c774b17375c1fb6`.
Its extraction source was installed binary SHA-256
`e5ef3c4b81d2fb861f3731c91a773d45a1973c6a0b480d6449f80bc8fd749e96`,
complete bundled output SHA-256
`5cd9470c75971da5a479b69101f078558d9c7fc47cdc6706db76fe2ea582009a`.
Only the selected full entry is retained in source; no account data is involved.
Git pins LF and the formatter excludes this exact-byte data file.

Comparison source: official `openai/codex` tag `rust-v0.153.3`, commit
`b1a547b1f73ce86205d9222ac19cff334b3b7a2e`, `codex-rs/models-manager/models.json`
SHA-256 `b31a636f8e1dc23f59770aadc4fb4c23f1cd8828aed8f32bbc6c67de0e72fdac`.
The installed entry includes explicit `false` values for
`model_messages.token_budget.enabled` and `use_history_notes_extension` that
the source catalog omits. Both have `serde(default)` in the pinned protocol
struct; the observed presence difference is consistent with deserialization and
serialization defaults. All other shared fields match. Installed-only and
source-only fields are preserved as observed; this is not binary equivalence.

The pure transformer changes only `shell_type` to `disabled`,
`apply_patch_tool_type` to `null`, `tool_mode` to `direct`,
`experimental_supported_tools` to `[]` (already empty), and
`supports_search_tool` to `false`. It preserves instructions, model identity,
context and transport metadata. Wrong bytes, reserialization, duplicate-key
serialization, extra entries and oversized input fail closed. Returned text and
hashes are immutable. No provider, process, filesystem write or runtime binding
is created by the helper.

This is not tool-free reviewer qualification. A separately reviewed effective
client configuration must also disable shell, code modes, view image, token
budget, clock/sleep, deferred executor, permission requests, image generation,
tool suggestion and deferred world state. Multi-agent must be disabled; MCP,
dynamic tools and extensions must be empty; plan and user-input controls must be
explicit. Apps, hooks, plugins and web search must remain disabled. Removed
feature flags are not accepted as evidence that a tool is absent.

The next no-auth SDK loopback fixture must capture actual complete instructions,
tool definitions and framing for the exact Linux binary. It must find no
executable tools, namespaces or extensions and show that hostile unadvertised
shell/patch/code-mode calls cannot execute or produce accepted approval. Empty
tool metadata may be omitted by legitimate serialization. Context compaction,
output/reasoning capacity, finite review quality, authenticated invocation and
atomic approval consumption remain separate unresolved gates. The existing
6000-byte reviewer limit is unchanged. No foundation/demo admission follows.
