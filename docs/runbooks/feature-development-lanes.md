# Feature-Development Lanes Runbook

WO: WO-HARNESS-LANES-MODERNIZE-AND-HAIKU-01
Last modernized: 2026-10-14 (GPT-6 on Codex, Claude 5.5 on Claude, Grok 4.7 on Cursor; new Haiku canary lane).

This runbook lists every `bdc-feature-development*.yaml` lane under
`.archon/workflows/defaults/`, its builder and reviewer models, a cost class,
and when to use it. The roster below records each build and review seat. The
Haiku canary requires cross-family Codex review. This is not universal across
lanes: codex-only intentionally uses gpt-6-astra for every seat; Codex builds
and gpt-5.6-terra reviews share the GPT family; default Claude and Fable lanes
have same-family validator seats alongside Codex diff review. Separate seats
do not establish independent reviewer qualification or runtime acceptance.

Cost classes: `cheap`, `standard`, `premium`, `open-model`.

## Lane roster

| Lane | Builder model(s) | Reviewer / judge model(s) | Cost class | When to use |
|------|------------------|---------------------------|-----------|-------------|
| bdc-feature-development | claude-sonnet-5-5 (root/build; planning + repair seats governed by shared Claude personas) | claude-sonnet-5-5 (war-council-validator) + gpt-6-astra via codex-native-strict (diff-review/diff-review-final/opus-rereview/apply-diff-review-final) | standard | Default Claude lane for routine feature work. |
| bdc-feature-development-astra | gpt-6-astra via codex-native-strict | claude-fable-5 (independent Fable review) | premium | Apex Astra build / Fable review variant; explicit invocation only. |
| bdc-feature-development-codex | gpt-6-astra via codex-native-strict | gpt-5.6-terra (documented exception, see below) | standard | Codex build lane when the Codex subscription is preferred. |
| bdc-feature-development-codex-only | gpt-6-astra via codex-native-strict (all seats) | gpt-6-astra via codex-native-strict | standard | Claude-out / Codex-in: use when Claude quota is exhausted but Codex remains. |
| bdc-feature-development-cursor | grok-4.7-high (grok-4.7-medium on check-already-satisfied) | gpt-6-astra via codex-native-strict | standard | Grok builds on the Cursor rail; cross-family Codex judge. |
| bdc-feature-development-fable | claude-fable-5 | claude-fable-5 (war-council-validator) + gpt-6-astra via codex-native-strict (diff seats) | premium | Fable build/review lane; explicit invocation only. |
| bdc-feature-development-grok | grok-4.7-high (grok-4.7-medium on check-already-satisfied) | deepseek/deepseek-v4-pro-0813 (plan-review/validator) + gpt-6-astra via codex-opr (diff seats) | open-model | Dedicated Grok lane; repository-capable non-Grok judges. |
| bdc-feature-development-haiku | claude-haiku-5-5 (plan on claude-opus-5-5; build-manifest + decide-push-target on claude-sonnet-5-5) | gpt-6-astra via codex-native-strict (all review/validation seats) | cheap | Haiku canary: cheap Claude builder, strong cross-family judge. Shadow/canary only (see owner ruling below). |
| bdc-feature-development-fusion-cx-kimi | Kimi K3 (builder seats) | deepseek/deepseek-v4-pro-0813 (OpenRouter) + claude-sonnet-5-5 (apply-diff-review-final) | open-model | Kimi canary; dispatchable, not ladder-wired. |
| bdc-feature-development-fusion-cx-qwen | Qwen (builder seats) | deepseek/deepseek-v4-pro-0813 (OpenRouter) + claude-sonnet-5-5 (apply-diff-review-final) | open-model | Qwen fusion canary; dispatchable, not ladder-wired. |
| bdc-feature-development-kimi-k3 | Kimi K3 (builder seats) | deepseek/deepseek-v4-pro-0813 (OpenRouter) + claude-sonnet-5-5 (apply-diff-review-final) | open-model | Kimi K3 canary; dispatchable, not ladder-wired. |
| bdc-feature-development-zero | Qwen (plan) + grok-4.7-high (build/repair) | grok-4.7-high (plan-review) + deepseek/deepseek-v4-pro-0813 (independent review) | open-model | Claude-free dual-cap recovery roster. |
| bdc-feature-development-zero-open | Qwen (plan) + grok-4.7-high (build/repair) | grok-4.7-high (plan-review) + deepseek/deepseek-v4-pro-0813 (independent review) | open-model | Claude-free open-model recovery roster. |
| bdc-feature-development-zero-claude | grok/Cursor + codex-opr seats (gpt-6-astra on apply-diff-review-final) | codex-opr DeepSeek judges + gpt-6-astra on apply-diff-review-final | open-model | Claude-free lane routed through the OpenRouter tool loop. |

Notes:
- The `-zero`, `-zero-open`, and the OpenRouter Kimi/Qwen lanes are out of scope for
  this modernization beyond the named single `gpt-5.6-sol`/`sonnet` nodes; their
  open-model ids (Kimi, Qwen, DeepSeek) are unchanged.
- In Claude lanes, planning/repair nodes that carry a shared Claude persona
  (e.g. `war-council-architect`, `major-build`) take their effective model from the
  persona front matter; node-level `model:` values were modernized to the spec'd
  Claude ids for alias elimination. Modernizing persona front matter is out of scope.
- The haiku lane's Claude build decision seats (check-already-satisfied, plan,
  apply-suggested-fix, decide-push-target) are intentionally persona-free so the
  node-level Claude model id is authoritative (no existing persona pins
  claude-haiku-5-5 / claude-sonnet-5-5 / claude-opus-5-5, and a model-free Codex
  persona would be rejected on provider claude). The gpt-6-astra review seats reuse
  the model-free Codex personas (war-council-architect-opr, captain-ci-validator-codex,
  codex-adversarial-reviewer, xo-opr).

## gpt-5.6-terra exception (still stands as of 2026-10-14)

The reviewer seats in `bdc-feature-development-codex.yaml` remain on
`gpt-5.6-terra`. No cheaper GPT-6 id is verified on the live Codex runtime:
`gpt-6-astra` is the ONLY GPT-6 id in `codex debug models` output, and
`gpt-6-luna` appears in Codex rollout notes but is NOT in the runtime's list.
If a builder verifies `gpt-6-luna` live (with the evidence command below) the
exception disappears and those seats move to `gpt-6-luna`.

## Intended Dynamic Lane order (tier wiring is a SEPARATE WO)

Per owner routing ruling (John Ranson 2026-10-14) and the Codex haiku rollout
(2026-09-25 `open_model_matrix_haiku_luna_decision_routing`), the intended
Dynamic Lane order is:

1. Haiku subscription (claude-haiku-5-5 build via the haiku lane)
2. GPT-6 Luna subscription
3. Haiku API
4. wait

The tier/router wiring (router-dispatcher.ts, Taskmaster lane selection) is a
SEPARATE WO and is NOT changed here. The Haiku API fallback (step 3) must NOT be
enabled until the Anthropic API balance, expiry, and spend cap are verified
first. The Haiku lane is a shadow/canary pilot only: if Haiku fails the canary it
stays registered but is NOT promoted for routine autonomous use. Strong
cross-family review seats and a canary are mandatory on this lane (synthetic
screening supports a small shadow pilot and test-backed small builds only; it
does NOT qualify Haiku for autonomous repository work or sole-judge authority).

## Verified-ids evidence commands (re-run and record output in the PR)

- Codex provider list (codex-cli 0.153.3):
  `ssh hetzner-prod "docker exec -u appuser archon-app-1 /app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex debug models"`
  Expected: `gpt-6-astra` present (the only verified GPT-6 id); `gpt-6-luna` and
  `gpt-6.1-sol` are NOT in this runtime's list (unverified).
- Cursor model list:
  `ssh hetzner-prod "docker exec archon-app-1 cursor-agent --list-models"`
  Expected: grok-4.7-low/-medium/-high/-xhigh present; no haiku model listed.
- Claude provider one-token resolution (through the harness claude provider path,
  NOT the bare SDK binary which does not exist in the container): prove
  `claude-haiku-5-5`, `claude-sonnet-5-5`, and `claude-opus-5-5` each resolve with
  a single-token call. If sandbox network/API access is unavailable to the
  builder, this is recorded as UNVERIFIED-IN-BUILDER and must be confirmed by XO
  post-merge before the lane is promoted.

## Post-merge activation (XO)

XO performs hot-register after merge (workflows are served from the source clone):
`sync-workflows.sh --hot`, then verify the shadow file and the Stop 7 / Stop 8
canary. No container rebuild or hot-register is done by the build.
