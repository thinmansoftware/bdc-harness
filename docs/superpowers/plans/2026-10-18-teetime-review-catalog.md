# Tee-time reviewer catalog reduction implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, task-by-task. No runtime activation follows this source slice.

**Goal:** Produce only an immutable capability-reduced catalog from one exact pinned original model entry.

**Architecture:** Preserve the complete CLI0.153.3 bundled gpt-5.6-sol entry as a source-owned ASCII JSON fixture with an exact byte hash. A pure helper accepts only those exact original bytes and applies an allowlisted capability reduction. It creates no provider, filesystem operation, auth transfer, CLI process or registered binding.

**Tech Stack:** TypeScript/Bun and source-owned JSON; existing crypto hashing and test conventions.

**Spec:** XO draft docs/behavior-specs/tee-time-codex-reviewer-contract-draft.md; parent bdc-xo#3332. Pre-design review approved source preparation of a capability reduction, not tool-free execution or capacity.

## Global constraints

- No Claude/Fable, provider/model call, auth access, runtime image or service change.
- No change to existing6000-byte reviewer, builder policy or current admitted identities.
- The only allowed metadata changes are shell_type:"disabled", apply_patch_tool_type:null, tool_mode:"direct", experimental_supported_tools:[], supports_search_tool:false.
- Preserve every other field, including slug, context/max-context/effective-percent, instructions, reasoning and transport selection. No numeric budget is introduced.
- Source Windows metadata is not Linux/account/runtime attestation. Later loopback proof must verify the exact Linux binary, original metadata and actual complete advertised tools.
- Caller data cannot supply a replacement expected hash or field delta. Any changed input bytes fail before JSON parsing/derivation.

## Review focus

- Same-size or duplicate-key/extra-entry input must fail exact original byte identity.
- No model/context/prompt/transport change may hide inside the capability reduction.
- No mutable input or returned object may alter the already-produced serialized catalog.
- A removed apply_patch feature flag is not a tool boundary; metadata reduction alone does not remove MCP/dynamic/implicit tools.
- A successful helper result is source data only, not an effective configuration, no-tools proof or approval receipt.

## Task1: Freeze the original metadata data file

Files: packages/providers/src/codex/restricted-review-model-base.json.
Interface: an ASCII JSON object with exactly one models entry, selected from the existing CLI0.153.3 --bundled output using an isolated empty HOME, no refresh and no account credentials. Retain full original fields, serialize deterministically and record raw SHA-256 in source. Compare fields to the pinned official rust-v0.153.3 source catalog where possible; do not claim binary equivalence from tag name.

- [x] Extract the existing bundled entry, not a fabricated minimal descriptor.
- [x] Verify slug/version, complete field retention, exact byte bound and ASCII; record provenance/hash.

## Task2: Pure transformer and rejection tests

Files: packages/providers/src/codex/restricted-review-catalog.ts and adjacent test.
Interface: deriveRestrictedReviewCatalog(raw:Uint8Array) returns frozen serialized catalog text, original source hash and derived catalog hash; caller cannot select expected identities or deltas. Fixed source-owned hash authenticates this local data artifact, not a provider account.

- [x] Write failing positive and adversarial tests; observe RED before helper code.
- [x] Implement bounded defensive byte copy and exact original hash rejection before parsing.
- [x] Apply only the five listed field changes to a fresh parsed entry; return immutable text/hash metadata.
- [x] Test exact unchanged-field equality, binary mutation, duplicate/extra entry, wrong model/context/instructions, size/type rejection and input/result mutation.
- [x] Run the focused suite, provider/workflow/scripts typechecks, lint/format/ASCII/diff and staged secret scan.

## Task3: Source-only publication

Files: .github/workflows/offline-qualification.yml and existing runbook.

- [x] Add the pure test to existing offline CI; remove no checks.
- [x] Document required effective config controls from pinned source: deferred executor, permission request, image generation, tool suggestion, deferred world state, shell/code modes/view image/token budget/clock/sleep; disabled multi-agent enum; empty MCP/dynamic/extension inventory; explicit user-input/plan controls and unchanged web-search disable.
- [x] Independent architecture source review before publication to existing draft PR1145 and exact-source CI dispatch (CI result recorded separately).

## Later qualification, explicitly excluded

No new adapter or authentication path in this slice. Separately review a no-auth installed-SDK loopback fixture, extending the existing probe-teetime-artifact-fixture-worker.py pattern. It must capture complete effective instructions/tool definitions/request framing, require no executable advertised tool/namespace/extension and prove hostile unadvertised shell/patch/code-mode calls cannot execute or produce an approval. An omitted empty tools field may be legitimate; inspect semantics rather than requiring tools:[].

Trace and qualify compaction detection: pinned source compaction can replace/truncate evidence, and the SDK terminal types do not supply an explicit output/reasoning-token cap. No catalog number alone establishes a safe request budget. Real foundation authority, exact-image proof, finite reviewer-quality qualification and atomic approval consumption remain open.

## Execution ledger

- Task1: complete original fixture extracted; exact source SHA recorded in runbook.
- Provenance: only shared-field difference is two serde-defaulted false token-budget flags present in CLI serialization and absent in source JSON. Architect independently checked the struct. Preserve bytes; no normalization or binary-equivalence claim.
- Task2 RED: focused Bun suite failed because restricted-review-catalog module did not exist (0 pass, 1 error). GREEN after helper: 7 tests, 31 assertions passed.
- Task3: CI invocation and source-only limits documented. Exact-byte JSON is LF-pinned and formatter-excluded; this preserves the reviewed identity across Windows/Linux checkouts.
- Verification: 7 focused tests/31 assertions; existing restricted provider/transport/SDK/factory 21 tests/214 assertions; provider/workflow/scripts typechecks pass. Helper eslint passes; test file is ignored by repository eslint configuration. Prettier, ASCII/hash and diff checks pass. Staged secret scan is required before commit.
- Final independent architecture review: APPROVED for source-only publication to draftPR1145, no blocking findings. No runtime, tool-free, capacity or foundation admission follows.
