export interface ModelBindingOverride {
  readonly provider?: string;
  readonly model: string;
}

export interface ModelOverride {
  readonly workflow?: ModelBindingOverride;
  readonly nodes?: Readonly<Record<string, ModelBindingOverride>>;
}

export interface ResolveModelForNodeInput {
  readonly nodeId: string;
  readonly nodeProvider?: string;
  readonly nodeModel?: string;
  readonly personaModel?: string;
  readonly workflowProvider: string;
  readonly workflowModel?: string;
  readonly assistantModels?: Readonly<Record<string, string | undefined>>;
  readonly modelOverride?: ModelOverride;
  readonly fallbackModel?: string;
}

export interface ResolvedModelBinding {
  readonly provider: string;
  readonly model: string | undefined;
}

/** Resolve the effective provider/model pair for one workflow node. */
export function resolveModelForNode(input: ResolveModelForNodeInput): ResolvedModelBinding {
  const workflowOverride = input.modelOverride?.workflow;
  const workflowProvider = workflowOverride?.provider ?? input.workflowProvider;
  const workflowModel = workflowOverride?.model ?? input.workflowModel;

  const nodeOverride = input.modelOverride?.nodes?.[input.nodeId];
  if (nodeOverride) {
    return {
      provider: nodeOverride.provider ?? input.nodeProvider ?? workflowProvider,
      model: nodeOverride.model,
    };
  }

  const provider = input.nodeProvider ?? workflowProvider;
  const assistantModel = input.assistantModels?.[provider];

  return {
    provider,
    model:
      input.personaModel ??
      input.nodeModel ??
      (provider === workflowProvider ? workflowModel : assistantModel) ??
      input.fallbackModel,
  };
}
