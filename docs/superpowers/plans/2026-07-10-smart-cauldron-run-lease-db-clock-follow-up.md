# Smart Cauldron Run-Lease DB-Clock Follow-up

Date: 2026-07-10

## Problem

Supervisor repair leases now compare validity against database time, but the
lower-level workflow run lease still receives acquisition, heartbeat, and expiry
timestamps from the worker process. Clock skew between workers can therefore
preserve the dual-execution failure class below the supervisor layer.

## Required outcome

- Derive run-lease acquisition, heartbeat, expiry, takeover, and authorization
  from the database clock on both PostgreSQL and SQLite.
- Pass lease durations across the store boundary instead of absolute caller
  timestamps.
- Preserve monotonically increasing fencing tokens.
- Prove that a skewed worker cannot retain or retake authority after DB-clock
  expiry.
- Cover PostgreSQL SQL shape and real multi-connection SQLite takeover behavior.

## Scope boundary

This follow-up is not implemented in PR #390. It requires its own reviewable change
because the run lease controls every workflow execution, while PR #390's immediate
blockers concern supervisor repair, authority compatibility, and CI packaging.
