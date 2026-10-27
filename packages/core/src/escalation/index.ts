/**
 * Escalation status + packet helpers for WO-HARNESS-ESCALATED-RUN-STATUS-01.
 */
export {
  extractWoId,
  hasValidatorRejectionSignal,
  linkEscalatedPredecessor,
  prepareDispatchWithEscalation,
  type EscalationLinkerStore,
  type LinkEscalationResult,
} from './escalation-linker';

export {
  buildEscalationPacket,
  prependEscalationPacket,
  extractRejectionFindings,
  extractPlanText,
  extractRejectedDiff,
  ESCALATION_FINDINGS_MARKER,
  DEFAULT_PACKET_SIZE_CAP,
  DEFAULT_DIFF_CAP,
  type PacketEvent,
  type BuildEscalationPacketOptions,
  type EscalationPacketResult,
} from './escalation-packet-builder';

export {
  listPredecessorRuns,
  releasePredecessorBranchHolds,
  formatHandoffLines,
  recordPushEvidence,
  normalizeOriginUrl,
  evaluateHandoffHeadPrecondition,
  REPAIR_HEAD_RULE,
  type GitRunner,
  type GitRunResult,
  type HandoffRecord,
  type BranchHandoffSkipReason,
  type SkippedBranchHandoff,
  type ReleaseBranchHoldsResult,
  type ReleaseBranchHoldsOptions,
  type ListPredecessorRunsOptions,
  type PushEvidence,
  type RecordPushEvidenceInput,
  type HandoffHeadPreconditionInput,
  type HandoffHeadPreconditionResult,
  type HandoffHeadDecision,
} from './branch-handoff';
