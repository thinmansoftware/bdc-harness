import {
  assertIndependentVerifier,
  type OverseerVerifierRegistry,
} from '@archon/core/db/overseer-control-plane';
import { validateFusionComponentModels } from './registry.js';
import { sha256Digest } from './receipts.js';
import type {
  FusionAuthorizationBlockCode,
  FusionAuthorizationRequestV1,
  FusionAuthorizationResultV1,
  FusionAuthorizationV1,
} from './types.js';

function blockedAuthorization(
  request: FusionAuthorizationRequestV1,
  code: FusionAuthorizationBlockCode,
  independentVerifierPass: boolean
): FusionAuthorizationResultV1 {
  const authorization: FusionAuthorizationV1 = {
    invocation_id: request.invocation_id,
    proposal_id: request.proposal_id,
    verifier_registry_digest: request.verifier_registry_digest,
    component_models: request.component_models,
    raw_dissent_artifact_digest: request.raw_dissent ? sha256Digest(request.raw_dissent) : '',
    prompt_digest: request.prompt ? sha256Digest(request.prompt) : '',
    result_digest: request.result ? sha256Digest(request.result) : '',
    reserved_cost_usd: request.reserved_cost_usd,
    actual_cost_usd: request.actual_cost_usd,
    reconciliation_status: 'blocked',
    independent_verifier_pass: independentVerifierPass,
    receipt_digest: '',
  };
  return { ok: false, code, authorization };
}

export async function authorizeFusionInvocation(
  request: FusionAuthorizationRequestV1,
  registry: OverseerVerifierRegistry
): Promise<FusionAuthorizationResultV1> {
  if (request.web_enabled) return blockedAuthorization(request, 'web_enabled', false);
  if (request.raw_dissent.trim().length === 0) {
    return blockedAuthorization(request, 'raw_dissent_missing', false);
  }
  if (request.model_disclosure.trim().length === 0 || request.component_models.length === 0) {
    return blockedAuthorization(request, 'model_disclosure_missing', false);
  }
  if (!validateFusionComponentModels(registry, request.component_models)) {
    return blockedAuthorization(request, 'component_model_unregistered', false);
  }

  for (const component of request.component_models) {
    const independence = await assertIndependentVerifier({
      operator_provider: request.operator_provider,
      operator_model_family: request.operator_model_family,
      registry_digest: request.verifier_registry_digest,
      verifier_id: component.verifier_id,
      required_role: 'FUSION',
    });
    if (!independence.ok) {
      return blockedAuthorization(request, 'verifier_not_independent', false);
    }
  }

  if (request.reconciliation_status !== 'reconciled' || request.actual_cost_usd === null) {
    return blockedAuthorization(request, 'reconciliation_required', true);
  }

  const authorizationWithoutReceipt: Omit<FusionAuthorizationV1, 'receipt_digest'> = {
    invocation_id: request.invocation_id,
    proposal_id: request.proposal_id,
    verifier_registry_digest: request.verifier_registry_digest,
    component_models: request.component_models,
    raw_dissent_artifact_digest: sha256Digest(request.raw_dissent),
    prompt_digest: sha256Digest(request.prompt),
    result_digest: sha256Digest(request.result),
    reserved_cost_usd: request.reserved_cost_usd,
    actual_cost_usd: request.actual_cost_usd,
    reconciliation_status: request.reconciliation_status,
    independent_verifier_pass: true,
  };
  return {
    ok: true,
    authorization: {
      ...authorizationWithoutReceipt,
      receipt_digest: sha256Digest(JSON.stringify(authorizationWithoutReceipt)),
    },
  };
}
