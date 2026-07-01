/**
 * types.ts -- Smart Cauldron v1.0 core type definitions.
 *
 * Per-run escalation cascade: fires WOs on cheapest tier first, climbs on gate-fail.
 * WO: WO-HARNESS-SMART-CAULDRON-V1-PER-RUN-CASCADE-01
 */

export type TierName = string; // e.g. "glm", "codex", "claude", "frontier"

export type TierOutcome =
  | 'won' // gate passed -- cascade stops
  | 'gate-failed' // ran, built, gate failed -- climb
  | 'infra-error'; // auth/transport failure -- alert, do not count as "too hard"

export interface LadderTier {
  name: TierName;
  workflowName: string; // e.g. "bdc-feature-development-glm"
  isFrontier: boolean; // true = top rung; gate-fail here = BLOCKED
  costPerRunUsd: number | null; // null = unknown; populated from run metadata post-hoc
}

export interface ConductorRuleset {
  defaultEntry: TierName;
  rules: {
    match: { woClass?: string; tags?: string[] };
    entry: TierName;
  }[];
}

export interface CascadeAttempt {
  tier: TierName;
  workflowName: string;
  runId: string | null;
  outcome: TierOutcome;
  gateFailReason: string | null; // which condition failed (terminal/validator/pr)
  infraErrorReason: string | null; // HTTP status + message on infra-error
  servedModelId: string | null; // from run metadata when available
  costUsd: number | null;
  startedAt: string;
  completedAt: string | null;
}

export type CascadeStatus =
  | 'won' // a tier passed the gate
  | 'blocked' // frontier failed gate or all tiers exhausted
  | 'infra-alert'; // infra-error on a tier (escalate/alert, not climb silently)

export interface CascadeRunRecord {
  cascadeId: string; // randomUUID
  woId: string;
  createdAt: string;
  status: CascadeStatus;
  winningTier: TierName | null;
  attempts: CascadeAttempt[];
  totalCostUsd: number | null;
  telemetry: {
    entryTier: TierName;
    climbed: boolean;
    climbCount: number;
    wonCheap: boolean; // true if entry tier won without climbing
  };
}

export interface GateVerdict {
  pass: boolean;
  reason: string; // human-readable -- which condition failed
  validatorVerdict: 'satisfied' | 'needs_revision' | 'unknown';
  prOpened: boolean;
  prMergeable: boolean | null;
  terminalStatus: string;
}

/**
 * FireResult: runId is null on infra-error or while run discovery is pending.
 * fire.ts resolves runId via by-worker discovery BEFORE returning to the cascade.
 */
export interface FireResult {
  ok: boolean;
  runId: string | null; // resolved via discovery poll; null only on infra-error
  conversationId: string; // the UUID the cascade generated for this attempt
  infraError: string | null; // set when HTTP != 200 or discovery times out
}

export interface PollResult {
  runId: string;
  terminalStatus: 'completed' | 'failed' | 'cancelled';
  validatorVerdict: 'satisfied' | 'needs_revision' | 'unknown';
  prUrl: string | null;
  prMergeable: boolean | null;
  servedModelId: string | null;
  rawMetadata: Record<string, unknown>;
}
