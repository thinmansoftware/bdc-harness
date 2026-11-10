# Blocked build terminal status

A Cauldron build that ends BLOCKED must not end the run as `completed`. Every
`bdc-feature-development*.yaml` lane that defines `block-reclassify` carries a terminal node,
`blocked-terminal-gate`, that fails the run with the named reason `build_blocked: <status> <note>`
(WO-HARNESS-BLOCKED-BUILD-NOT-COMPLETED-01, bdc-xo#5325).

## What BLOCKED is

`block-classify` and `block-reclassify` decide the build outcome as `PROCEED`,
`ALREADY_SATISFIED` or `BLOCKED` (for example `{"status":"BLOCKED","note":"opus-made-changes-rereview-failed"}`:
the diff review found a real defect, the automatic repair ran once and the re-review still said
needs revision). A BLOCKED build opens no pull request through `commit-and-push`, writes no
`status:review`, and the downstream nodes skip themselves; `blocked-issue` labels the work-order
issue `status:blocked` and `noninteractive-salvage` may preserve real work.

Before the gate every node still completed, so the workflow ended `completed` with
`terminal_cause: all_nodes_satisfied`, and a reader of the run status alone (a watcher, the
Overseer, the conductor) took a blocked build for a pass. Anchor: run deb50328
(WO-DESK-ORDER-INGEST-01, codex lane, 2026-11-10) and 42 other runs in the 14 days before it.

## The gate

`blocked-terminal-gate` depends on `block-reclassify` and on every terminal node of the lane
(salvage, issue label, ledger notes), with `trigger_rule: all_done`, so it is the last thing that
runs. Its bash core is byte-identical across lanes (between the `BEGIN blocked gate core` and
`END blocked gate core` markers):

| `block-reclassify` status | Gate result |
|---|---|
| `PROCEED`, `ALREADY_SATISFIED` | exit 0, the run may complete |
| `BLOCKED` or any other non-empty status | stderr `build_blocked: <status> <note>`, exit 1, the run ends `failed` |
| empty (an earlier gate skipped `block-reclassify`) | exit 0 with a notice: the run's own status stands |

## Who reads it

- Event store: the run ends `failed`, `workflow_failed` carries `build_blocked: ...`, and the failed
  node is `blocked-terminal-gate`.
- Overseer: `classifyError` maps the message to the named class `build_blocked`; `decide` returns
  an escalate-only decision (no blind retry of the same build).
- Smart Cauldron conductor: `judgeGate` fails any `failed` run, so a blocked build is a climb
  signal and the next rung fires (`blocked-build-climb.test.ts`). Before the gate the conductor
  judged a completed blocked run a win whenever any pull request existed, for example one the
  agent opened mid-run.

## Checks

- `bun test ./packages/workflows/src/blocked-terminal-gate.test.ts`
- `bun test ./packages/smart-cauldron/src/__tests__/blocked-build-climb.test.ts`
- Read-only live check after a rebuild (expected 0 for runs started after the rebuild):
  `select count(distinct r.id) from remote_agent_workflow_events e join remote_agent_workflow_runs r on r.id=e.workflow_run_id where e.step_name='review-issue' and e.event_type='node_completed' and e.data like '%status=BLOCKED%' and r.status='completed' and r.started_at > '<rebuild time>'`
