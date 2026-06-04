/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01: ReplayNode -- the "resume from failed"
 * affordance attached to a failed node's peek panel.
 *
 * v1 SCOPE (FLAG-1 in approved plan): the engine's existing
 * /api/workflows/runs/:runId/resume endpoint re-runs from failed nodes,
 * skipping completed ones. We expose THAT endpoint here. The spec's "replay
 * with alt model" variant is honest fast-follow work -- it requires a
 * server-side per-node model-override endpoint that does not exist yet.
 * Rather than fake it with a button that does nothing, we omit it
 * (anti-pattern: "kill the brain not the body" applies to the build too).
 *
 * Mounted by NodePeekPanel when the run status is 'failed'.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlayCircle } from 'lucide-react';

import { resumeWorkflowRun } from '@/lib/api';

interface ReplayNodeProps {
  runId: string;
  /** Optional: force-disable the button (e.g. parent knows the run is not
   *  in a resumable state). */
  disabled?: boolean;
}

export function ReplayNode({ runId, disabled }: ReplayNodeProps): React.ReactElement {
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // alt-model replay: fast-follow (requires server-side model override endpoint).
  const resumeMutation = useMutation({
    mutationFn: () => resumeWorkflowRun(runId),
    onSuccess: async () => {
      setErrorMessage(null);
      await queryClient.invalidateQueries({ queryKey: ['workflowRun', runId] });
    },
    onError: (err: unknown) => {
      setErrorMessage(err instanceof Error ? err.message : 'Resume failed');
    },
  });

  return (
    <section className="px-3 py-2 border-b border-border" data-testid="replay-node">
      <h3 className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Replay</h3>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={(): void => {
            resumeMutation.mutate();
          }}
          disabled={disabled || resumeMutation.isPending || runId.length === 0}
          className="flex items-center gap-1 rounded-md border border-accent/30 px-2 py-1 text-xs text-accent hover:bg-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="replay-resume-button"
        >
          <PlayCircle className="h-3.5 w-3.5" />
          {resumeMutation.isPending ? 'Resuming...' : 'Resume from failed'}
        </button>
      </div>
      <p className="mt-1 text-[10px] text-text-tertiary">
        Re-runs the workflow from the failed nodes, skipping completed ones.
      </p>
      {errorMessage !== null && <p className="mt-1 text-[10px] text-error">{errorMessage}</p>}
    </section>
  );
}
