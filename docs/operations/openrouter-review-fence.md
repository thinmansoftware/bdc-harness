# OpenRouter Review Fence

WO-HARNESS-OPENROUTER-REVIEW-DIFF-SCAN-01

Cheap open models on OpenRouter may review code for paying-customer repositories,
but only behind two fences (motion M-20261027a round 6, item 6, REPLACED):

1. **Pre-send scan.** Before any diff or prompt from a customer repository
   reaches an OpenRouter review seat, the harness scans the transmitted content
   for secrets and customer data. On any hit -- or if the scan cannot run -- the
   review is rerouted to a Claude/Codex seat instead, and the decision is
   recorded.
2. **Privacy pin.** Every OpenRouter request on a customer-repo run that passes
   the scan is pinned to providers that promise not to train on or retain what
   they are sent (`data_collection: "deny"`, `zdr: true`).

## Which repositories are fenced

Only the three paying-customer repositories:

- `thinmansoftware/lspro-react`
- `thinmansoftware/shopops`
- `thinmansoftware/shopops-storefront`

Non-customer repositories (`bdc-harness`, `bdc-xo`, etc.) are not scanned and
get no pin change.

## Which routes are fenced

Any node whose provider is carried by OpenRouter:

- Text-only seats: `opr`, `opr-zero`, `glm`
- The repository-reading tool-loop seat: `openrouter`
- `codex-opr` (a Codex seat whose auth-failure failback is an OpenRouter seat) --
  always treated as an OpenRouter route regardless of model, so it is gated
  before Codex is dispatched.

The tool-loop seat (`openrouter`) reads files under the worktree and sends tool
results to OpenRouter *after* the gate runs, so no pre-send scan can cover what
it transmits. On a customer repo it is **always rerouted** with verdict
`scan_unavailable` and reason `repo_read_unscannable`.

## What is scanned

Two bodies of text, both with EVERY line scanned:

- **(a) The repository diff** -- `git diff <merge-base>..HEAD` of the worktree
  against the base branch. Every line of the unified diff is scanned: added
  (`+`), removed (`-`), context, and header lines (prefixes stripped). Cached
  per run id + HEAD sha (the diff is identical for every node at a fixed HEAD).
- **(b) The outgoing prompt** -- the full prompt text for THIS request,
  including any system/persona text. Scanned on every request and **never
  cached**: a prompt verdict is never reused for another node, iteration, or
  retry.

Either body producing a hit, or an unavailable scan, decides the route.

### Customer-data patterns

| Kind          | What matches                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `email`       | An email address. Ignored: domains `example.com`, `example.org`, `users.noreply.github.com`, and the address `noreply@anthropic.com`. |
| `phone`       | US phone forms `(NNN) NNN-NNNN`, `NNN-NNN-NNNN`, `NNN.NNN.NNNN`, `+1NNNNNNNNNN`.                |
| `stripe_id`   | `sk_`/`pk_`/`rk_` + `live_`/`test_` + 10+ alphanumerics; or `cus_`/`sub_` + 8+ alphanumerics.  |
| `tenant_slug` | Any slug from `OPENROUTER_FENCE_TENANT_SLUGS`, but only when it appears in a file whose path contains `fixtures`, `__fixtures__`, `seed`, or `.fixture.`. (Diff only -- prompt text has no file path, so tenant slugs are not matched there.) |
| `gitleaks`    | Any finding from gitleaks 8.30.1 with its default ruleset (plus the worktree `.gitleaks.toml` / `.gitleaksignore` when present). Recorded with its RuleID. |

Hits never carry the matched value -- only a kind and a location. Diff hit
locations are `file:line`; prompt hit locations are `prompt:<offset>`.

## Environment variable: `OPENROUTER_FENCE_TENANT_SLUGS`

A comma-separated list of customer tenant slugs (for example
`mutant-market,acme-comics`). Set this in `/opt/bdc/archon/.env` on the governed
host.

If this variable is **unset or empty**, the fence fails closed: every
customer-repo OpenRouter review gets verdict `scan_unavailable` (reason
`tenant_slugs_unset`) and is rerouted. This is intentional -- the harness cannot
prove a change is free of a real tenant slug without the list.

## Fail-closed conditions (verdict `scan_unavailable`, reroute)

- `tenant_slugs_unset` -- `OPENROUTER_FENCE_TENANT_SLUGS` is unset/empty.
- `gitleaks_unavailable` -- the gitleaks binary is missing or exited with an
  error other than "findings present".
- `repo_diff_unavailable` -- the repository diff could not be produced.
- `repo_read_unscannable` -- the tool-loop seat (`openrouter`), which is always
  rerouted on a customer repo.
- `openrouter_no_private_endpoint` -- a pinned request was refused because no
  endpoint satisfies the zero-retention / no-training policy. The request is
  rerouted and is **never** retried without the pin.

## The reroute target

On a hit or an unavailable scan, the review goes to the node's declared
`failover_provider` when that provider is **not** OpenRouter-backed; otherwise
it goes to `codex-native-strict` with no model override. The OpenRouter persona
(system prompt / `agent`) is dropped on reroute.

## Reading the decision events

One `openrouter_diff_scan` workflow event is recorded per gate decision. Its
`data` object carries:

```json
{
  "repo": "thinmansoftware/lspro-react",
  "node_id": "diff-review",
  "original_provider": "opr",
  "routed_provider": "opr",
  "verdict": "clean",
  "reason": "",
  "hit_kinds": [],
  "hit_locations": []
}
```

- `verdict`: `clean` (sent on OpenRouter with the pin), `hit`, or
  `scan_unavailable` (both rerouted).
- `routed_provider`: where the review actually went. On a clean verdict this
  equals `original_provider`.
- `reason`: the fail-closed reason (see the table above) or `customer_data` on a
  pattern/secret hit.
- `hit_kinds` / `hit_locations`: the kinds found and their `file:line` (or
  `prompt:<offset>`) locations. **Never** the matched value.

To list recent decisions on the governed host:

```sh
sqlite3 /opt/bdc/archon-data/archon.db \
  "select created_at, json_extract(data,'$.repo'), json_extract(data,'$.verdict'), json_extract(data,'$.routed_provider') \
   from remote_agent_workflow_events where event_type='openrouter_diff_scan' order by created_at desc limit 20"
```

## Operator steps after merging this change

1. Rebuild the governed image (it now installs gitleaks 8.30.1 to
   `/usr/local/bin/gitleaks`).
2. Set `OPENROUTER_FENCE_TENANT_SLUGS` in `/opt/bdc/archon/.env` to the current
   customer tenant slugs.
3. Restart the harness so the new env and binary take effect.

Until both the rebuild and the env var are in place, every customer-repo
OpenRouter review fails closed (reroutes) -- safe, but noisier and more
expensive than intended.
