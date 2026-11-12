# Advisory pre-check nodes: a failed one does not fail the run

Work order WO-HARNESS-ADVISORY-NODE-FAILURE-NOT-RUN-FAILURE-01 (bdc-xo#5651). Code: `ADVISORY_NODES` and `isAdvisoryNode` in `packages/workflows/src/executor-shared.ts`; the terminal decision in `packages/workflows/src/dag-executor.ts` (next to the paperwork-degraded rule).

## What it is

An advisory node only tries to short-circuit a build. Today the list is one node: `check-already-satisfied` (its own prompt says "ANY doubt -> proceed"). Run e1baeeb2 (2026-11-12) lost its status to it: the node failed (`cursor-agent exited 0 with empty output`), every other node completed and `blocked-terminal-gate` printed `PROCEED`, but the run ended `failed` and a redundant codex rung started.

## The rule

When the only failed nodes are advisory (paperwork nodes may also fail, under their own existing rule), the run ends `completed` with `terminal_cause: advisory_degraded`, `advisory_degraded: true` and `failed_advisory_nodes: [...]` in the run metadata and the terminal event, only if ALL of these hold:

- the workflow's `blocked-terminal-gate` node completed (a workflow without that node needs a pushed artifact instead); a failed or skipped gate keeps the run failed;
- every mechanical evidence node (for example `build-manifest`) completed;
- no other node failed.

Anything else is unchanged: a failed required node, a failed or skipped terminal gate, or an evidence node that did not complete still ends the run `failed` with `terminal_cause: node_failures`. The paperwork rule is unchanged (it still refuses lanes that have mechanical evidence nodes).

## Reading it

`powershell -NoProfile -File scripts/cauldron/inspect-run.ps1 -Wo <WO id>` shows the run `completed`; its terminal event carries `terminal_cause: advisory_degraded` and the node list; the log line is `dag.workflow_completed_advisory_degraded`. A degraded notice is posted naming the node.

## Adding a node

Add its id to `ADVISORY_NODES` only if its failure can never mean the work failed (a pre-check that defaults to "proceed"). A node that decides a gate belongs in the required set.
