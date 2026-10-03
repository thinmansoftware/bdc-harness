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
# Bounded supervised Codex-only dispatch

`--entry codex --codex-only` selects the existing
`bdc-feature-development-codex-only` workflow for one supervised attempt. The
PowerShell wrapper accepts `-Workflow codex -CodexOnly` (or the existing Codex
workflow alias). The option does not rebind the global ladder. Omitted/false
requests retain their existing request identity and escalation behavior.

Before live admission, two authenticated reads resolve the unique target
codebase and its absolute `default_cwd`, then read the registered workflow in
that cwd. One 10000ms deadline covers headers and bodies. The root provider and
effective node providers must be exactly Codex; declared availability/quota
failover to another provider is rejected. Malformed, absent or unavailable
registration throws a sanitized pre-admission classification (CLI exit 1),
without a cascade record or provider fire. The wrapper requires the exact
`codex-only-v1` capability before calling the deployed conductor.

Admitted records persist `request.codexOnly: true` and the actual workflow name.
Gate failure or progress timeout stops `blocked` (exit 2), with zero climbs and
a provider boundary bound to the failed attempt's event identity. Timeout
cancellation records acknowledgement or failure; acknowledgement does not
prove the run stopped. No frontier approval packet or successor attempt is
created. Existing success, infrastructure, external cancellation and
already-satisfied outcomes keep their status/exit semantics. Dry-run/WhatIf
reports the bounded variant and makes no remote call.

Source tests and independent source review do not activate this route. An
isolated supervised staging canary must prove deployed SHA, source authority,
provider binding and an owned implementation iteration. Production activation
requires its own board motion and John's current environment/commit-scoped
authorization. Existing repair targets and ownership gates remain binding.
