# Overseer owner routing

WO-HARNESS-OVERSEER-OWNER-ROUTING-01 (bdc-xo #5030). Overseer escalation cards
name and reach the work's recorded owner, or an explicit `unowned` bucket for
John to assign. They never default to XO (ratified M-93 clause 2). An explicit
XO assignment still reaches XO (M-93 clause 3).

Code: `packages/overseer/src/owner-resolution.ts` (`resolveWorkOwner`,
`readOwnerRoutingMode`), `packages/overseer/src/escalate.ts` (`runEscalation`),
`packages/overseer/src/escalation-delivery.ts` (`parseOwnerRouteTable`, the
dispatch and builder_monitor adapters), `packages/core/src/github/owner-label.ts`
(`listOwnerLabels`, `parseOwnerLabel`), `packages/core/src/db/dispatch-routing.ts`
(`UNOWNED_RESPONSIBLE_ACTOR`).

## Modes: `OVERSEER_OWNER_ROUTING`

Only the exact strings `shadow` and `on` are recognized. Anything else,
including unset, `ON` or `on ` with a space, is `off`.

| Mode | Card payload | `responsible_actor` (caller passed none) | Operator row | Owner row (`t3-desk-local`) | `t3-desktop` row | builder_monitor `action` |
|---|---|---|---|---|---|---|
| `off` (default) | unchanged, same digest; resolver not called | `acting-xo` | yes | no | yes | `needs_human` |
| `shadow` | adds `owner_assignment` | `acting-xo` | yes | no | yes | `needs_human` |
| `on`, owned, route present | adds `owner_assignment` | owner handle | no | exactly one | yes | `needs_human` |
| `on`, owned, no route or invalid table | adds `owner_assignment` | owner handle | no | no | yes | `needs_owner` (`owner_route_missing`) |
| `on`, unowned | adds `owner_assignment` | `unowned` | no | no | yes | `needs_owner` |
| any, caller passed `acting-xo` / `xo` / `operator` | per mode | caller value | yes | no | yes | `needs_human` |

An explicitly passed `responsibleActor` or `nextPermittedAction` always wins
over the resolution. In mode `on` with no caller value, `next_permitted_action`
is one of:

- `owner <handle> acts on this card` (owned)
- `John assigns an owner on bdc-xo#<N>` (unowned, WO issue found)
- `John assigns an owner (no WO issue found for <woId>)` (unowned, no issue)

A blank actor is no longer an XO principal (`isXoResponsibleActor('')` is false).

## Resolver order and reasons

`resolveWorkOwner({ woId, repository, prNumber })`, bounded by 5 seconds
(`WORK_OWNER_LOOKUP_TIMEOUT_MS`). It never throws.

1. Search `thinmansoftware/bdc-xo` issues (not PRs) with `woId` in the title.
   Keep only issues whose title, split on characters outside `[A-Za-z0-9-]`,
   has a token exactly equal to `woId`. `WO-X-01` does not match
   `WO-X-01-REPAIR-01`.
2. Open issues win over closed ones. Zero candidates -> `no_issue`. Two or
   more candidates -> `multiple_issues`.
3. On the chosen issue, read the valid `owner:<login>` labels (deduplicated
   case-insensitively). Zero -> `no_owner_label`. Two or more ->
   `multiple_owner_labels`.
4. Exactly one owner label: find the newest complete provenance comment for
   that handle (below). None -> `owner_label_without_provenance`.
5. Any GitHub error, an over-long comment thread (more than 1000 comments), or
   the 5-second bound expiring -> `lookup_failed` (logged as
   `overseer.owner_routing.lookup_failed`).

Results:

- `{ kind: 'owned', owner, assigned_by, assigned_at, quote, source_issue }`
- `{ kind: 'unowned', reason, source_issue }`, `source_issue` null for
  `no_issue`, `multiple_issues` and `lookup_failed`

`source_issue` is `thinmansoftware/bdc-xo#<N>`. The result is stored as
`payload.owner_assignment` on the card (no schema change).

## Provenance comment format (strict)

An owner label counts only with a comment on the same issue containing, each
on its own line:

```
Owner assigned: codex
Assigned by: John Ranson
Assigned at: 2026-11-08
Quote: <John's words, verbatim>
```

- `Owner assigned` must equal the label suffix (case-insensitive).
- `Assigned at` is `YYYY-MM-DD` or ISO-8601 UTC (`2026-11-08T14:00:00Z`).
- A comment missing any of the four lines does not count.
- The newest complete comment for that handle wins.

Every seat uses the same `gh` login, so the comment is attribution, not
authentication.

## Route table: `OVERSEER_OWNER_ROUTES_JSON`

```
OVERSEER_OWNER_ROUTES_JSON={"codex":{"recipient":"t3-desk-local","thread_id":"<T3 thread id>"}}
```

- Keys are owner handles (matched case-insensitively).
- `recipient` must be exactly `t3-desk-local` (the T3 desktop relay queue).
  Worker or model recipients are never accepted.
- `thread_id` must be a non-blank string.
- Fail closed: invalid JSON, a non-object, any bad entry, or a duplicate
  handle rejects the WHOLE table. It is logged as
  `overseer.owner_routing.routes_invalid` (once per distinct value) and
  behaves as an empty table: no owner rows are written.
- Unset or blank is a valid empty table.
- The table is read only in mode `on`.

## Owner row

One `agent_message` row per card, sender `system:overseer`, recipient
`t3-desk-local`, idempotency key `operator-card:<card_id>:dispatch:owner`
(redelivery and reconcile write no second row), body:

```
{ "schema": "t3-thread-nudge/v1", "thread_id": "<route thread_id>",
  "text": "<message>", "reason": "owner-escalation", "request_id": "<card_id>" }
```

`text` is ASCII, at most 1500 characters, has no at-sign, names the WO, the
PR URL when present, the blocker and the next action, and ends with:

> You own this as your own developer work. If you need more capability,
> escalate to a stronger model or subagent yourself instead of waiting or
> escalating to XO or John.

The 1500-character cap applies to the whole text: the blocker line gets the
budget the other lines leave, so the fixed last line is never cut.

If the Dispatch content guard rejects the owner body, no owner row is written,
`overseer.owner_routing.owner_row_content_rejected` is logged, and the
builder monitor gets `needs_owner` with `owner_row_rejected for owner <handle>`
in the detail. Because the owner text is built from the same fields as the run
report, a rejected owner body normally means the run report itself was
rejected too (`dispatch_content_rejected`, unchanged behavior). The consumer is the T3 relay from bdc-xo PR #4979
(`scripts/t3-relay/relay.py`), which claims `t3-thread-nudge/v1` rows and posts
`text` into `thread_id`.

## Retry safety

The card id is the source-event identity. If a retry of the same event resolves
differently (a label changed in between), `runEscalation` returns the existing
card instead of throwing `operator_card_digest_conflict`: the first resolution
wins (logged as `overseer.owner_routing.digest_conflict_first_resolution_kept`).
This applies only in `shadow` and `on`.

## How to turn it on

Prerequisites: bdc-xo PR #4979 merged and its relay installed on the T3
desktop; owners recorded on WO issues with an `owner:<handle>` label plus a
provenance comment; one route per owner thread.

1. Rebuild `archon-app-1` from the merged `dev` and confirm the code is live:
   `docker exec archon-app-1 grep -c resolveWorkOwner /app/packages/overseer/src/owner-resolution.ts`
   (expect at least 1).
2. Set `OVERSEER_OWNER_ROUTING=shadow` and restart. Cards gain
   `owner_assignment`; routing is unchanged. Check what owners resolve to:
   `select card_id, wo_id, json_extract(payload, '$.owner_assignment') from overseer_operator_cards order by created_at desc limit 20;`
3. Set `OVERSEER_OWNER_ROUTES_JSON` and `OVERSEER_OWNER_ROUTING=on`, restart.
4. Count rows since the enable time:

```
select
  (select count(*) from overseer_operator_cards
     where responsible_actor = 'acting-xo' and created_at > '<enable time>') as xo_default_cards,
  (select count(*) from overseer_operator_cards
     where responsible_actor <> 'acting-xo' and created_at > '<enable time>') as owner_or_unowned_cards,
  (select count(*) from agent_dispatch_messages
     where recipient = 't3-desk-local' and idempotency_key like '%:owner'
       and status = 'done' and created_at > '<enable time>') as owner_delivered;
```

To turn it off, set `OVERSEER_OWNER_ROUTING=off` (or unset it) and restart.
Cards already created keep the actor they were created with.
