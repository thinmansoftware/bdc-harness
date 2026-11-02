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
