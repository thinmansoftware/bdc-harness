# GitHub Issue Completion Tail Nodes

Reusable Cauldron lanes must record Work Order completion on the WO GitHub issue. The required tail-node contract is `review-issue` for successful or already-satisfied runs and `blocked-issue` for blocked runs. These nodes resolve the `bluedevilcollectibles/bdc-xo` issue by WO ID or explicit issue number and move only status labels; they do not close issues. Issue closure remains native to GitHub through the PR body on merge.

This follows the pattern introduced for the main feature-development lanes in PR #346 and extended by `WO-HARNESS-SECONDARY-LANES-FLIP-GITHUB-01` to the active secondary lanes. Future shared tail work, including `WO-HARNESS-TAIL-NODES-LANE-INVARIANT-01`, should build from this GitHub issue pattern rather than older Notion completion nodes.

The local guard is `scripts/check-no-flip-notion.sh`. It checks the maintained allowlist of active reusable default lanes and intentionally excludes the onramp lane, which is covered by `WO-HARNESS-ONRAMP-FLIP-GITHUB-01`, plus one-off archived per-WO YAMLs that are not expected to run again.
