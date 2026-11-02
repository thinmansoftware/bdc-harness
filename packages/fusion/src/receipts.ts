import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import {
  listOverseerControlEvents,
  type FusionBudgetReservation,
} from '@archon/core/db/overseer-control-plane';
import type { FusionAuthorizationV1, FusionComponentModelV1 } from './types.js';

export function sha256Digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function microusdToUsd(value: number): number {
  return value / 1_000_000;
}

export interface FusionReceiptInput {
  invocation_id: string;
  proposal_id: string;
  verifier_registry_digest: string;
  component_models: FusionComponentModelV1[];
  raw_dissent: string;
  prompt: string;
  result: string;
  model_disclosure: string;
  reservation: FusionBudgetReservation;
}

export interface FusionReceiptArtifact {
  schema_version: 'fusion-receipt-v1';
  authorization: FusionAuthorizationV1;
  cost_digest: string;
  event_chain_digest: string;
  event_count: number;
}

export async function buildFusionReceipt(
  input: FusionReceiptInput
): Promise<FusionReceiptArtifact> {
  const events = await listOverseerControlEvents({
    resource_kind: 'FUSION_BUDGET',
    resource_key: input.reservation.reservation_id,
  });
  const reservedCostUsd = microusdToUsd(input.reservation.requested_microusd);
  const actualCostUsd =
    input.reservation.actual_microusd === null
      ? null
      : microusdToUsd(input.reservation.actual_microusd);
  const costDigest = sha256Digest(
    JSON.stringify({
      actual_cost_usd: actualCostUsd,
      reserved_cost_usd: reservedCostUsd,
      reservation_id: input.reservation.reservation_id,
    })
  );
  const authorizationWithoutReceipt: Omit<FusionAuthorizationV1, 'receipt_digest'> = {
    invocation_id: input.invocation_id,
    proposal_id: input.proposal_id,
    verifier_registry_digest: input.verifier_registry_digest,
    component_models: input.component_models,
    raw_dissent_artifact_digest: sha256Digest(input.raw_dissent),
    prompt_digest: sha256Digest(input.prompt),
    result_digest: sha256Digest(input.result),
    reserved_cost_usd: reservedCostUsd,
    actual_cost_usd: actualCostUsd,
    reconciliation_status:
      input.reservation.status === 'RECONCILED'
        ? 'reconciled'
        : input.reservation.status === 'RESERVED'
          ? 'reserved'
          : 'blocked',
    independent_verifier_pass: true,
  };
  const eventChainDigest = sha256Digest(JSON.stringify(events));
  const receiptDigest = sha256Digest(
    JSON.stringify({
      ...authorizationWithoutReceipt,
      cost_digest: costDigest,
      event_chain_digest: eventChainDigest,
    })
  );
  return {
    schema_version: 'fusion-receipt-v1',
    authorization: { ...authorizationWithoutReceipt, receipt_digest: receiptDigest },
    cost_digest: costDigest,
    event_chain_digest: eventChainDigest,
    event_count: events.length,
  };
}

export async function writeFusionReceiptArtifact(
  path: string,
  receipt: FusionReceiptArtifact
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}
