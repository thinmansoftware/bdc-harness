# Smart Cauldron -- What It Is and How to Work Inside It

Status: living doc. v1.1 -- 2026-07-01 (incorporates the 2026-07-01 empirical amendments).
Design of record: bdc-xo Downloads/2026-06-29-fusion-and-smart-harness-design.md +
briefs/2026-06-10-cauldron-2-design.md (Smart Cauldron IS Cauldron 2.0 -- one project).
Audience: PART 1 is for humans and any model. PART 2 is the working contract for
builder/planner/reviewer/repair agents running inside a lane -- written so the
cheapest model on the roster can follow it without inference.

---

# PART 1 -- The system in plain words

## What Smart Cauldron is

Smart Cauldron is a build factory that THINKS about cost. When a Work Order (WO)
arrives, it does not send the work to the most expensive model. It sends it to the
cheapest model that can plausibly do it. Hard gates (tests, CI, adversarial review)
judge the result. If the result fails the gates, the work climbs to a stronger model.
If it passes, we shipped frontier-quality work at bargain cost.

One sentence: **cheap first, gates judge, climb only when the gates say so.**

## The five layers (from the Cauldron 2.0 brief)

| Layer | Name | What it does |
|---|---|---|
| 1 | Spine | System of record: every WO is a GitHub issue; evidence ledger; gate registry |
| 2 | Router | Picks the entry tier per WO (ruleset in v1; learned later) and climbs on gate-fail |
| 3 | Engine | The lanes: DAG workflows that plan, build, review, repair, and open the PR |
| 4 | Validation | GitHub is the only quality authority: CI checks, manifest gate, adversarial review |
| 5 | Deck | The human view: cascade trace, cost + savings, integrity flags, waiting-on-John |

## The roster is a ROLE MATRIX, not a model ladder (v1.1 amendment)

The original design treated each model as one rung: GLM = cheap, Codex = mid,
Claude = high, Fable = top. Live data (2026-07-01) proved that is the wrong grain.
A model's competence differs BY ROLE:

| Model | Plan (agentic repo search) | Build (execute a plan) | Review | Repair loops |
|---|---|---|---|---|
| GLM (glm-5.2 via OpenRouter) | NO -- hangs (runs 818d4b62, d3f1b36c) | YES -- 10/12 on deterministic specs | untested as reviewer | NO -- cannot converge |
| Codex (gpt-5.5) | untested | YES | YES (adversarial) | YES |
| Claude Sonnet | YES | YES | YES | YES |
| Fable / frontier | top rung | top rung | top rung | top rung |

So a LANE is a composition of roles, each pinned to the cheapest model PROVEN for
that role. The current hardened GLM lane is the reference primitive:

```
plan:    claude/sonnet   (bounded passes; GLM cannot drive agentic search)
build:   glm-5.2         (the long, expensive part -- zero Claude burn)
review:  codex/gpt-5.5   (cross-model: a builder never reviews its own work)
repair:  claude/sonnet   (only fires when review flags something)
```

Rule: a model earns a ROLE seat with evidence from real runs, not a whole-lane seat
by assumption. (Trust gate, design sec 8.6; roster-seat doctrine 2026-06-29.)

## The three failure classes (v1.1 -- there are three, not two)

| Class | Signature | Correct response |
|---|---|---|
| Availability | model did not respond: timeout, 429, 500 | FAILOVER sideways: retry on next available model, same tier |
| Quality | model responded, build FAILED the gate | CLIMB: escalate the role one tier up |
| **Progress** | model responds, no error, burns tokens, NEVER reaches the gate (repeated output, no tool calls) | WATCHDOG kill: treat as quality-fail at that node, climb |

Progress failure is the 2026-07-01 discovery: run 818d4b62 emitted the same
preamble for 34 minutes; run d3f1b36c for 6. No gate ever fired because the work
never arrived at one. Every lane needs a progress watchdog: N minutes with no
tool call, or M consecutive near-identical outputs, kills the node and climbs.

## Layer 0: gate the INPUT before picking any rung (v1.1 -- the GIGO gate)

Climbing the ladder cannot fix a bad spec. A WO containing an unresolved decision
branch ("scope both approaches, decide during build") or an un-runnable stop
condition hung two runs at the planning node; the SAME WO rewritten deterministic
(one pinned approach, real file targets, verified prior art) cleared planning in
90 seconds on the same lane. Frontier models would fail the bad spec too -- just
at frontier prices.

So before the router picks a tier, the spec must pass the WO 12-gate (concrete,
answerable checks: behavior source of truth present, CI-executable stop conditions,
schema verified, no unresolved decision branches, prior art checked against live
code). Spec fails -> bounce to spec-repair. Never climb on garbage input.

## Integrity: served vs DECLARED, not served vs requested (v1.1 amendment)

Record which model actually served every call (served_model_id). Compare it to the
model the LANE YAML DECLARES -- not to the runtime request. Reason: bug #298 dropped
provider/model pins from loop nodes at PARSE time, so the runtime request itself was
already wrong; served == requested while both silently differed from the YAML. The
declared-model comparison catches parse-layer drops; the requested-model comparison
cannot. A run where served != declared is flagged RED on the deck.

## Honest gates are the foundation (unchanged, one addition)

The cascade's whole decision engine is gate verdicts. A lying gate poisons routing:
phantom fails burn money climbing; phantom passes ship junk. Known liars fixed or
pending: tail nodes (patch-pr-body et al.), and the too-eager fallback REVIEW-flip
(2026-06-30: three substantively-incomplete WOs flipped to REVIEW). The fallback
flip is a lying gate and is on the section-6 prerequisite list.

## What Smart Cauldron never does (safety, unchanged)

- It routes and advises. Human gates stay: PROCEED DEPLOY, customer sends.
- LLM reasoning is for RECOVERY and ROUTING only. It never declares success;
  the hard gate at the door declares success.
- No live secrets ever reach a model. A secret found in a diff is redacted and
  reported as a finding.

## The frontier-approval gate (operator control -- WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01)

Premium usage is never burned on an unattended escalation. When an AUTOMATIC
climb would fire a **premium tier** (config `premiumTiers` in
`packages/smart-cauldron/config/ladder.config.json`, default `["frontier"]`),
the cascade does NOT fire it. Instead it PAUSES:

- The cascade record is written with status `pending-frontier-approval` and a
  preserved escalation packet (the tiers already failed, the informed-climb
  context the frontier fire would have carried, the WO id, project, and tags --
  never the operator token).
- Exactly ONE operator notice is emitted through the existing escalation
  machinery, naming the WO, the failed tiers, and the two commands below.
- Nothing else happens until an operator resolves the pause.

Ruling: John, 2026-08-18 -- "then dont waste my usage if it will fail please"
(after three auto-climbs to the fable tier burned premium usage in one day).

**An explicit `--entry frontier` fire is NOT gated** -- a human typed it, so it
fires immediately. Only the automatic climb path pauses.

### Resolving a paused cascade (operator)

Both endpoints live under `/api/*` and require the operator token
(`x-archon-operator-token` header or `Authorization: Bearer`). They are
idempotent -- a second call is a no-op that reports the recorded resolution, so
a premium fire happens at most once.

Approve (resume the cascade and fire the premium tier exactly once, replaying
the preserved climb context):

```bash
curl -s -X POST "$ARCHON_API_BASE_URL/api/cascades/<cascadeId>/approve-frontier" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN"
```

Reject (terminate the cascade as needs-human; no premium fire):

```bash
curl -s -X POST "$ARCHON_API_BASE_URL/api/cascades/<cascadeId>/reject-frontier" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"operator/config task no model can complete"}'
```

Outcomes: approve -> a NEW resumed cascade fires the premium tier (the original
paused record keeps a `resumeCascadeId` back-reference). Reject -> the record
becomes `frontier-rejected` (a distinct terminal state; CLI exit codes 7 and 8
respectively). The premium tier's own gate-fail path (SPEC-REPAIR) is unchanged
and applies once the tier actually fires via approve or explicit entry.

(The `Cauldron-Fire` skill referenced by the WO manifest is operator-side and
not reachable from the build container; these commands are documented here as
the in-repo source of truth.)

---

# PART 2 -- You are a node in a lane: your contract

You are one agent inside a Cauldron lane. You have ONE role: planner, builder,
reviewer, or repairer. Read your section. Follow it exactly. Do not do another
node's job.

## Rules for every node (read first)

1. Your output is NOT trusted. A gate after you judges it. Do not declare success;
   produce work and let the gate decide.
2. Never say a thing is done without a command that proves it. "It should work" is
   a failure. `grep -n <thing> <file>` returning the line is proof.
3. If you catch yourself writing the same sentence twice without running a tool
   between them: STOP. Run a tool or emit your failure token. Repeating yourself
   means you are stuck, and stuck-with-output is the worst failure class (it burns
   money silently). It is ALWAYS better to fail loudly than to loop.
4. Stay inside the WO scope. Files not named by the WO or your plan do not get
   touched. Out-of-scope edits fail the review gate.
5. ASCII only in code and scripts. No emojis, no smart quotes, no em-dashes.
6. Never print a secret. Not in output, not in logs, not in a commit.

## If you are the PLANNER

Input: the WO spec. Output: a plan the builder can execute WITHOUT thinking.

1. Read the spec completely before any tool call.
2. Verify the spec's claims against the actual repo: every file path it names,
   every schema column it references, every route it says exists. The repo is
   ground truth. Spec says X, code says Y -> trust the code, note the conflict.
3. Your plan MUST list: exact files to create, exact files to modify, exact files
   out of scope, verification commands, the commit message, and the push policy.
4. A plan step the builder must "figure out" is a defect in YOUR work. If the spec
   forces a decision you cannot resolve from the repo (two approaches, missing
   target), do NOT guess and do NOT pass the ambiguity downstream. Emit the
   blocked token with one sentence naming the missing decision.
5. Search the repo with bounded effort: if 10 tool calls have not found the thing,
   say what you searched and what you did not find. Do not search forever.

## If you are the BUILDER

Input: the approved plan. Output: code that satisfies the plan, committed.

1. Execute the plan as written. The thinking already happened. Do not redesign,
   do not add features, do not refactor neighboring code.
2. Touch ONLY the files the plan names.
3. After each file change, run the plan's verification command for that step.
   Paste the real output. If verification fails, fix THAT step before moving on.
4. Match the style of the surrounding code. Same naming, same comment density.
5. Write tests that assert real values (exact counts, exact strings, response
   shapes). A test that cannot fail is a defect.
6. When every plan step verifies: run the full listed test command once, then
   commit with the plan's commit message. Do not invent new commit steps.
7. Stuck on a step after 3 real attempts (attempt = a changed approach, not a
   retry of the same command): emit the blocked token naming the step and the
   error text. Do not silently skip the step. Do not loop.

## If you are the REVIEWER

Input: the diff + the WO. Output: findings, or an explicit pass.

1. You are adversarial. Your job is to REFUTE the build, not to approve it.
   Hunt: broken behavior, unmet stop conditions, out-of-scope edits, fake tests
   (tests with no real assertions), missing manifest files, secrets in the diff.
2. Every finding must name file + line + the concrete failure scenario. "This
   could be cleaner" is not a finding.
3. Verify the stop conditions from the WO one by one, by running them where
   runnable. Unrunnable stop condition = a finding.
4. If the build is genuinely clean, say so ONCE with the pass token. Do not
   invent findings to look thorough; phantom findings burn a repair cycle.

## If you are the REPAIRER

Input: the reviewer's findings. Output: the smallest diff that resolves them.

1. Fix ONLY the named findings. No opportunistic improvements.
2. One finding at a time: read the finding, read the code, make the edit, run
   the verification for that finding, then next.
3. If a finding is wrong (the reviewer misread), do not "fix" working code.
   Say which finding you dispute and why, with the proving command output.
4. After all findings: run the full test command, paste output, emit the done
   token. If any finding survives 2 repair attempts, emit the blocked token
   naming it. Never loop on the same finding a third time.

## The tokens (how you end your turn)

Your node prompt names the exact sentinel tokens for done / blocked / pass.
Use them. Ending a turn with none of them, or with narration instead of a token,
counts as a progress failure and gets your node killed by the watchdog and the
work escalated over your head.

---

## Glossary (no jargon unexplained)

- **WO (Work Order):** one unit of work with a spec, stop conditions, and a manifest.
- **Lane:** a workflow (DAG of nodes) that takes a WO from spec to opened PR.
- **Node:** one step in a lane, executed by one model in one role.
- **Gate:** a hard check that judges work: tests, CI, manifest-validate, adversarial review.
- **Climb / cascade:** re-running a failed role one tier up the model roster.
- **Failover:** retrying an UNAVAILABLE model's call on a peer at the same tier.
- **Watchdog:** the monitor that kills a node making no progress (no tools, repeated output).
- **Manifest:** the machine-parsed completion block in the PR body (files, tests, grep
  assertions, VALIDATION: PASS). Missing or false manifest = auto-reject.
- **Served vs declared:** the model that actually answered a call vs the model the lane
  YAML pins for that node. Mismatch = integrity flag.
