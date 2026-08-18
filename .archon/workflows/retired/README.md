# Retired Cauldron Lanes

This directory holds Cauldron feature-lane workflow YAMLs that have been retired
from the active registry. Files here are NOT served by the runtime (they live
outside `.archon/workflows/defaults/`), so the lanes they define cannot be fired
from any path (dashboard dropdown, Telegram, fire.ps1, API) once the runtime is
rebuilt.

Files are relocated here (via `git mv`), not deleted -- history and re-entry
matter.

## The Ruling (2026-07-06, John)

LANE RULING (John): Cauldron lanes = CLAUDE + CODEX ONLY.

Only two feature lanes remain active in `.archon/workflows/defaults/`:

- `bdc-feature-development` (Claude)
- `bdc-feature-development-codex` (Codex)

All other feature lanes are retired.

## Evidence Basis

Event-store 14-day lane stats (as of 2026-07-06):

- claude: 81/86
- codex: 47/67, and 100% since 7/3
- -zero: 0/19 (lifetime)
- -fusion-cx-glm: 0/21 (lifetime)
- plain -glm: failed its last 2 runs

The retired lanes were unproven or dead by these numbers.

## Retired Lanes

- bdc-feature-development-glm
- bdc-feature-development-zero
- bdc-feature-development-qwen
- bdc-feature-development-open-a
- bdc-feature-development-open-b
- bdc-feature-development-fusion-cx-glm
- bdc-feature-development-fusion-cx-qwen
- bdc-feature-development-fusion-ds-glm
- bdc-feature-development-fusion-qwen-glm

## Earn-the-Seat Re-Entry Path

A retired lane may return only by earning the seat:

deploy qwen3-coder repoint -> re-register ONE canary lane -> 3-WO earn-the-seat
proof -> reinstate.
