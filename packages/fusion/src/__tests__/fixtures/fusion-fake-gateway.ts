import type { ModelCallRequest, ModelCallResult, ModelGateway } from '../../types.js';

export interface SyntheticFusionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  actual_cost_usd: number | null;
}

export interface FakeFusionGatewayResult extends ModelCallResult {
  syntheticUsage: SyntheticFusionUsage;
}

export function makeFakeFusionGateway(usage: SyntheticFusionUsage): ModelGateway {
  return async (req: ModelCallRequest): Promise<FakeFusionGatewayResult> => ({
    text: `synthetic fusion response for ${req.role}`,
    servedModelId: req.modelId,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    },
    syntheticUsage: usage,
    ok: true,
    error: null,
  });
}
