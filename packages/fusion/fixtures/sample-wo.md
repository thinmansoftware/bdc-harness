# WO-FUSION-SAMPLE-01

**Priority:** P2
**Builder:** Major Build
**Repo:** bdc-harness

## Objective

Add a new utility function `formatCurrency(amount: number): string` to
packages/core/src/utils/format.ts that formats a number as USD currency.

## Behavior

- Input: numeric amount (e.g. 9.99)
- Output: formatted string (e.g. "$9.99")
- Must handle zero ($0.00) and negative values (-$1.00)
- ASCII-only output

## Stop Conditions

1. `formatCurrency(9.99)` returns `"$9.99"`
2. `formatCurrency(0)` returns `"$0.00"`
3. `formatCurrency(-1.00)` returns `"-$1.00"`
4. Unit tests pass asserting each case

## Files

- Created: `packages/core/src/utils/format.ts`
- Created: `packages/core/src/__tests__/format.test.ts`
