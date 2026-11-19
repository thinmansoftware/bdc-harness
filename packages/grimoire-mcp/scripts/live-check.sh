#!/usr/bin/env bash
set -u
failed=0
for ref in "$@"; do
  repo="${ref%#*}"; number="${ref##*#}"
  if ! card="$(LOG_LEVEL=fatal bun run packages/grimoire-mcp/src/cli.ts card "$ref" --json)"; then
    echo "LIVE_CARD_FAIL $ref: CLI failed"; failed=1; continue
  fi
  if ! live="$(gh pr view "$number" --repo "$repo" --json headRefOid,state)"; then
    echo "LIVE_CARD_FAIL $ref: gh pr view failed"; failed=1; continue
  fi
  if CARD="$card" LIVE="$live" bun -e 'const c=JSON.parse(process.env.CARD);const l=JSON.parse(process.env.LIVE);if(c.pr.head_sha!==l.headRefOid||c.pr.state!==l.state||!c.blocker_class||!c.next_permitted_action.action)process.exit(1)'; then
    echo "LIVE_CARD_OK $ref"
  else
    echo "LIVE_CARD_FAIL $ref: card differs from live PR or lacks a decision"; failed=1
  fi
done
exit "$failed"
