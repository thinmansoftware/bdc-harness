import { describe, it, test, expect } from 'bun:test';
import {
  dagNodeSchema,
  approvalNodeSchema,
  BASH_NODE_AI_FIELDS,
  deriveNodeExecutionRequirements,
  isEvidenceNode,
} from './dag-node';

describe('mechanical evidence nodes', () => {
  it('parses a manifest_v2 evidence node without AI execution fields', () => {
    const node = dagNodeSchema.parse({
      id: 'build-manifest',
      evidence: { kind: 'manifest_v2', required_gates: ['plan-review'] },
    });

    expect(isEvidenceNode(node)).toBe(true);
    expect(node).toEqual({
      id: 'build-manifest',
      evidence: { kind: 'manifest_v2', required_gates: ['plan-review'] },
    });
  });

  it('rejects evidence combined with an AI prompt', () => {
    expect(
      dagNodeSchema.safeParse({
        id: 'build-manifest',
        prompt: 'Invent a manifest.',
        evidence: { kind: 'manifest_v2', required_gates: [] },
      }).success
    ).toBe(false);
  });
});

describe('deriveNodeExecutionRequirements', () => {
  it('keeps a text-only plan eligible for chat providers', () => {
    const node = dagNodeSchema.parse({ id: 'plan', prompt: 'Plan it.', allowed_tools: [] });
    expect(deriveNodeExecutionRequirements(node)).toEqual(['text']);
  });

  it('fails closed for an unrecognized AI node with an unspecified tool posture', () => {
    const node = dagNodeSchema.parse({ id: 'apply-patch', prompt: 'Fix it.' });
    expect(deriveNodeExecutionRequirements(node)).toEqual([
      'text',
      'repositoryRead',
      'repositoryWrite',
      'shell',
    ]);
  });

  it('fails closed for a lint-fix seat whose name is not a canonical builder alias', () => {
    const node = dagNodeSchema.parse({ id: 'fix-lint', command: 'lint-fixer' });
    expect(deriveNodeExecutionRequirements(node)).toEqual([
      'text',
      'repositoryRead',
      'repositoryWrite',
      'shell',
    ]);
  });

  it('requires repository execution for a major-build loop', () => {
    const node = dagNodeSchema.parse({
      id: 'implement',
      persona: 'major-build',
      loop: { prompt: 'Implement it.', until: 'COMPLETE', max_iterations: 3 },
    });
    expect(deriveNodeExecutionRequirements(node)).toEqual([
      'text',
      'repositoryRead',
      'repositoryWrite',
      'shell',
    ]);
  });

  it('derives repository requirements from explicit tool declarations', () => {
    const node = dagNodeSchema.parse({
      id: 'inspect',
      prompt: 'Inspect it.',
      allowed_tools: ['Read', 'Grep'],
    });
    expect(deriveNodeExecutionRequirements(node)).toEqual(['text', 'repositoryRead']);
  });

  it('requires full repository execution for implement commands', () => {
    const node = dagNodeSchema.parse({ id: 'implement', command: 'implement-changes' });
    expect(deriveNodeExecutionRequirements(node)).toEqual([
      'text',
      'repositoryRead',
      'repositoryWrite',
      'shell',
    ]);
  });

  it('requires repository execution for canonical repair seats without a persona', () => {
    const node = dagNodeSchema.parse({ id: 'diff-repair', prompt: 'Apply the fixes.' });
    expect(deriveNodeExecutionRequirements(node)).toEqual([
      'text',
      'repositoryRead',
      'repositoryWrite',
      'shell',
    ]);
  });

  it('does not attach provider requirements to deterministic bash nodes', () => {
    const node = dagNodeSchema.parse({ id: 'verify', bash: 'echo ok' });
    expect(deriveNodeExecutionRequirements(node)).toEqual([]);
  });
});

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
});

// ---------------------------------------------------------------------------
// failover_provider / failover_model (WO-HARNESS-NODE-PROVIDER-FAILOVER-01)
// ---------------------------------------------------------------------------

describe('dagNodeSchema failover fields', () => {
  it('accepts + preserves failover_provider/failover_model on a prompt node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan',
      provider: 'opr',
      model: 'qwen/qwen3-coder',
      failover_provider: 'codex',
      failover_model: 'gpt-5.5',
      prompt: 'Plan the implementation.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { failover_provider?: string; failover_model?: string };
      expect(d.failover_provider).toBe('codex');
      expect(d.failover_model).toBe('gpt-5.5');
    }
  });

  it('preserves failover_provider/failover_model on a loop node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan-review',
      provider: 'opr',
      failover_provider: 'codex',
      failover_model: 'gpt-5.5',
      loop: { prompt: 'Review the plan.', until: 'APPROVED', max_iterations: 3 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { failover_provider?: string; failover_model?: string };
      expect(d.failover_provider).toBe('codex');
      expect(d.failover_model).toBe('gpt-5.5');
    }
  });

  it('failover_provider alone (no failover_model) is valid', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan',
      failover_provider: 'codex',
      prompt: 'Plan it.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { failover_provider?: string; failover_model?: string };
      expect(d.failover_provider).toBe('codex');
      expect(d.failover_model).toBeUndefined();
    }
  });

  it('a node with no failover fields carries neither (byte-identical to before)', () => {
    const result = dagNodeSchema.safeParse({ id: 'plan', prompt: 'Plan it.' });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data as { failover_provider?: string; failover_model?: string };
      expect(d.failover_provider).toBeUndefined();
      expect(d.failover_model).toBeUndefined();
    }
  });

  it('rejects an empty failover_provider string', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan',
      failover_provider: '',
      prompt: 'Plan it.',
    });
    expect(result.success).toBe(false);
  });

  it('BASH_NODE_AI_FIELDS includes the failover fields (loader warns on bash nodes)', () => {
    expect(BASH_NODE_AI_FIELDS).toContain('failover_provider');
    expect(BASH_NODE_AI_FIELDS).toContain('failover_model');
  });
});
