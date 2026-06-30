import { describe, it, test, expect } from 'bun:test';
import { dagNodeSchema, approvalNodeSchema, BASH_NODE_AI_FIELDS } from './dag-node';

// ---------------------------------------------------------------------------
// agent: field schema tests
// ---------------------------------------------------------------------------

describe('dagNodeSchema agent field', () => {
  test('accepts prompt node with agent: field', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan',
      agent: 'war-council-architect',
      prompt: 'Plan the implementation.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { agent?: string }).agent).toBe('war-council-architect');
    }
  });

  test('accepts command node with agent: field', () => {
    const result = dagNodeSchema.safeParse({
      id: 'review',
      agent: 'codex-adversarial-reviewer',
      command: 'archon-assist',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { agent?: string }).agent).toBe('codex-adversarial-reviewer');
    }
  });

  test('agent field is optional -- node without agent still validates', () => {
    const result = dagNodeSchema.safeParse({
      id: 'step',
      prompt: 'Do the thing.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { agent?: string }).agent).toBeUndefined();
    }
  });

  test('node with agent AND model both present -- schema accepts it (executor logs warning)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'implement',
      agent: 'major-build',
      model: 'sonnet',
      prompt: 'Implement the plan.',
    });
    // Schema allows coexistence -- executor handles model precedence at runtime
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { agent?: string }).agent).toBe('major-build');
      expect((result.data as { model?: string }).model).toBe('sonnet');
    }
  });

  test('rejects empty string for agent', () => {
    const result = dagNodeSchema.safeParse({
      id: 'step',
      agent: '',
      prompt: 'Do it.',
    });
    expect(result.success).toBe(false);
  });

  test('backward compat: node without agent uses node model as before', () => {
    const result = dagNodeSchema.safeParse({
      id: 'step',
      model: 'opus',
      prompt: 'Do it.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { model?: string }).model).toBe('opus');
      expect((result.data as { agent?: string }).agent).toBeUndefined();
    }
  });

  test('agent is listed in BASH_NODE_AI_FIELDS (bash nodes should not use it)', () => {
    expect(BASH_NODE_AI_FIELDS).toContain('agent');
  });

  test('bash node with agent field is accepted by schema (warning only, not error)', () => {
    // The schema itself does not error on bash+agent -- loader emits a warning at parse time
    const result = dagNodeSchema.safeParse({
      id: 'step',
      bash: 'echo hello',
      agent: 'war-council-architect',
    });
    // Bash nodes accept agent in the raw schema since all base fields pass through
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// effortLevelSchema tests
// ---------------------------------------------------------------------------

describe('effortLevelSchema', () => {
  test('accepts all valid effort levels including xhigh', () => {
    const validLevels = ['low', 'medium', 'high', 'max', 'xhigh'];
    for (const level of validLevels) {
      const result = dagNodeSchema.safeParse({ id: 'step', prompt: 'x', effort: level });
      expect(result.success).toBe(true);
    }
  });

  test('rejects unknown effort level', () => {
    const result = dagNodeSchema.safeParse({ id: 'step', prompt: 'x', effort: 'ultra' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// approval choices (additive) tests
// ---------------------------------------------------------------------------

describe('approval choices (additive)', () => {
  it('accepts choices on approvalNodeSchema and preserves the value', () => {
    const parsed = approvalNodeSchema.parse({
      id: 'gate',
      approval: {
        message: 'hi',
        choices: ['approve_as_is', 'approve_with_fix', 'reject'],
      },
    });
    expect(parsed.approval.choices).toEqual(['approve_as_is', 'approve_with_fix', 'reject']);
  });

  it('preserves choices through dagNodeSchema (inline approval object)', () => {
    const parsed = dagNodeSchema.parse({
      id: 'gate',
      approval: { message: 'hi', choices: ['approve_as_is', 'reject'] },
    });
    expect((parsed as { approval: { choices?: string[] } }).approval.choices).toEqual([
      'approve_as_is',
      'reject',
    ]);
  });

  it('still accepts an approval node with NO choices (backward compatible)', () => {
    const parsed = approvalNodeSchema.parse({ id: 'gate', approval: { message: 'hi' } });
    expect(parsed.approval.choices).toBeUndefined();
  });

  it('rejects an unknown choice value', () => {
    const result = approvalNodeSchema.safeParse({
      id: 'gate',
      approval: { message: 'hi', choices: ['approve_as_is', 'bad_value'] },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loop node provider/model field preservation
// WO-HARNESS-LOOP-NODE-PROVIDER-MODEL-DROPPED-01
// ---------------------------------------------------------------------------

describe('loop node provider/model field preservation', () => {
  // Scenario A -- provider and model survive the schema transform
  it('loop node: provider and model survive the transform (regression: were silently dropped)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan-review',
      provider: 'opr',
      model: 'glm-5.2',
      persona: 'war-council-architect-opr',
      loop: {
        prompt: 'Review the plan.',
        until: 'APPROVED',
        max_iterations: 3,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { provider?: string }).provider).toBe('opr');
      expect((result.data as { model?: string }).model).toBe('glm-5.2');
    }
  });

  // Scenario B -- non-loop branches unaffected (no regression)
  it('prompt node: provider and model still survive (no regression in sibling branches)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'step',
      provider: 'codex',
      model: 'gpt-5',
      prompt: 'Implement the feature.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { provider?: string }).provider).toBe('codex');
      expect((result.data as { model?: string }).model).toBe('gpt-5');
    }
  });

  it('command node: provider and model still survive (no regression in sibling branches)', () => {
    const result = dagNodeSchema.safeParse({
      id: 'step',
      provider: 'codex',
      model: 'gpt-5',
      command: 'archon-assist',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { provider?: string }).provider).toBe('codex');
      expect((result.data as { model?: string }).model).toBe('gpt-5');
    }
  });

  // Scenario D -- silent-misroute regression: codex loop node provider not dropped to undefined
  it('codex loop node: provider not dropped to undefined (silent-misroute regression)', () => {
    // Before fix: node.provider was undefined after the transform.
    // dag-executor then did: loopProvider = undefined ?? workflowProvider = 'claude'.
    // The node silently ran with the wrong provider and no error.
    const result = dagNodeSchema.safeParse({
      id: 'implement',
      provider: 'codex',
      loop: {
        prompt: 'Implement the feature.',
        until: 'COMPLETE',
        max_iterations: 5,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const resolvedProvider = (result.data as { provider?: string }).provider ?? 'claude';
      expect(resolvedProvider).toBe('codex');
    }
  });

  // Scenario E -- systemPrompt on loop node: flows through transform, no false-positive warning
  it('loop node: systemPrompt survives the transform (buildLoopNodeOptions reads it)', () => {
    // systemPrompt is NOT in LOOP_NODE_AI_FIELDS (excluded alongside model/provider/agent/
    // persona) because buildLoopNodeOptions reads node.systemPrompt directly. Before this
    // fix the loader would have emitted a false-positive loop_node_ai_fields_ignored warning
    // while the field was silently applied to every AI call.
    const result = dagNodeSchema.safeParse({
      id: 'review',
      systemPrompt: 'You are a strict code reviewer.',
      loop: {
        prompt: 'Review the diff.',
        until: 'LGTM',
        max_iterations: 4,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { systemPrompt?: string }).systemPrompt).toBe(
        'You are a strict code reviewer.'
      );
    }
  });
});
