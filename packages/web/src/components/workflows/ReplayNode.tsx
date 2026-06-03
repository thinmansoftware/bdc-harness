/**
 * WO-MC-NEGAN-DIAGNOSTIC-GRAPH-01 — ReplayNode.
 *
 * Two actions on a failed node:
 *   - Replay WO         : re-fire the workflow with the original message.
 *   - Replay alt model  : same, but prepend a [model:<name>] marker so a
 *                         downstream override can route differently.
 *
 * v1: re-fires the parent WO; per-node replay is flagged as a fast-follow
 * (see lib/replay-dispatch.ts).
 */

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { runWorkflow } from '@/lib/api';
import { buildReplayRequest } from '@/lib/replay-dispatch';

interface ReplayNodeProps {
  workflowName: string;
  parentConversationId: string | null;
  originalMessage: string;
}

export function ReplayNode({
  workflowName,
  parentConversationId,
  originalMessage,
}: ReplayNodeProps): React.ReactElement {
  const [busy, setBusy] = useState<null | 'wo' | 'alt'>(null);
  const [showAlt, setShowAlt] = useState(false);
  const [altModel, setAltModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const disabled = parentConversationId === null;

  const fire = async (mode: 'wo' | 'alt'): Promise<void> => {
    if (parentConversationId === null) return;
    setBusy(mode);
    setError(null);
    try {
      const req = buildReplayRequest(
        workflowName,
        originalMessage,
        mode === 'alt' ? altModel : undefined
      );
      // Forward both the (marker-prefixed) message AND the structured
      // `model` field. Earlier revisions only sent the message, which
      // meant the alt-model override was silently dropped on the wire
      // (the marker is opaque to the orchestrator until it grows a
      // parser for it). Sending `req.model` honors the operator's
      // selection and lets server-side handlers consume it once they
      // grow that support.
      await runWorkflow(workflowName, parentConversationId, req.message, req.model);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Replay failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="replay-node">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={(): void => {
            void fire('wo');
          }}
          disabled={disabled || busy !== null}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent border border-accent/30 hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          data-testid="replay-wo"
          title={disabled ? 'No parent conversation - cannot replay' : 'Re-fire this workflow'}
        >
          <RefreshCw className="h-3 w-3" />
          {busy === 'wo' ? 'Replaying...' : 'Replay WO'}
        </button>
        <button
          type="button"
          onClick={(): void => {
            setShowAlt(prev => !prev);
          }}
          disabled={disabled || busy !== null}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary border border-border hover:bg-surface-elevated disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          data-testid="replay-alt-toggle"
        >
          Replay with alt model
        </button>
      </div>
      {showAlt && (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={altModel}
            onChange={(e): void => {
              setAltModel(e.target.value);
            }}
            placeholder="model (e.g. gpt-5.5)"
            className="flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs font-mono text-text-primary"
            data-testid="replay-alt-model-input"
          />
          <button
            type="button"
            onClick={(): void => {
              void fire('alt');
            }}
            disabled={disabled || busy !== null || altModel.trim() === ''}
            className="rounded-md px-2 py-1 text-xs text-accent border border-accent/30 hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            data-testid="replay-alt-fire"
          >
            {busy === 'alt' ? 'Replaying...' : 'Fire'}
          </button>
        </div>
      )}
      <p className="text-[10px] text-text-tertiary italic">
        {/* TODO: per-node replay - fast-follow: engine node-level replay not yet supported. */}
        v1: re-fires the WO. Per-node replay is a fast-follow.
      </p>
      {error !== null && <span className="text-[10px] text-error">{error}</span>}
    </div>
  );
}
