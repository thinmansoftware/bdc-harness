# Smart Cauldron -- What It Is and How to Work Inside It

Status: living doc. v1.1 -- 2026-07-01 (incorporates the 2026-07-01 empirical amendments).
Design of record: bdc-xo Downloads/2026-06-29-fusion-and-smart-harness-design.md +
briefs/2026-06-10-cauldron-2-design.md (Smart Cauldron IS Cauldron 2.0 -- one project).
Audience: PART 1 is for humans and any model. PART 2 is the working contract for
builder/planner/reviewer/repair agents running inside a lane -- written so the
cheapest model on the roster can follow it without inference.

## Proposed source repair for review: WO lock metadata mutations (2026-10-18)

Acquisition and release serialize their read-modify-write sequence through a
short exclusive `wx` guard beside the existing WO/project lock. The guard is held
only during metadata I/O. Contention waits at most two seconds, then acquisition
throws UNKNOWN; it never reclaims the guard by age, PID or malformed content.
An abandoned guard needs explicit reconciliation. Each invocation removes only
the guard it created, and guard cleanup failure emits a fixed warning.

Only a validated record in explicit `released` state permits a different cascade
to take over. Exact WO/project, nonempty cascade identity, known status and valid
timestamps are required before interpreting stored evidence. Replacement remains
an atomic temporary-file rename under the guard. Release errors retain shared
evidence and emit a sanitized warning; they never unlink the shared lock.

This source proposal addresses concurrent released-lock takeover and unsafe
release-error deletion. It preserves same-cascade reacquisition, whose separate
lifetime gap remains: a duplicate admission can reach the existing cascade
finally block and release the original caller's running lock. Explicit acquisition
ownership is follow-on work. This proposal is not full acceptance of bdc-xo#1546,
a live two-lane canary, or merge/deployment authority. A mixed-version writer that
does not obey this guard is outside its serialization guarantee.

## Proposed source repair for review: same-dispatch execution ownership (2026-10-18)

The follow-on proposal gives a fresh or explicitly released-lock acquirer a
random execution-generation token, persisted in the WO lock. Same-ID running
reacquisition remains recognizable but returns an explicit null token: it is a
read-only replay, never a second execution grant. Missing ownership metadata from
an injected acquisition dependency is UNKNOWN, not implicit permission.

A replay branches before discovery, admission creation and the owner's finally
block. It reads the durable record through the existing recorder module,
validates exact cascade/WO/project, the existing request identity comparison,
a known status and an attempts array, then reports admission with `created=false`.
Missing or unparseable records, conflicting identity/request and invalid
status/attempts envelopes are UNKNOWN and perform no write, fire or release.
This is not complete field-by-field record-schema validation. It also prevents
a replay arriving before admission from becoming its writer. The frontier
module retains its existing reader export by forwarding the shared reader.

Only the execution-token owner enters provider execution and cleanup. Release
compares exact cascade identity and token under the metadata guard, including
when a later generation reuses the same cascade ID. Stale or missing tokens
leave evidence untouched. Genuine-owner fixtures now state ownership explicitly.

Legacy running lock records without a generation token remain conservatively
held; they require explicit reconciliation or a coordinated drain before any
future version transition. No token is silently backfilled, and mixed-version
writers remain outside the guarantee. This is source validation for review,
not a deployment, live canary or full closure of bdc-xo#1546.

## Proposed source repair for review: Windows checkpoint replacement (2026-10-18)

The composed Taskmaster/cascade fixture repeatedly failed at atomic record rename
with Windows `EPERM` while supervision read the same record. The evidence
establishes the rename failure, not its underlying handle-sharing cause.

The recorder writes its unique temporary payload once, then retries only that
same rename on Windows `EPERM` or `EBUSY`: at most five attempts with waits of
10, 20, 40 and 80 milliseconds (150 milliseconds total scheduled backoff, plus
filesystem I/O). Other errors and non-Windows behavior remain immediate failures.
Exhaustion throws the filesystem error and retains both the old destination and
temporary evidence. It never unlinks, copies over, truncates or recreates the
payload and never retries provider execution.

The real composed fixture failed three repeated runs before the repair and
passed three after it. It exercises pending admission, an actual workflow SQL
projection, sent custody, read-only replay preserving the live lock, exact
completion proof and settled release. Provider calls and Taskmaster storage are
deterministic test dependencies; this is not a live provider or production test.

Persistence exhaustion remains a separate lifetime risk: the existing cascade
finally can release its token even when provider ownership is unresolved. This
bounded persistence repair does not establish safe release on that error path.

## Proposed source repair for review: unexpected provider-lifetime failure paths (2026-10-18)

The follow-on proposal tracks each provider invocation separately before it is
called. Only a recognized terminal poll status with that invocation's exact,
nonempty actual run ID discharges it. This proof is recorded before judging or
later persistence. Fire throw/ambiguous return, transport error, timeout,
cancellation HTTP acknowledgment, recovery acceptance, attempt timestamps and a
later invocation's completion do not discharge earlier work.

Unexpected exits retain the generation-owned WO lock while any invocation is
unresolved and emit a fixed warning. Failures before invocation and failures
after matching terminal proof can release normally. No cancellation, retry,
climb, authority, TTL or takeover policy is added.

There is a narrow legacy exception to preserve the successful existing frontier
approval contract. The no-cancel-to-nowhere branch can nominate only its own
invocation with a nonempty actual provider run ID after the notification routine
returns successfully and the pause checkpoint completes. Release then requires that it is the only unresolved
invocation and that the final record write and normal return succeeded. This
exception is not provider terminal proof; its warning says so explicitly.
Top-of-loop pauses and earlier unknown invocations cannot inherit the exception.

The governing WOs are pinned at bdc-xo commit
`8303e2fa898faa5aedbce48cffc1360943d96a94`: STALL-DETECTOR-FIX requires leaving
the current run running before approval; FRONTIER-CLIMB-APPROVAL-GATE requires
successful approval to fire the preserved premium packet. This proposal preserves
that successful legacy path, not complete approval behavior on unexpected errors.
Failed notification or incomplete persistence can leave a held approval packet
that blocks resume; explicit reconciliation is required. A complete reviewed
provider-lifetime transfer/cancellation design for approval remains open. There
is no universal lifetime-fence or full bdc-xo#1546 acceptance claim.

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

## Entry seat headroom (WO-HARNESS-CONDUCTOR-SEAT-HEADROOM-01)

Before a cascade fires, the conductor may move the entry tier up the ladder when
the picked subscription seat is already hot. Set
`SMART_CAULDRON_HEADROOM_THRESHOLD_PERCENT` to an integer from 1 through 99.
Unset, empty, padded, signed, decimal, zero, 100 or more, and any other
non-matching value use the default 80.

Promotion happens only when the picked seat's maximum window `used_percent` is
at or above that threshold. A pinned entry override never moves. A failed read,
a timeout, or an UNKNOWN seat fails open and keeps the ruleset pick. Routing
never holds the fire, never picks a premium tier, and never moves to a lower
rung. The run-start seat gate (cutoff 90) remains the only wall.

Read `cascade-runs/<slug>/cascade-record.json`:

- `entrySelection.reason` says why the entry was kept or moved (`pinned`,
  `seat_ok:<seat>:<percent>`, `seat_over_threshold:<seat>:<percent>`,
  `no_known_headroom:<seat>:<percent>`, `seat_unknown:<seat>`,
  `seat_usage_unavailable`, or `no_seat`).
- `entrySelection.picked` is the ruleset or override tier.
  `entrySelection.entry` is the tier that fired.
- `entrySelection.seats` lists each seen seat as a used percent or `UNKNOWN`.
- `attempts[].nodeModels` maps each node id to `{ provider, declared, served }`
  from the last `node_completed` or `node_failed` event for that step.

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
