import { describe, expect, mock, test } from 'bun:test';

const boundaryCalls: Array<{
  runId: string;
  options: { permit: unknown; actor: string };
}> = [];

mock.module('@archon/overseer/authorized-escalation', () => ({
  runAuthorizedEscalation: async (runId: string, options: { permit: unknown; actor: string }) => {
    boundaryCalls.push({ runId, options });
    return { accepted: true, reason: 'fake_accepted', mutation_sent: false };
  },
}));

const { runCascade } = await import('../cascade.ts');

describe('cascade default escalation boundary', () => {
  test('valid permit reaches only the shared fake-safe boundary', async () => {
    boundaryCalls.length = 0;
    const permit = {
      permit_id: 'permit-cascade-valid',
      proposal_id: 'proposal-cascade-valid',
      execution_id: 'execution-cascade-valid',
      repository: 'bluedevilcollectibles/bdc-harness',
      pr_number: 42,
      head_sha: 'a'.repeat(40),
      base_branch: 'dev',
      base_sha: 'b'.repeat(40),
      snapshot_id: 'snapshot-cascade-valid',
      action_kind: 'STAGING_MUTATION' as const,
      capability: 'overseer.m31.staging_mutation',
      issued_at: new Date(Date.now() - 1_000).toISOString(),
      valid_until: new Date(Date.now() + 60_000).toISOString(),
    };

    const result = await runCascade({
      woId: 'WO-CASCADE-BOUNDARY-01',
      project: 'bdc-harness',
      entryOverride: 'codex',
      overseerPermit: permit,
      deps: {
        fire: async () => ({
          ok: false,
          runId: null,
          conversationId: 'conversation-cascade-boundary',
          infraError: 'HTTP 401: Unauthorized',
        }),
        poll: async () => {
          throw new Error('poll must not run after fire infrastructure failure');
        },
        judge: () => {
          throw new Error('judge must not run after fire infrastructure failure');
        },
        writeRecord: async () => '/tmp/cascade-boundary.json',
      },
    });

    expect(result.status).toBe('infra-alert');
    expect(boundaryCalls).toHaveLength(1);
    expect(boundaryCalls[0]?.runId).toStartWith('cascade-');
    expect(boundaryCalls[0]?.options).toEqual({
      permit,
      actor: 'smart-cauldron',
    });
  });
});
