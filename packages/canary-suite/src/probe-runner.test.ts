import { expect, test } from 'bun:test';
import { runLayer2TrivialFire } from './probe-runner';
import type {
  FireTimeProbeDecision,
  FireTimeProbeInput,
} from '@archon/workflows/reliability/fire-time-probe';
import type { ProviderProbeDeps } from '@archon/providers/probe';

test('Layer 2 aborts unless Layer 1 is green and has no time trigger', async () => {
  await expect(
    runLayer2TrivialFire({ lane: 'bdc-feature-development-codex', layer1Green: false })
  ).resolves.toEqual({ verdict: 'aborted' });
});

const probeDeps = { getAgentProvider: () => ({}) } as unknown as ProviderProbeDeps;
const fireTimeProbeInput = {
  workflow: {
    name: 'bdc-canary-layer2-trivial',
    description: 'fixture',
    nodes: [{ id: 'trivial-build', prompt: 'touch canary' }],
  },
  workflowProvider: 'codex',
  workflowModel: 'gpt-5.5',
  config: { assistant: 'codex', assistants: { claude: {}, codex: {} }, commands: {} },
  cwd: '/tmp/repo',
  source: 'fire_probe',
} satisfies FireTimeProbeInput;

test('Layer 2 runs fire-time probe and requires real PR evidence when Layer 1 is green', async () => {
  const calls: string[] = [];
  const runProbe = async (
    deps: ProviderProbeDeps,
    input: FireTimeProbeInput
  ): Promise<FireTimeProbeDecision> => {
    expect(deps).toBe(probeDeps);
    expect(input.workflow.name).toBe('bdc-canary-layer2-trivial');
    calls.push('probe');
    return { blocked: false, warnings: [], bindings: [] };
  };
  const dispatch = async () => {
    calls.push('dispatch');
    return {
      prUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/123',
      headSha: 'a'.repeat(40),
    };
  };

  await expect(
    runLayer2TrivialFire({
      lane: 'bdc-feature-development-codex',
      layer1Green: true,
      providerProbeDeps: probeDeps,
      fireTimeProbeInput,
      runProbe,
      dispatch,
    })
  ).resolves.toEqual({
    verdict: 'passed',
    prUrl: 'https://github.com/thinmansoftware/bdc-harness/pull/123',
    headSha: 'a'.repeat(40),
  });
  expect(calls).toEqual(['probe', 'dispatch']);
});

test('Layer 2 reports build_failed when fire-time probe blocks', async () => {
  const runProbe = async (): Promise<FireTimeProbeDecision> => ({
    blocked: true,
    warnings: [],
    bindings: [],
    blockedResult: {
      ok: false,
      binding: {
        providerId: 'codex',
        modelId: 'bad',
        authContextId: 'codex:chatgpt-account',
        assistantConfigHash: 'assistant',
        nodeOverrideHash: 'node',
      },
      classification: {
        kind: 'structural',
        errorClass: 'structural_model_not_supported',
        excerpt: 'bad',
      },
      attempts: 2,
    },
  });

  await expect(
    runLayer2TrivialFire({
      lane: 'bdc-feature-development-codex',
      layer1Green: true,
      providerProbeDeps: probeDeps,
      fireTimeProbeInput,
      runProbe,
      dispatch: async () => {
        throw new Error('dispatch should not run');
      },
    })
  ).resolves.toEqual({ verdict: 'build_failed' });
});
