import {
  OVERSEER_CONTROL_PLANE_LEASE_SECONDS,
  markFusionBudgetCallStarted,
  reconcileFusionBudget,
  releaseFusionBudgetReservation,
  reserveFusionBudget,
  type FusionBudgetReleaseReason,
  type FusionBudgetReservation,
  type FusionCallKind,
} from '@archon/core/db/overseer-control-plane';

export const FUSION_RECONCILIATION_WINDOW_MS = OVERSEER_CONTROL_PLANE_LEASE_SECONDS * 1000;

export interface FusionBudgetReservationRequest {
  reservation_id: string;
  call_id: string;
  proposal_id: string;
  execution_id: string;
  provider: string;
  model: string;
  call_kind: FusionCallKind;
  estimated_cost_usd: number;
}

export interface FusionUsageCost {
  actual_cost_usd: number | null;
}

export type FusionBudgetGateResult =
  | { ok: true; reservation: FusionBudgetReservation }
  | { ok: false; code: string; reservation?: FusionBudgetReservation };

export function usdToMicrousd(value: number): number {
  return Math.round(value * 1_000_000);
}

export async function reserveFusionBudgetForCall(
  input: FusionBudgetReservationRequest
): Promise<FusionBudgetGateResult> {
  const requestedMicrousd = usdToMicrousd(input.estimated_cost_usd);
  const result = await reserveFusionBudget({
    reservation_id: input.reservation_id,
    call_id: input.call_id,
    proposal_id: input.proposal_id,
    execution_id: input.execution_id,
    provider: input.provider,
    model: input.model,
    call_kind: input.call_kind,
    requested_microusd: requestedMicrousd,
  });
  return result.ok ? { ok: true, reservation: result.value } : { ok: false, code: result.code };
}

export async function markFusionCallStarted(
  reservation: FusionBudgetReservation
): Promise<FusionBudgetGateResult> {
  const result = await markFusionBudgetCallStarted({
    reservation_id: reservation.reservation_id,
    call_id: reservation.call_id,
  });
  return result.ok ? { ok: true, reservation: result.value } : { ok: false, code: result.code };
}

export async function reconcileFusionCallCost(
  reservation: FusionBudgetReservation,
  usage: FusionUsageCost
): Promise<FusionBudgetGateResult> {
  if (usage.actual_cost_usd === null) {
    return { ok: false, code: 'actual_cost_unknown', reservation };
  }
  const result = await reconcileFusionBudget({
    reservation_id: reservation.reservation_id,
    call_id: reservation.call_id,
    actual_microusd: usdToMicrousd(usage.actual_cost_usd),
  });
  return result.ok ? { ok: true, reservation: result.value } : { ok: false, code: result.code };
}

export async function releaseReservedFusionBudget(
  reservation: FusionBudgetReservation,
  release_reason: FusionBudgetReleaseReason
): Promise<FusionBudgetGateResult> {
  const result = await releaseFusionBudgetReservation({
    reservation_id: reservation.reservation_id,
    call_id: reservation.call_id,
    release_reason,
  });
  return result.ok ? { ok: true, reservation: result.value } : { ok: false, code: result.code };
}

export function evaluateUnknownActualCostWindow(
  reservation: FusionBudgetReservation,
  nowMs: number
): FusionBudgetGateResult {
  if (reservation.actual_microusd !== null) return { ok: true, reservation };
  if (reservation.call_started_at === null) {
    return { ok: false, code: 'call_not_started', reservation };
  }
  const ageMs = nowMs - Date.parse(reservation.call_started_at);
  if (ageMs > FUSION_RECONCILIATION_WINDOW_MS) {
    return { ok: false, code: 'reconciliation_window_expired', reservation };
  }
  return { ok: false, code: 'reconciliation_pending', reservation };
}
