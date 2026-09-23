# Dispatch mailbox receipts

How a Dispatch mailbox receipt (`acknowledged_by` / `addressed_by`) is written,
and who is allowed to write it.

Since WO-HARNESS-DISPATCH-ACK-ACTOR-BINDING-01 (board motion M-187a, items 2, 5,
6, 7) the actor recorded on a receipt is resolved from **proven identity only**.
The request body field `principal_id` is never trusted as the actor -- it is
retained for one release as a cross-check and is rejected (409 `actor_mismatch`)
if present and not equal to the resolved actor.

The actor is resolved by `resolveDispatchMailboxActor(c)` in this exact order,
with **no fallback between branches**:

1. If ANY identity header is present (`x-dispatch-principal-id`,
   `x-dispatch-principal-token`, `x-board-principal-token`, `x-xo-holder-token`,
   `x-xo-lease-id`, `x-xo-fencing-token`) the request is an identity request and
   MUST validate as one of the two bindings below. A failed or partial identity
   request returns **401 `dispatch_actor_unbound`**, even when a valid
   `x-archon-operator-token` is also present.
2. **`xo` binding (the seat):** all four proofs against the live board XO lease.
3. **Principal-credential binding:** `x-dispatch-principal-id` +
   `x-dispatch-principal-token` for any principal OTHER than `xo`.
4. **No identity header at all** + a valid `x-archon-operator-token` -> actor is
   `operator`, only `operator`.
5. Otherwise **401 `dispatch_actor_unbound`**.

## Acknowledging as `xo`

Acknowledging (or addressing) a mailbox row whose recipient is `xo` requires the
full live board XO lease -- FOUR proofs, all bound to the seat the caller
currently holds:

- `x-board-principal-token` -- accepted by `authenticateBoardPrincipal`.
- `x-xo-holder-token` -- its sha256 must equal `board_xo_leases.holder_token_hash`.
- `x-xo-lease-id` -- must equal the current `board_xo_leases.lease_id`.
- `x-xo-fencing-token` -- must equal the current `board_xo_leases.fencing_token`.

All four are checked against `getCurrentXoLease()` (the row where `id = 1`,
`released_at IS NULL`, `expires_at` in the future). The lease is then **re-read
inside the same DB transaction that writes the receipt**: if the lease turned
over between the route's read and the write (different `lease_id`, higher
`fencing_token`, released, or expired) the call returns **409 `lease_fence_stale`**
and nothing is written.

The values for all four headers come from **the XO session's own live lease**
(the prompt hook that acquires and renews the seat). They are never literal
values committed to this doc or any file. Read them from your active lease at
call time.

Exact call (substitute the four values from your live lease; `ID` is the mailbox
message id):

```
curl -sS -X POST "$ARCHON_BASE_URL/api/dispatch/messages/$ID/ack" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -H "x-board-principal-token: $BOARD_PRINCIPAL_TOKEN" \
  -H "x-xo-holder-token: $XO_HOLDER_TOKEN" \
  -H "x-xo-lease-id: $XO_LEASE_ID" \
  -H "x-xo-fencing-token: $XO_FENCING_TOKEN" \
  -H "content-type: application/json" \
  -d '{}'
```

Addressing is identical against `/api/dispatch/messages/$ID/address` and requires
that the row was already acknowledged by `xo` (otherwise 409 `address_before_ack`).

Notes:

- The ack/address request body stays `.strict()` and must NOT carry identity. The
  only accepted body field is the optional `principal_id`, and it is a cross-check
  only: if you send `{"principal_id":"xo"}` it must match the resolved actor or the
  call is 409 `actor_mismatch`. Sending `{}` (as above) is the recommended form.
- A dispatch-principal credential presented for `principal_id=xo` is rejected
  (401 `dispatch_actor_unbound`) even if `DISPATCH_PRINCIPALS_JSON` carries an `xo`
  entry -- the `xo` receipt requires the seat, not a credential.

## Operator ack -- the omission path

The `operator` mailbox is acknowledged by the **bare operator token with NO
identity header**:

```
curl -sS -X POST "$ARCHON_BASE_URL/api/dispatch/messages/$ID/ack" \
  -H "x-archon-operator-token: $ARCHON_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{}'
```

This binds the actor to `operator` and only `operator`. If the target row's
recipient is not `operator`, the DAL's `wrong_recipient` check fires and the call
returns **409** with nothing written -- the operator token can never sign for a
row it does not own. This is the omission path: the operator inbox consumer that
sends no identity header can only ever stamp `operator`, never `xo` or any other
principal.

## Status buckets

`GET /api/dispatch/status` reports mailbox depth per principal in seven exclusive,
exhaustive buckets, split at the cutover instant `C`
(`dispatch_receipt_cutover.applied_at`): `unread`, `legacy_unverified`,
`acked_open`, `addressed_by_mind`, `disposed_by_machine`, `surfaced_unacked`,
`surfaced_acked`. Any receipt stamped before `C` is `legacy_unverified` and is
counted in no other bucket (pre-cutover stamps are non-evidence). When the cutover
table has no row (sibling not yet applied) the block returns `cutover_at: null`
and every stamped row is `legacy_unverified`. The former `queue` block is now
`worker_lifecycle` in the response (the `queue` key is retained as an alias for
one release).
