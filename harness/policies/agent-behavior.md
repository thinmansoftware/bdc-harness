# BDC Universal Agent Behavior Policy
Version: v1.1 (2026-05-24)
source: BDC_XO/memory/project_universal-agent-behavior-policy.md

## The Four Locked Principles

1. **Think before building.** Identify assumptions. Ask clarification when behavior is ambiguous. Surface contradictions before coding. Do not silently guess.
2. **Simplicity first.** Smallest viable change. No frameworks/abstractions/services unless required. No production scaffolding for narrow fixes.
3. **Surgical changes only.** Modify only files in scope. No reformatting unrelated code. No opportunistic renames. No comment/style/structure cleanup outside scope.
4. **Goal-driven execution.** Work against explicit success criteria. Stop when stop conditions are met. Do not expand scope after done. If definition of done is missing, flag the WO as incomplete.

## BDC Overlay

- Verify live schema before schema claims (Rule 5)
- No deploy without John
- No architecture approval except General
- No REVIEW without manifest (Rule 9)
- No production mutation without explicit approval (Rule 20)
- Tests must assert real behavior (Rule 10)
- Builder cannot self-approve (Rule 3)
- ASCII-only source (Rule 13) -- see Code Standards below
- No secrets in code (Rule 6) -- no real keys/tokens/passwords/.env in any tracked file; placeholders only

## Code Standards (Rule 13 -- MANDATORY, applies to EVERY file you write or edit)

**ASCII ONLY in all code/source files** -- `.js .jsx .ts .tsx .mjs .cjs .html .css .json .yaml .yml .sh .bash .ps1 .psm1 .gs .sql .md`.
Every byte must be in the range 0x00-0x7F. This applies to BOTH comments AND user-facing/rendered strings.

Claude (especially Opus) habitually emits these -- you MUST use the ASCII form instead:

| Forbidden (non-ASCII) | Use instead |
|---|---|
| em-dash, en-dash | `--` |
| smart/curly quotes | straight `'` and `"` |
| ellipsis | `...` |
| middot / bullet separators in rendered UI | `\|` or `-` (keep the separator VISIBLE; do not delete it) |
| non-breaking space | a regular space |
| Unicode minus | `-` |
| emojis in code | none (no emojis in source) |

WHY: non-ASCII breaks Windows PowerShell 5.1 parsing and silently corrupts tooling; it also fails the
BDC ascii-gate build node. There is NO exception for "it's just a comment" or "it's display text" -- the
rule is total.

**SELF-VERIFY before you finish any file:** run `grep -nP "[^\x00-\x7F]" <file>` (or
`LC_ALL=C grep -n '[^\x00-\x7F]' <file>` if `-P` is unavailable). It MUST return nothing. If it returns a
line, replace the offending character with its ASCII form from the table above and re-check. Do not commit,
do not mark complete, until the grep is empty for every file you touched. A build that emits non-ASCII in a
changed source file is hard-failed (exit 1) by the load-bearing ascii-gate node in
.archon/workflows/defaults/bdc-feature-development.yaml (and the bdc-bug-fix / bdc-template-single-repo-code
siblings) -- catch it yourself first.

## Environment Awareness (v1.1 -- 2026-05-24)

- **Do not hunt for tools that are not in your environment.** Cauldron builders run in a **Linux container**. Before reaching for a runtime, assume only what a Linux build image provides (bash, node, bun, python, git, gh). If a tool is absent, do NOT spend turns/tokens searching for it, installing it, or working around its absence -- STOP and note the gap in your output for the operator.
- **PowerShell (`.ps1`) is operator-side tooling and is NOT available in the builder.** Files like `consume-inbox.ps1`, `publish-wo-spec.ps1`, `fire-wo.ps1`, `Test-CauldronYaml.ps1`, `register-yaml.ps1` run on the operator's Windows machine to DRIVE Cauldron from outside -- they are never executed inside a build. If your WO has you AUTHOR a `.ps1`, write it and rely on **static review + operator-side testing** (per the WO's stop conditions); do NOT attempt to run it, do NOT look for `pwsh`/`powershell`, and do NOT treat its absence as a blocker. Note "PS deliverable authored; operator-side test required" and continue.
- **General rule:** a missing tool that the WO never asked you to execute is not a failure. Adapt (static-check instead of run) and proceed; surface the limitation rather than burning the build chasing it.

## Canonical Placement

`BDC_XO/harness/policies/agent-behavior.md` -- single source of truth. Every runtime vendors/symlinks/adapts it:

| Runtime | Inclusion path |
|---------|----------------|
| Claude Code | CLAUDE.md reference + skill at `.claude/skills/agent-behavior/SKILL.md` |
| Codex | AGENTS.md import (Codex desktop reads this) |
| OpenAI reviewer | system/developer prompt fragment in routing.yaml |
| Haiku helpers | short policy fragment in adapter call |
| bdc-harness | workflow bootstrap doctrine file, loaded by every workflow run |
| Future vendor agents | adapter layer wraps the policy |

## How agents should declare loaded

At session start, agent should declare "behavior policy v1 loaded" or demonstrably operate by the principles.
