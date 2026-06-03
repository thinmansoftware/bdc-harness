/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 Scenario 4 (consequence text) — LucilleHint.
 *
 * Asserts the consequence sentence the operator sees in the inline approval
 * gate. Tests the pure helper exported from the component module — the
 * package test runner only crawls src/lib/, so we test logic, not React.
 */
import { describe, expect, it } from 'bun:test';
import { buildLucilleText } from '@/components/workflows/LucilleHint';

describe('buildLucilleText', () => {
  it('shows "reject -> halts run" when no on_reject is configured', () => {
    const { approveText, rejectText } = buildLucilleText({
      message: 'gate',
    });
    expect(approveText).toBe('approve -> resumes');
    expect(rejectText).toBe('reject -> halts run');
  });

  it('shows the explicit max_attempts when on_reject.max_attempts is set', () => {
    const { rejectText } = buildLucilleText({
      message: 'gate',
      on_reject: { prompt: 'try again', max_attempts: 2 },
    });
    expect(rejectText).toBe('reject -> re-drafts (up to 2) then cancels');
  });

  it('shows the unbounded variant when on_reject has no max_attempts', () => {
    const { rejectText } = buildLucilleText({
      message: 'gate',
      on_reject: { prompt: 'try again' },
    });
    expect(rejectText).toBe('reject -> re-drafts then cancels');
  });

  it('treats undefined / null approval as "halts" (no gate -> no loop)', () => {
    expect(buildLucilleText(undefined).rejectText).toBe('reject -> halts run');
    expect(buildLucilleText(null).rejectText).toBe('reject -> halts run');
  });
});
