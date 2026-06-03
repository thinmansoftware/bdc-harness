/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — KillButton.
 *
 * The "headshot" affordance: a direct /cancel from the graph, distinct from
 * the reject-loop. The 2026-06-02 anchor — reject LOOPED the zombie, /cancel
 * was the actual kill move — proved we need a one-click escape that bypasses
 * the on_reject retry chain entirely.
 *
 * The pure handler is exported so the test suite (src/lib/ only) can
 * exercise it without rendering React.
 */

import { useState } from 'react';
import { XCircle } from 'lucide-react';
import { cancelWorkflowRun } from '@/lib/api';

/**
 * Pure handler — calls the injected cancel function with the given runId.
 * Exported so kill-run.test.ts (in src/lib/) can verify it without React.
 */
export async function handleKillRun(
  runId: string,
  cancelFn: (id: string) => Promise<unknown>
): Promise<void> {
  await cancelFn(runId);
}

interface KillButtonProps {
  runId: string;
  /** Optional callback after the kill completes, used to refresh queries. */
  onKilled?: () => void;
}

export function KillButton({ runId, onKilled }: KillButtonProps): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onClick = (): void => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    void handleKillRun(runId, cancelWorkflowRun)
      .then(() => {
        if (onKilled) onKilled();
      })
      .catch((e: unknown) => {
        setErr(e instanceof Error ? e.message : 'Kill failed');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-error/90 border border-error/30 hover:bg-error/10 hover:text-error disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        data-testid="kill-button"
        title="Cancel this run immediately (the kill move - bypasses on_reject loop)"
      >
        <XCircle className="h-3.5 w-3.5" />
        {busy ? 'Killing...' : 'Kill run'}
      </button>
      {err !== null && <span className="ml-2 text-[10px] text-error">{err}</span>}
    </>
  );
}
