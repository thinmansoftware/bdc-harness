# Smart Cauldron Dual-Supervisor Design

**Date:** 2026-07-10
**Status:** Approved by John Ranson in chat on 2026-07-10
**Extends:** `2026-07-09-smart-cauldron-reliability-kernel-design.md`
**Verification input:** `SMART-CAULDRON-RELIABILITY-VERIFICATION-FINDINGS-2026-07-10.md`

## Objective

Let Sol and Fable monitor every eligible Smart Cauldron incident concurrently while
allowing exactly one supervisor to mutate, repair, cancel, or refire a run at a time.
Sol is the ChatGPT Remote-facing control tower. Fable is the independent verifier
and hot standby. Provider exhaustion or supervisor loss must permit a safe takeover
without duplicate provider fires.

## Boundaries

- This change does not deploy, merge, enable live recovery, or fire a production WO.
- ChatGPT Remote controls the Codex host and Sol task. It does not directly control
  Fable; Fable coordinates through the Smart Cauldron incident ledger.
- Models do not elect authority through prose. Database compare-and-swap operations
  are the only source of repair ownership.
- Both supervisors may observe and publish assessments concurrently.
- Only the current repair lease holder may execute a mutating action.
- A stale supervisor cannot act after takeover. Every mutation checks the current
  fencing token immediately before the side effect.
- Human approval remains mandatory for production deploys, merges, destructive git
  operations, credential/auth changes, and any action already protected by an
  approval gate.

## Architecture

The existing run authority, provider attempt, outcome, and lease records remain the
source of truth. The extension adds a narrow supervisor incident layer:

1. A deterministic incident key identifies one WO/run failure episode.
2. Sol and Fable each write an immutable observation for that incident.
3. A supervisor may claim the repair lease with compare-and-swap.
4. The claim returns a monotonically increasing fencing token.
5. Every repair/refire command must present the current token.
6. A heartbeat renews the lease while work is active.
7. After expiry, the standby may claim a higher fencing token and continue from the
   durable incident and run records.
8. The completed action and evidence are appended to the incident before release.

There is no third LLM overlord. The database ledger and lease rules are the neutral
coordinator.

## Roles

### Sol

- Primary ChatGPT Remote surface for status, steering, and approvals.
- Observes incidents and may diagnose, repair, verify, or refire when it owns the
  repair lease.
- Presents the shared ledger state to John without inventing Fable state.

### Fable

- Observes the same incidents independently.
- Publishes a separate assessment rather than editing Sol's assessment.
- Verifies proposed repair evidence and acts as hot standby.
- May take ownership after a verified lease expiry or when policy selects Fable as
  the capable executor.

## Provider Exhaustion

The current branch does not implement real exhaustion cross-routing. A quota event
currently schedules a same-provider durable wait. The implementation must first
look for an explicitly declared, healthy, capability-eligible failover provider with
independent quota. If one exists, it must create a linked provider attempt and run
the node there. If none exists, the existing durable wait remains the result.

Tests must invoke the actual routing function. Hand-authored JSON round trips do not
prove routing behavior and must be removed.

## Capability Safety

Unknown AI node shapes must not silently inherit a provider's default write tools.
An AI node is text-only only when it explicitly declares a text-only tool posture.
Nodes whose effective tool set is unspecified fail closed to repository execution
requirements unless their type is mechanically non-mutating. Chat-only providers
must be rejected before dispatch for any node that may write or execute shell.

## Notification and Remote Control

The incident ledger is transport-neutral. Existing platform notifications continue
to report to the originating conversation. Sol exposes the incident through the
Codex task visible in ChatGPT Remote so John can inspect, steer, pause, or approve
from a phone. Telegram/SMS/email fanout is a separate notification-router slice and
is not claimed complete by this implementation.

## Failure Handling

- Observer disagreement: persist both assessments; ownership does not change.
- Lease holder stalls: heartbeat expires; standby may claim a higher token.
- Old holder resumes: fencing-token check rejects its mutation.
- Both providers exhausted: persist `waiting_provider` with `resume_at`.
- Auth or configuration failure: stop with operator action required; do not rotate
  providers blindly.
- Ambiguous ownership or missing authority: fail closed without mutation.

## Required Precondition Repairs

The independent verification findings are blocking preconditions:

1. Repair the seven `script-node-deps.test.ts` failures and correct the audit ledger.
2. Replace the tautological exhaustion fixture with real routing tests and code.
3. Fail closed for under-classified repository-writing nodes.
4. Add a database uniqueness backstop for `dispatch_id`.
5. Document migrations 021 through 025.

## Verification

- Two supervisors can append observations for one incident.
- Only one repair lease can be acquired for an incident at a time.
- A takeover receives a higher fencing token after expiry.
- A stale token cannot authorize a mutation.
- Exhausted Claude can route to an eligible Codex failover through real executor
  code, and the inverse route is equally provider-neutral.
- No eligible failover produces a durable wait, not a busy sleep.
- Unknown write-capable nodes reject chat-only providers before a provider call.
- Workspace tests, type-check, bundled checks, format checks, and ASCII checks pass.

## Rollback

The supervisor layer is additive and disabled unless a caller uses it. Rollback is
to stop supervisor workers and revert the additive schema/code commits. Existing
run outcomes, provider waits, and manual resume behavior remain usable.
