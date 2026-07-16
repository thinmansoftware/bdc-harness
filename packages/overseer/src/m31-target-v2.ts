import {
  compareAndConsumeM31ProposalV2,
  getM31ActionProposalV2,
  type M31ActionKind,
  type M31ActionPermitV2,
  type M31ActionProposalV2,
  type M31ExecutionReceiptEventV2,
  type M31LiveObservationV2,
  type M31PermitResultV2,
  type M31TargetV2TypedFailure,
} from '@archon/core/db/m31-target-v2';

export interface M31LiveStateReaderV2 {
  readBoundState(proposal: M31ActionProposalV2): Promise<M31LiveObservationV2>;
}

export interface M31GateRequestV2 {
  readonly capability: string;
  readonly action_kind: M31ActionKind;
  readonly policy_digest: string;
  readonly verifier_registry_digest: string;
}

export type M31GateDecisionV2 =
  | { readonly allowed: true; readonly capability: string }
  | { readonly allowed: false; readonly capability: string; readonly reason: string };

export interface M31CapabilityGateV2 {
  authorize(request: M31GateRequestV2): M31GateDecisionV2;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

export function createFailClosedM31CapabilityGateV2(): M31CapabilityGateV2 {
  return {
    authorize(request): M31GateDecisionV2 {
      const expected = `overseer.m31.${request.action_kind.toLowerCase()}`;
      if (request.capability !== expected) {
        return {
          allowed: false,
          capability: request.capability,
          reason: 'capability_mismatch',
        };
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

export interface PrepareM31ActionPermitV2Input {
  readonly proposal_id: string;
  readonly validity_window_ms?: number;
  /** Test-only clock seam. Production comparison defaults to the database clock. */
  /** Test-only database clock seam. Never exposed by an HTTP schema. */
  readonly test_clock_now?: string;
}

export interface M31PermitPreparationV2Deps {
  readonly liveStateReader: M31LiveStateReaderV2;
  readonly capabilityGate: M31CapabilityGateV2;
  readonly getProposal?: (proposalId: string) => Promise<M31ActionProposalV2 | null>;
  readonly compareAndConsume?: (input: {
    readonly proposal_id: string;
    readonly observation: M31LiveObservationV2;
    readonly validity_window_ms?: number;
    readonly test_clock_now?: string;
  }) => Promise<M31PermitResultV2>;
}

export type PrepareM31ActionPermitV2Result =
  | {
      readonly ok: true;
      readonly permit: M31ActionPermitV2;
      readonly receipt: M31ExecutionReceiptEventV2;
    }
  | { readonly ok: false; readonly failure: M31TargetV2TypedFailure }
  | {
      readonly ok: false;
      readonly denied: { readonly capability: string; readonly reason: string };
    }
  | { readonly ok: false; readonly not_found: true };

export async function prepareM31ActionPermitV2(
  input: PrepareM31ActionPermitV2Input,
  deps: M31PermitPreparationV2Deps
): Promise<PrepareM31ActionPermitV2Result> {
  const proposal = await (deps.getProposal ?? getM31ActionProposalV2)(input.proposal_id);
  if (!proposal) return { ok: false, not_found: true };

  const observation = await deps.liveStateReader.readBoundState(proposal);
  const decision = deps.capabilityGate.authorize({
    capability: proposal.capability,
    action_kind: proposal.action_kind,
    policy_digest: proposal.policy_digest,
    verifier_registry_digest: proposal.verifier_registry_digest,
  });
  if (!decision.allowed) {
    return {
      ok: false,
      denied: { capability: decision.capability, reason: decision.reason },
    };
  }

  const result = await (deps.compareAndConsume ?? compareAndConsumeM31ProposalV2)({
    proposal_id: proposal.proposal_id,
    observation,
    validity_window_ms: input.validity_window_ms,
    test_clock_now: input.test_clock_now,
  });
  if (!result.ok) return { ok: false, failure: result.failure };
  return { ok: true, permit: result.permit, receipt: result.receipt };
}
