# Duty Officer judge

The Duty Officer judge classifies one dispatch message as `escalate_xo`, `nudge`, or `hold`.
Deploying this code alone does not move the judge. The default route stays OpenRouter, then xAI, until an operator sets the Claude opt-in.

## Provider selection

`DUTY_OFFICER_JUDGE_PROVIDER` is read at judgment time.

| Value | Route |
| --- | --- |
| unset, empty, or `openrouter` | OpenRouter, then xAI |
| `claude` | Claude subscription, then OpenRouter only |
| any other non-empty value | warning, then the default OpenRouter-then-xAI ladder |

Only the exact value `claude` opts in. The judge still returns `unconfigured` / `judge_disabled` unless `DUTY_OFFICER_JUDGE_ENABLED=true`.

`DUTY_OFFICER_CLAUDE_MODEL` selects the Claude model. The code default is `claude-haiku-5-5`. The judge forwards the string as written and does not validate or rewrite it.

## Claude path and fallback

The Claude route calls the existing Claude subscription provider with the same system prompt used by the other rungs. A closed Claude throttle is a rung failure. The judge does not wait for the throttle to open.

If Claude throws or its output fails parsing, including the forbidden-verb guard, the judge falls back through `openRouterKey()` (`OPENROUTER_API_KEY` or `GLM_API_KEY`) only. xAI is not part of the Claude path. When that key is absent, the judge returns `status: failed`, `reason: duty_officer_judge_outage`, records the failures, and does not invent an `ok` verdict.

The forbidden-verb guard runs on every provider path. A reason or body that asks to spend, send, or deploy is rejected on Claude the same way it is rejected on OpenRouter.

Each successful judgment logs `duty_officer_judge_ok` with `provider`, `model`, and `transport`.

## Replay

```bash
bun scripts/dispatch/do-judge-replay.ts --fixture <path> --out <path>
```

The fixture is a JSON array. Each record has `id`, `recordedAction` (`escalate_xo`, `nudge`, `hold`, or `failed`), and `input` (the dispatch message). The report JSON has `total`, `agreementCount`, and `rows` (`id`, `oldVerdict`, `newVerdict`, `agree`).

Replay is fixture-in/report-out. It does not post mail and does not post to GitHub. Before judging, the CLI sets `DUTY_OFFICER_JUDGE_PROVIDER=claude` and `DUTY_OFFICER_JUDGE_ENABLED=true`, and deletes `OPENROUTER_API_KEY`, `GLM_API_KEY`, and `XAI_API_KEY`, so the replay cannot call OpenRouter. A bad fixture or a failed report write exits nonzero and does not invent verdicts.

Exporting the last 50 real inputs and posting the accepted comparison are operator tasks outside this change.

## Production switch

This change does not modify production configuration.

After the replay report is accepted, set `DUTY_OFFICER_JUDGE_PROVIDER=claude` only in the `archon-app-1` environment and recreate the container through the M-181 path. Rollback is unsetting `DUTY_OFFICER_JUDGE_PROVIDER`.

## Known gap

A failed judge is still mechanically escalated by the existing Duty Officer clock.
