import { describe, expect, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerM31TargetV2Routes, type M31TargetV2RouteDeps } from './m31-target-v2.routes';

function deps(overrides: Partial<M31TargetV2RouteDeps> = {}): M31TargetV2RouteDeps {
  return {
    authenticatePrincipal: async () => undefined,
    registerSnapshot: async input => ({
      ...input,
      snapshot_id: 's',
      schema_version: 'm31-target-v2',
      predecessor_snapshot_id: null,
      predecessor_evidence_git_blob: null,
      created_at: input.capture_completed_at,
      targets: [],
    }),
    getSnapshot: async () => null,
    appendDiscrepancy: async input => ({
      discrepancy_id: 'd',
      snapshot_id: input.snapshot_id,
      affected_targets: input.affected_targets,
      conflict: input.conflict,
      recorded_by: input.recorded_by,
      recorded_at: '2026-07-16T12:00:00.000Z',
      resolution: input.resolution ?? null,
      resolved_by: input.resolved_by ?? null,
      resolved_at: input.resolution ? '2026-07-16T12:00:00.000Z' : null,
      predecessor_discrepancy_id: input.predecessor_discrepancy_id ?? null,
    }),
    resolveDiscrepancy: async input => ({
      discrepancy_id: 'r',
      snapshot_id: input.snapshot_id,
      affected_targets: input.affected_targets,
      conflict: input.conflict,
      recorded_by: input.recorded_by,
      recorded_at: '2026-07-16T12:00:00.000Z',
      resolution: input.resolution,
      resolved_by: input.resolved_by,
      resolved_at: '2026-07-16T12:00:00.000Z',
      predecessor_discrepancy_id: input.predecessor_discrepancy_id ?? null,
    }),
    createProposal: async () => ({ ok: false, failure: 'action_target_mismatch' }),
    getProposal: async () => null,
    preparePermit: async () => ({ ok: false, failure: 'live_state_unknown' }),
    ...overrides,
  };
}

describe('registerM31TargetV2Routes', () => {
  test('is unmounted by default and requires injected authentication and stores', async () => {
    const bare = new OpenAPIHono();
    expect((await bare.request('/api/overseer/m31/v2/snapshots/s')).status).toBe(404);

    let storeCalls = 0;
    const app = new OpenAPIHono();
    registerM31TargetV2Routes(
      app,
      deps({
        authenticatePrincipal: async () => {
          throw new Error('denied');
        },
        getSnapshot: async () => {
          storeCalls++;
          return null;
        },
      })
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('poison_network_reached');
    }) as typeof fetch;
    try {
      const response = await app.request('/api/overseer/m31/v2/snapshots/s');
      expect(response.status).toBe(401);
      expect(storeCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects an invalid mixed PR target before the injected proposal store', async () => {
    let storeCalls = 0;
    const app = new OpenAPIHono();
    registerM31TargetV2Routes(
      app,
      deps({
        createProposal: async () => {
          storeCalls++;
          return { ok: false, failure: 'target_invalid' };
        },
      })
    );
    const response = await app.request('/api/overseer/m31/v2/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repository: 'org/repo',
        target: {
          target_kind: 'pull_request',
          repository: 'org/repo',
          pr_number: 0,
          provider_node_id: 'PR_0',
          head_sha: 'a'.repeat(40),
          base_branch: 'dev',
          base_sha: 'b'.repeat(40),
          state: 'open',
          updated_at: '2026-07-16T12:00:00.000Z',
        },
        snapshot_id: 's',
        evidence_path: 'e',
        action_kind: 'MERGE',
        action_parameters: {},
        actor: 'xo',
        policy_digest: 'c'.repeat(64),
        verifier_registry_digest: 'd'.repeat(64),
      }),
    });
    expect(response.status).toBe(400);
    expect(storeCalls).toBe(0);
  });

  test('compare route passes exact observation without caller clock or effect dependency', async () => {
    let received: Record<string, unknown> | undefined;
    const app = new OpenAPIHono();
    registerM31TargetV2Routes(
      app,
      deps({
        preparePermit: async input => {
          received = input as unknown as Record<string, unknown>;
          return { ok: false, failure: 'live_state_unknown' };
        },
      })
    );
    const response = await app.request('/api/overseer/m31/v2/proposals/p/compare-and-consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        observation: {
          known: false,
          target: {
            target_kind: 'issue',
            repository: 'org/repo',
            issue_number: 1,
            provider_node_id: 'I_1',
            state: 'open',
            updated_at: '2026-07-16T12:00:00.000Z',
            is_pull_request: false,
          },
          policy_digest: 'a'.repeat(64),
          verifier_registry_digest: 'b'.repeat(64),
          observed_at: '2026-07-16T12:00:00.000Z',
        },
      }),
    });
    expect(response.status).toBe(409);
    expect(received?.proposal_id).toBe('p');
    expect('now' in (received ?? {})).toBe(false);
  });
});
