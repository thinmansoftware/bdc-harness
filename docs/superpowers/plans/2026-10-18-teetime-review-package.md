# Tee-time implementation-review package plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline, task-by-task.

**Goal:** Assemble a complete implementation-review package candidate from explicit controller observations, with no execution or approval authority.

**Architecture:** Reuse frozen RunAuthority and policy contracts, existing ReviewBinding and required-check validation, and the qualified final wire validator. Keep state loading, Git custody and SDK serializer provenance outside this pure helper.

**Tech Stack:** TypeScript, Bun tests, existing workflow/provider modules.

**Spec:** BDC_XO docs/behavior-specs/tee-time-admission-contract-draft.md, Amendment A. Independent architect pre-build review approved this source-only slice with identity, encoding, immutability and custody corrections.

## Global Constraints

- No Claude/Fable, credentials, model calls, policy activation, publication or deployment.
- No synthetic APPROVED envelope to reuse a validator.
- Final wire remains at most6000 bytes, with no truncation or alternate serialization.
- Plan approval remains separate from implementation review.
- Controller complete/binary flags do not prove Git custody or head existence.

## Review Focus

- Every run/codebase/workflow/policy/base/head/tree/manifest mismatch rejects.
- Spec bytes must decode exactly as UTF-8 and match the authority digest.
- Failed, skipped, truncated, missing or altered test receipts reject before serialization.
- Serializer callback must synchronously return the exact package in a valid request.
- Returned binding cannot be changed through caller-owned object references.

## Task1: Pure assembler and shared test validation

Files: create packages/workflows/src/reliability/tee-time-review-package.ts and adjacent test; extract pure required-check validation from packages/providers/src/community/pi/restricted-review-evidence.ts without behavior changes; extend existing offline CI and staging runbook.

Interface: assembleTeeTimeReviewPackage(input) consumes actual loaded RunAuthorityRecord, run identity/persisted policy, reviewed workflow, expected run policy, exact spec bytes, ReviewBinding, explicit controller Git observation, requiredChecks and TrustedCheck records, and a synchronous serialized-request callback. Returns frozen binding, packageText/packageHash, final wire body/bytes/schema hash only.

- [x] Write adversarial fixture tests for each review focus; run and observe missing-module RED.
- [x] Extract validateTrustedReviewChecks without changing existing validator behavior; reuse in assembler.
- [x] Implement exact authority/spec/policy/source checks, package construction and final wire verification; no IO/store/Git/provider execution.
- [x] Run new tests, existing review evidence tests, workflow/provider typechecks and relevant formatting/ASCII checks.
- [ ] Obtain independent source review, then publish source/CI within existing bootstrap scope. No runtime authority follows.

## Remaining adapter obligations

The future controller must load authenticated current records and a separately approved plan; establish complete trusted base/Git/head/tree/diff custody; independently observe actual test commands/results; and prove the callback is the installed SDK serialization. This helper's accepted candidate establishes none of those provenance facts. Reviewer execution, atomic approval consumption and coordinated policy/workflow adoption remain separate.

Verification:17 tests/116 assertions pass, including existing review-evidence and actual installed-SDK request regression. Workflow/provider typechecks, production-file ESLint, Prettier, ASCII and diff checks pass. Independent final source review approved publication/CI. Exact-source CI remains pending; no runtime or admission permission follows.
