# Zero-tier floor: five fences and the first-10 measurement

WO: WO-HARNESS-ZERO-TIER-FENCES-AND-FLOOR-01
Ruling: motion M-20261027a round 6, "Items 3-16 -- XO rulings", item 5; John's
routing ruling on bdc-xo#4282 ("Go"); Grok's five fences (round-6 Q6).

## What changed

Plain `woClass: CODE` Work Orders with no risk tag now enter the cheap open-model
`zero` lane (workflow `bdc-feature-development-zero-open`) instead of `cursor`.
Billing, money, payment, stripe, auth, oauth, security, INFRA, and
feature/net-new/multi-surface WOs stay on `cursor`. `defaultEntry` stays `cursor`
for anything unclassified. The single routing change is the last rule in
`packages/smart-cauldron/config/ruleset.config.json` (woClass CODE, no tags):
its `entry` value changed from `cursor` to `zero`.

## The five fences (verbatim, Grok round-6 Q6)

1. Change only the plain `CODE` rule from `cursor` to `zero`. Leave billing,
   money, payment, stripe, auth, oauth, security, INFRA, and
   feature/net-new/multi-surface on `cursor`, above that rule. Verified: first
   match wins, and tags are whatever the CLI passes. The conductor does not read
   WO frontmatter. An untagged billing WO would enter zero.
2. Keep zero-open's open-model cross-review. Do not apply #4289 items A and B to
   `-zero-open`. Fable runs once, at push, on the rung that opens the PR, not six
   times on rung 1.
3. One climb, then stop. That is the 2-attempt rule. The header's full climb
   (Codex, Claude, Sol+Fable) is too many, and a Codex 429 must not fall through
   onto Claude.
4. One run row. The next rung starts only after the first is terminal. No second
   fire.
5. `allow_issue_fallback: true` stays off for this new entry. A plain CODE WO
   with no spec on `main` is BLOCKED.

## How the fences are implemented

- Fence 1: `packages/smart-cauldron/config/ruleset.config.json` -- the last rule
  (woClass CODE, no tags) has `entry: "zero"`. Every rule above it, the
  mechanical CODE rule, and `defaultEntry: "cursor"` are unchanged.
- Fence 2: `.archon/workflows/defaults/bdc-feature-development-zero-open.yaml`
  names no `claude-` model on any node. No review-seat change was made.
- Fence 3: `packages/smart-cauldron/config/ladder.config.json` carries
  `"maxClimbsByEntry": { "zero": 1 }`. `ladder.ts` loads it
  (`loadMaxClimbsByEntry`); a tier absent from the map has no limit. In
  `cascade.ts`, at both climb sites (gate-fail and seat-refusal), a cascade whose
  ENTRY tier has a limit stops with status `blocked` and reason
  `climb_limit_reached` and escalates once instead of firing another rung. With
  `qwen` refused, the one climb from `zero` lands on `cursor`, then stops.
- Fence 4: the cascade fires the next rung only after the current run's polled
  status is terminal, and the recorder holds one attempt per rung. This behavior
  predates this WO; a cascade test asserts it for the zero lane.
- Fence 5:
  `.archon/workflows/defaults/bdc-feature-development-zero-open.yaml` sets
  `allow_issue_fallback: false`. The bundle
  `packages/workflows/src/defaults/bundled-defaults.generated.ts` is regenerated
  with `bun run generate:bundled`.

## Running the fence and measurement tests

Run the fence tests (Tests 1-6) and the measurement tests (Tests 7 and 8) with
the one canonical invocation:

```
bun run test:zero-tier-fences
```

Expected: `Ran 81 tests across 3 files` -- the file count is the check that
matters. If it says `across 2 files`, the measurement tests did not run.

Do NOT hand-roll this command with a bare `scripts/` path. `bunfig.toml` sets
`root = "./packages"`, so a bare path arg under `scripts/` is not resolvable as
a path and is instead treated as a name filter against that root. When it is the
only arg bun exits 1, but when it is mixed with args that DO match (the two
package paths above) bun runs those, silently ignores the unmatched filter, and
exits 0 -- a green result in which Tests 7 and 8 never loaded. For this reason
the invocation is pinned in `package.json` as `test:zero-tier-fences` with the
leading `./` baked in, and `.github/workflows/test.yml` runs that same script in
the Linux `test` job rather than repeating the paths, so CI and this documented
command cannot drift. Tests 7 and 8 therefore execute on every push and pull
request.

## Measuring the first 10 zero-tier runs

The run-completion report counts the first 10 terminal runs of the zero-open lane
started at or after a cutoff you pass. Set the cutoff to the governed rebuild
time (the moment the new routing went live).

```
docker exec archon-app-1 bun run /app/scripts/run-completion-report.ts \
  --days 14 --zero-since '2026-11-02 18:00:00'
```

Replace the timestamp with the actual rebuild time (UTC, `YYYY-MM-DD HH:MM:SS`).
Add `--json` for machine-readable output (the same data is under the `zero_tier`
key). The report prints:

- `zero_tier_first10:` -- one line per run, in started_at order: short run id,
  status, and the step names of any `node_failed` events.
- `zero_tier_failed: N/M` -- N = runs with status `failed` or `escalated` (a run
  that did not pass its in-lane review gates); M = runs listed (up to 10).
- `zero_tier_verdict:` -- `REVERT` when N >= 3; `KEEP` when M = 10 and N < 3;
  else `PENDING M/10`.
- `zero_tier_cancelled:` -- cancelled runs after the cutoff. Cancelled runs are
  excluded from the 10.

## The verdict and the revert procedure

Per ruling item 5: if 3 or more of the first 10 zero-tier runs fail review, the
XO reverts the routing and tells John the numbers.

- KEEP (fewer than 3 of 10 failed): leave the routing on `zero`. No action.
- REVERT (3 or more failed): the operator (XO) reverts by a single-value edit.
  There is no automated revert.

Revert steps:

1. In `packages/smart-cauldron/config/ruleset.config.json`, change the last
   rule (woClass CODE, no tags) `entry` from `zero` back to `cursor`. Change
   only that one value. Do not touch `defaultEntry`, any tagged rule, the
   mechanical CODE rule, the ladder, or the YAML.
2. Open a PR to `dev` in `thinmansoftware/bdc-harness`. Do not merge it
   yourself; the merge-steward/operator merges.
3. After merge, trigger the governed container rebuild so the new routing is
   live.
4. Tell John the numbers: the `zero_tier_failed: N/M` count and the per-run
   list from the report, plus the revert PR link.

Record both report outputs (and, if REVERT, the PR link and the message to
John) as a comment on this WO's GitHub issue.
