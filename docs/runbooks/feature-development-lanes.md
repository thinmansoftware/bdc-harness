# Feature development lanes

Use the lane that matches the desired build rail and review strength. Haiku remains canary-only until XO's post-merge canary succeeds.

| Lane filename | Builder model/provider | Reviewer model/provider | Cost class | Intended use |
| --- | --- | --- | --- | --- |
| bdc-feature-development-astra.yaml | gpt-6-astra / codex-native-strict | claude-fable-5 / claude | premium | Apex GPT-6 build with Fable cross-review. |
| bdc-feature-development-codex-only.yaml | gpt-6-astra / codex-native-strict | gpt-6-astra / codex-native-strict | premium | Claude-independent Codex execution. |
| bdc-feature-development-codex.yaml | gpt-6-astra / codex-native-strict | gpt-5.6-terra / codex | standard | GPT-6 build with the verified cheaper Terra review exception. |
| bdc-feature-development-cursor.yaml | grok-4.7-high / cursor | gpt-6-astra / codex-native-strict | standard | Grok build with GPT-6 cross-family review. |
| bdc-feature-development-fable.yaml | claude-fable-5 / claude | gpt-6-astra / codex-native-strict | premium | Fable build with GPT-6 cross-review. |
| bdc-feature-development-fusion-cx-kimi.yaml | moonshotai/kimi-k2.7-code / openrouter | deepseek-v4 / codex-opr | open-model | Kimi fusion canary and recovery work. |
| bdc-feature-development-fusion-cx-qwen.yaml | qwen3-coder-next / openrouter | deepseek-v4 / codex-opr | open-model | Qwen fusion canary and recovery work. |
| bdc-feature-development-grok.yaml | grok-4.7-high / cursor | deepseek-v4 and gpt-6-astra / codex-opr and codex-native-strict | standard | Grok build with mixed independent review. |
| bdc-feature-development-haiku.yaml | claude-haiku-5-5 / claude | gpt-6-astra / codex-native-strict | cheap | Small, test-backed canary builds with strong cross-family judges. |
| bdc-feature-development-kimi-k3.yaml | moonshotai/kimi-k3 / openrouter | deepseek-v4 / codex-opr | open-model | Kimi K3 canary work. |
| bdc-feature-development-zero-claude.yaml | qwen3-coder-next / openrouter | deepseek-v4 and gpt-6-astra / codex-opr and codex-native-strict | open-model | Open-model build with one GPT-6 final application seat. |
| bdc-feature-development-zero-open.yaml | qwen3-coder-next / opr-zero | deepseek-v4 / codex-opr | open-model | Claude-free recovery lane. |
| bdc-feature-development-zero.yaml | qwen3-coder-next / glm | deepseek-v4 / codex-opr | open-model | Zero-cost recovery lane. |
| bdc-feature-development.yaml | claude-sonnet-5-5 / claude | gpt-6-astra / codex-native-strict | standard | Routine Claude build with GPT-6 review. |

## Dynamic lane intent

The intended order is Haiku subscription -> GPT-6 Luna subscription -> Haiku API -> wait. Tier wiring and Taskmaster selection are a separate work order and are not changed here. Before enabling the Haiku API fallback, verify the Anthropic API balance, expiry, and cap. Synthetic evidence does not qualify Haiku for autonomous repository work or sole-judge authority.

## Runtime inventory and exception

Rerun these commands before promotion:

```bash
ssh hetzner-prod "docker exec -u appuser archon-app-1 /app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex debug models"
ssh hetzner-prod "docker exec archon-app-1 cursor-agent --list-models"
```

Use the harness Claude provider path for one-token resolution calls for `claude-haiku-5-5`, `claude-sonnet-5-5`, and `claude-opus-5-5`; do not use the nonexistent bare SDK binary path.

The fresh builder attempt could not resolve the `hetzner-prod` SSH host, so it did not prove GPT-6 Luna. Consequently, `bdc-feature-development-codex.yaml` retains `gpt-5.6-terra` on exactly these reviewer seats: `plan-review`, `war-council-validator`, `diff-review`, `diff-review-final`, `opus-rereview`, `findings-consolidate`, and `apply-diff-review-final`. XO must rerun the inventory and Claude resolution checks from an operator environment and include raw or sanitized evidence in the PR before promotion.
