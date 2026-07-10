/**
 * types.ts -- Smart Cauldron v1.0 core type definitions.
 *
 * Per-run escalation cascade: fires WOs on cheapest tier first, climbs on gate-fail.
 * WO: WO-HARNESS-SMART-CAULDRON-V1-PER-RUN-CASCADE-01
 */

export type TierName = string; // e.g. "glm", "codex", "claude", "frontier"

export type TierOutcome =
  | 'running' // attempt intent persisted before the workflow lane is fired
  | 'won' // gate passed -- cascade stops
  | 'gate-failed' // ran, built, gate failed -- climb
  | 'infra-error' // auth/transport failure -- alert, do not count as "too hard"
  | 'progress-timeout'; // poll watchdog kill -- run never reached terminal; climb like gate-failed

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
  | 'planned' // dry-run selection only; no provider or workflow was fired
  | 'running' // durable cascade record exists and an attempt may be in flight
  | 'won' // a tier passed the gate
  | 'blocked' // all tiers exhausted without a frontier (defensive; should not happen)
  | 'spec-repair' // frontier (fable) tier gate-failed -> SPEC-REPAIR escalation, not a dead end
  | 'recovery-delegated' // an explicitly injected fenced supervisor accepted recovery ownership
  | 'infra-alert'; // infra-error on a tier (escalate/alert, not climb silently)

export interface CascadeRunRecord {
  cascadeId: string; // randomUUID
  woId: string;
  project: string | null; // frozen codebase authority; null only for dry-run plans
  request: {
    woClass: string | null;
    tags: string[];
    entryOverride: TierName | null;
    dryRun: boolean;
  };
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
  /**
   * Populated ONLY when the frontier (fable) tier gate-failed and the cascade
   * emitted a SPEC-REPAIR escalation (status === 'spec-repair'). Doctrine
   * 2026-07-02 (John): Fable is the last escalation before failure -- a WO must
   * never terminally fail. `posted` is true when the WO's GitHub issue received
   * the SPEC-REPAIR comment + status:blocked label; false when no issue resolved
   * and the escalate/alert fallback carried the same text instead.
   */
  specRepair?: {
    issueRepo: string | null;
    issueNumber: number | null;
    posted: boolean;
    whatMustChange: string;
    evidence: string;
  };
  supervisorRecovery?: {
    ownerId: string;
    fencingToken: number;
    evidenceRefs: string[];
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
  /** Includes 'escalated' (WO-HARNESS-ESCALATED-RUN-STATUS-01) as a terminal non-success. */
  terminalStatus: 'completed' | 'failed' | 'escalated' | 'cancelled';
  validatorVerdict: 'satisfied' | 'needs_revision' | 'unknown';
  prUrl: string | null;
  prMergeable: boolean | null;
  servedModelId: string | null;
  rawMetadata: Record<string, unknown>;
}
