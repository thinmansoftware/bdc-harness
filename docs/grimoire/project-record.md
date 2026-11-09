# Grimoire project record

A registered codebase has one nullable project_record JSON value. The codebase API
is the writer. No record changes merge authority yet.

| Field | Required value |
| --- | --- |
| record_version | 1 |
| tier | bdc, business, client, learning |
| base_branch | String; excluded from production_branches |
| production_branches | Nonempty array of strings |
| test_command | String |
| runner_profile | String |
| spec_home | String |
| reviewer_role | String |
| allowed_providers | Array of strings; empty permitted |
| secret_namespace | String |
| github | connected, authoritative, off |
| approver | String |
| rollout | flag, staged, direct |
| health_url | String or null |
| state | idea, card, first_task, live |

All fields are required within a record. Unknown keys are refused. An empty
production list or a base branch also listed as production returns 400 naming
the field. GET /api/codebases and GET /api/codebases/{id} return the parsed
record or null. Invalid stored values return null with a warning naming the id.

Set a record through the existing PATCH route (use your operator authentication):

```sh
curl -X PATCH http://localhost:3090/api/codebases/CODEBASE_ID \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ARCHON_OPERATOR_TOKEN" \
  --data '{"project_record":{"record_version":1,"tier":"bdc","base_branch":"dev","production_branches":["main"],"test_command":"bun test","runner_profile":"default","spec_home":"docs","reviewer_role":"reviewer","allowed_providers":[],"secret_namespace":"harness","github":"connected","approver":"operator","rollout":"direct","health_url":null,"state":"idea"}}'
```

PATCH with `{"project_record":null}` clears the record; omitting the field keeps
it unchanged. POST registration behavior is unchanged.

```sh
archon project show thinmansoftware/bdc-harness
archon project verify thinmansoftware/bdc-harness
thinman project verify thinmansoftware/bdc-harness --xo-root /path/to/bdc-xo --json
```

`thinman` is an alias for `archon`. Both commands read the registered database.
SQLite inspection opens the existing database read-only without migrations.
Show prints the row and parsed record. Credentials in repository_url are
redacted as `https://***@host/...`, including username and password. Missing or
invalid records report NO_RECORD or RECORD_UNPARSEABLE; missing repos report
REPO_NOT_REGISTERED.

Verify reads without changing rows, policy, or fixture files. Each surface prints
AGREE, DISAGREE with record and live values, or UNREADABLE with a reason:

| Surface | Agreement |
| --- | --- |
| codebase.default_branch | Row default branch equals record base_branch |
| merge_policy.base | Resolved merge policy includes the repo and base branch |
| merge_policy.production | No recorded production branch has unattended=true |
| xo.repo_canonical_map | scripts/cauldron/repo-canonical-map.json contains repo |
| xo.cauldron_projects_base | scripts/cauldron/cauldron-projects.json base_branch matches |

The merge_policy surfaces use the policy merge execution itself applies
(`resolveExecutionMergeRepoPolicy` in `@archon/overseer/merge-execution-bridge`):
`MERGE_MANAGER_REPO_POLICY` when set, otherwise the deprecated
`OVERSEER_MERGE_REPO_CONFIG`, otherwise the legacy/default resolution. Branch
names are matched trimmed and lowercased, as the merge engine does.

XO files are resolved under --xo-root. Without that option both XO surfaces print
SKIPPED with reason `no --xo-root`. Missing entries disagree; unreadable files or
invalid JSON report UNREADABLE. JSON output includes the same surfaces, statuses,
record/live values, reasons, and exitCode.

| Exit | Meaning |
| --- | --- |
| 0 | All checked surfaces agree |
| 1 | At least one disagreement, even if another surface is unreadable |
| 2 | Repo unregistered, record absent, or record unparseable |
| 3 | At least one unreadable surface and no disagreements |

The operator sets the first live record after the governed rebuild. This slice
does not implement project apply or write any projections.
