/**
 * Stop-1 co-located entrypoint for the pr-review-evaluator tests
 * (WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01).
 *
 * Canonical suite: ./__tests__/pr-review-evaluator.test.ts. See the sibling
 * merge-execution-bridge.test.ts for why this re-import exists (bun path-filter
 * semantics). Tests 16 and 17 live in the canonical file and run here as import
 * side effects.
 */
import './__tests__/pr-review-evaluator.test.ts';
