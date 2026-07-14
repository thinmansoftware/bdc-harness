/**
 * M-31 Overseer merge-steward permit preparation (M-42 Slice 2).
 *
 * This module wires the read-only live-state reader and the fail-closed
 * capability gate to the append-only substrate in `@archon/core/db/merge-steward`.
 * `prepareM31ActionPermit` reads the exact bound live state, applies the gate,
 * then compares and consumes the proposal transactionally, returning a
 * short-lived, single-use action PERMIT or a typed failure / gate denial.
 *
 * Boundary (M-42 Slice 2): the substrate performs NO provider mutation. The live
 * reader is an INJECTED read-only dependency with no default -- the substrate
 * defines only its interface. The returned permit exposes no mutation callback.
 * The actual runtime capability enforcement and any provider mutation are OUT of
 * scope for this slice and remain separately gated by M-42.
 */
import {
  capabilityForActionKind,
  compareAndConsumeM31Proposal,
  getM31ActionProposal,
  type M31ActionKind,
  type M31ActionPermit,
  type M31ActionProposal,
  type M31ExecutionReceipt,
  type M31LiveObservation,
  type M31PermitResult,
  type M31TypedFailure,
} from '@archon/core/db/merge-steward';

export type {
  M31ActionKind,
  M31ActionPermit,
  M31ActionProposal,
  M31ExecutionReceipt,
  M31LiveObservation,
  M31TypedFailure,
};

/**
 * Obtains the exact bound live observation for a proposal WITHOUT performing any
 * mutation. Implementations are provided by later, separately gated slices; this
 * slice defines only the read-only interface and supplies no default reader.
 */
export interface M31LiveStateReader {
  readBoundState(proposal: M31ActionProposal): Promise<M31LiveObservation>;
}

export interface M31GateRequest {
  readonly capability: string;
  readonly action_kind: M31ActionKind;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
}

export type M31GateDecision =
  | { readonly allowed: true; readonly capability: string }
  | { readonly allowed: false; readonly capability: string; readonly reason: string };

/**
 * Returns a fail-closed authorization decision using the frozen contract shape.
 * It performs NO runtime capability activation and NO side effect.
 */
export interface M31CapabilityGate {
  authorize(request: M31GateRequest): M31GateDecision;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Default fail-closed gate: allows only when the capability exactly matches the
 * frozen action-kind mapping and both digests are well-formed 64-hex content
 * addresses. Grants no runtime capability -- it only produces a decision.
 */
export function createFailClosedM31CapabilityGate(): M31CapabilityGate {
  return {
    authorize(request: M31GateRequest): M31GateDecision {
      const expected = capabilityForActionKind(request.action_kind);
      if (request.capability !== expected) {
        return { allowed: false, capability: request.capability, reason: 'capability_mismatch' };
      }
      if (!DIGEST_RE.test(request.policy_digest)) {
        return {
          allowed: false,
          capability: request.capability,
          reason: 'policy_digest_malformed',
        };
      }
      if (!DIGEST_RE.test(request.verifier_registry_digest)) {
        return {
          allowed: false,
          capability: request.capability,
          reason: 'verifier_registry_digest_malformed',
        };
      }
      return { allowed: true, capability: request.capability };
    },
  };
}

export interface PrepareM31ActionPermitInput {
  readonly proposal_id: string;
  readonly validity_window_ms?: number;
  readonly now?: string;
}

export interface M31PermitPreparationDeps {
  readonly liveStateReader: M31LiveStateReader;
  readonly capabilityGate: M31CapabilityGate;
  /** Optional override (defaults to the core db reader) -- used for isolated tests. */
  readonly getProposal?: (proposalId: string) => Promise<M31ActionProposal | null>;
  /** Optional override (defaults to the core db compare-and-consume). */
  readonly compareAndConsume?: (args: {
    proposal_id: string;
    observation: M31LiveObservation;
    validity_window_ms?: number;
    now?: string;
  }) => Promise<M31PermitResult>;
}

export interface M31GateDenial {
  readonly capability: string;
  readonly reason: string;
}

export type PrepareM31ActionPermitResult =
  | { readonly ok: true; readonly permit: M31ActionPermit; readonly receipt: M31ExecutionReceipt }
  | { readonly ok: false; readonly failure: M31TypedFailure }
  | { readonly ok: false; readonly denied: M31GateDenial }
  | { readonly ok: false; readonly not_found: true };

/**
 * Read live state, apply the fail-closed gate, then compare and consume the
 * proposal exactly once. Returns a permit or one typed failure / gate denial.
 * Exposes NO mutation callback and reaches NO external provider dependency.
 */
export async function prepareM31ActionPermit(
  input: PrepareM31ActionPermitInput,
  deps: M31PermitPreparationDeps
): Promise<PrepareM31ActionPermitResult> {
  const getProposal = deps.getProposal ?? getM31ActionProposal;
  const consume = deps.compareAndConsume ?? compareAndConsumeM31Proposal;

  const proposal = await getProposal(input.proposal_id);
  if (!proposal) return { ok: false, not_found: true };

  const observation = await deps.liveStateReader.readBoundState(proposal);

  const decision = deps.capabilityGate.authorize({
    capability: proposal.capability,
    action_kind: proposal.action_kind,
    policy_digest: proposal.policy_digest,
    verifier_registry_digest: proposal.verifier_registry_digest,
  });
  if (!decision.allowed) {
    return { ok: false, denied: { capability: decision.capability, reason: decision.reason } };
  }

  const result = await consume({
    proposal_id: proposal.proposal_id,
    observation,
    validity_window_ms: input.validity_window_ms,
    now: input.now,
  });
  if (!result.ok) return { ok: false, failure: result.failure };
  return { ok: true, permit: result.permit, receipt: result.receipt };
}
