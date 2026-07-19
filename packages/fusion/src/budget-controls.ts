/**
 * Fusion M-42 budget, receipt, registry, and reconciliation controls.
 *
 * Build wiring is limited to a FAKE Fusion gateway with synthetic usage
 * responses. Zero paid Fusion calls are authorized or made by this module.
 */

// USD 3 per call, USD 20 per UTC day, USD 100 per UTC month -- see FUSION_PER_CALL_CAP_MICROUSD / FUSION_UTC_DAY_CAP_MICROUSD / FUSION_UTC_MONTH_CAP_MICROUSD in @archon/core/db/overseer-control-plane.ts
export {
  FUSION_RECONCILIATION_WINDOW_MS,
  evaluateUnknownActualCostWindow,
  markFusionCallStarted,
  reconcileFusionCallCost,
  releaseReservedFusionBudget,
  reserveFusionBudgetForCall,
} from './budget.js';
export { buildFusionReceipt, writeFusionReceiptArtifact } from './receipts.js';
export { authorizeFusionInvocation } from './authorization.js';
export {
  registerFrozenFusionVerifierRegistry,
  runM28BlindCalibration,
  validateFusionComponentModels,
} from './registry.js';
