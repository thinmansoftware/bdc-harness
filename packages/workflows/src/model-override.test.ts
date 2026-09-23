import { describe, expect, it } from 'bun:test';
import { resolveModelForNode } from './model-override';

const defaults = {
  nodeId: 'build',
  workflowProvider: 'codex',
  workflowModel: 'gpt-5.6-sol',
  assistantModels: { claude: 'assistant-sonnet', codex: 'assistant-codex' },
};

describe('resolveModelForNode', () => {
  it('workflow override swaps an unpinned node default', () => {
    expect(
      resolveModelForNode({
        ...defaults,
        modelOverride: { workflow: { provider: 'opr', model: 'x-ai/grok-4.7' } },
      })
    ).toEqual({ provider: 'opr', model: 'x-ai/grok-4.7' });
  });

  it('a pinned node keeps its binding under a workflow override', () => {
    expect(
      resolveModelForNode({
        ...defaults,
        nodeProvider: 'claude',
        nodeModel: 'sonnet',
        modelOverride: { workflow: { provider: 'opr', model: 'x-ai/grok-4.7' } },
      })
    ).toEqual({ provider: 'claude', model: 'sonnet' });
  });

  it('node override beats persona and node pins', () => {
    expect(
      resolveModelForNode({
        ...defaults,
        nodeProvider: 'claude',
        nodeModel: 'sonnet',
        personaModel: 'opus',
        modelOverride: { nodes: { build: { provider: 'codex', model: 'gpt-5.6-sol' } } },
      })
    ).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });
  });

  it('preserves the existing resolution chain without an override', () => {
    expect(resolveModelForNode(defaults)).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });
    expect(
      resolveModelForNode({ ...defaults, nodeProvider: 'claude', nodeModel: 'sonnet' })
    ).toEqual({ provider: 'claude', model: 'sonnet' });
    expect(
      resolveModelForNode({ ...defaults, nodeProvider: 'claude', personaModel: 'opus' })
    ).toEqual({ provider: 'claude', model: 'opus' });
    expect(resolveModelForNode({ ...defaults, nodeProvider: 'claude' })).toEqual({
      provider: 'claude',
      model: 'assistant-sonnet',
    });
    expect(
      resolveModelForNode({
        ...defaults,
        nodeProvider: 'opr',
        fallbackModel: 'fallback-model',
      })
    ).toEqual({ provider: 'opr', model: 'fallback-model' });
  });
});
