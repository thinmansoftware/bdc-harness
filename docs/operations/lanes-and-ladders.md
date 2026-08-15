# Smart Cauldron lanes and ladders

## Canonical ladder

`zero -> qwen -> codex -> claude -> frontier`

## Canonical ladder SOR

`packages/smart-cauldron/config/ladder.config.json`

Conductor fires load this file via `loadLadder()` / `loadRefusedTiers()`. Do not
hardcode tier order or workflow bindings in orchestrator source.

## Conductor ruleset

`packages/smart-cauldron/config/ruleset.config.json`

Rules evaluate top-down; first match wins. Notable live routes:

- mechanical `CODE` -> `zero`
- money/auth tags and `INFRA` -> `claude`
- generic `CODE` / default -> `codex`

CLI `--entry` overrides the ruleset pick, but cannot select a refused or unknown
tier (cascade hard-refuses before fire).

## Refuse path for dark / retired lanes

1. `refusedTiers` in the ladder SOR (at least `glm`) lists dark lanes.
2. `runCascade` refuses those names as entry (including explicit `--entry`).
3. Root `config/router.yaml` may still list historical engines (e.g. `glm-5.2`)
   for multi-tier vision, but they are annotated retired/refused and are **not**
   wired as live workflow lanes (`DEFAULT_ENGINE_TO_LANE` maps them to null /
   omits them -- fail-closed).

Do not reconnect broken router entries "to try them." Keep the multi-tier vision;
do not make dark lanes live entry points.
