/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — LucilleHint.
 *
 * Renders the consequence text for the operator at a paused approval gate.
 * The codename Lucille = "the tool that tells you, and gives you, the real
 * kill move" — by stating what approve / reject / kill actually DO based on
 * the on_reject configuration, the operator never has to guess whether
 * reject will halt or loop again (the 2026-06-02 anchor).
 *
 * Pure display, ASCII-only (no emoji).
 */

import type { DagNode } from '@/lib/api';

type ApprovalConfig = NonNullable<DagNode['approval']>;

export interface LucilleText {
  approveText: string;
  rejectText: string;
}

/**
 * Compute the consequence sentences from an approval config. Exported as a
 * named function so the test in src/lib/ can exercise it without React.
 */
export function buildLucilleText(approval: ApprovalConfig | undefined | null): LucilleText {
  const approveText = 'approve -> resumes';
  if (!approval?.on_reject) {
    return { approveText, rejectText: 'reject -> halts run' };
  }
  const max = approval.on_reject.max_attempts;
  if (typeof max === 'number' && max > 0) {
    return {
      approveText,
      rejectText: `reject -> re-drafts (up to ${String(max)}) then cancels`,
    };
  }
  return {
    approveText,
    rejectText: 'reject -> re-drafts then cancels',
  };
}

interface LucilleHintProps {
  approval: ApprovalConfig | undefined | null;
}

export function LucilleHint({ approval }: LucilleHintProps): React.ReactElement {
  const { approveText, rejectText } = buildLucilleText(approval);
  return (
    <div className="text-[10px] leading-4 text-text-secondary font-mono" data-testid="lucille-hint">
      <div>{approveText}</div>
      <div>{rejectText}</div>
    </div>
  );
}
