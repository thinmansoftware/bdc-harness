// Separate source-owned exception; ordinary tee-time v1 intake remains blocked.
import { policyDigest, TEE_TIME_MODELS, TEE_TIME_REPOSITORY } from './tee-time-policy';

export const TEE_TIME_SUPERVISED_WO = 'WO-TEETIME-SIMULATED-WALKTHROUGH-01';
export const TEE_TIME_SUPERVISED_WORKFLOW = 'bdc-teetime-supervised-walkthrough';
export const TEE_TIME_SUPERVISED_POLICY = Object.freeze({
  version: 2,
  repository: TEE_TIME_REPOSITORY,
  workflow: TEE_TIME_SUPERVISED_WORKFLOW,
  woId: TEE_TIME_SUPERVISED_WO,
  provider: 'codex-native-strict',
  model: TEE_TIME_MODELS['codex-native-strict'],
  escalation: false,
  demoFeatures: true,
  entry: 'operator-isolated-staging-only',
  automaticResume: false,
  production: false,
  realProviders: false,
});
export function supervisedRunPolicy(
  codebaseId: string,
  workflowDigest: string
): Record<string, unknown> {
  if (!codebaseId || !/^sha256:[a-f0-9]{64}$/.test(workflowDigest))
    throw new Error('exact supervised codebase/workflow required');
  return {
    hash: policyDigest(TEE_TIME_SUPERVISED_POLICY),
    codebaseId,
    workflowDigest,
    woId: TEE_TIME_SUPERVISED_WO,
  };
}
