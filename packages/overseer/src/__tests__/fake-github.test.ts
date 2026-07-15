import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { AppendOverseerCapabilityEventInput } from '@archon/core/db/overseer-capabilities';
import type { AllowedActionPolicyDecision } from '../action-policy';
import { createFakeGitHubAdapter } from '../adapters/fake-github';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
});

function allowedMerge(
  overrides: Partial<AllowedActionPolicyDecision> = {}
): AllowedActionPolicyDecision {
  return {
    allowed: true,
    reason: 'allowed',
    capability: 'merge',
    repository: 'bluedevilcollectibles/bdc-harness',
    pr_number: 42,
    head_sha: 'c'.repeat(40),
    base_branch: 'dev',
    base_sha: 'd'.repeat(40),
    snapshot_id: 'snapshot-1',
    proposal_id: 'proposal-1',
    execution_id: 'execution-1',
    action_kind: 'MERGE',
    policy_digest: 'a'.repeat(64),
    verifier_registry_digest: 'b'.repeat(64),
    ...overrides,
  };
}

function request(repository = 'bluedevilcollectibles/bdc-harness') {
  return {
    repository,
    pr_number: 42,
    head_sha: 'c'.repeat(40),
    base_branch: 'dev',
    base_sha: 'd'.repeat(40),
    snapshot_id: 'snapshot-1',
    proposal_id: 'proposal-1',
    execution_id: 'execution-1',
    action_kind: 'MERGE' as const,
    actor: 'fake-test',
    correlation_id: 'corr-fake-1',
  };
}

describe('fake GitHub mutation adapter', () => {
  test('accepts one exactly bound allowlisted merge and records one fake attempt', async () => {
    const attempts: AppendOverseerCapabilityEventInput[] = [];
    const adapter = createFakeGitHubAdapter({
      allowed_repositories: ['bluedevilcollectibles/bdc-harness'],
      record_attempt: mock(async event => {
        attempts.push(event);
      }),
    });

    const receipt = await adapter.attemptMutation(request(), allowedMerge());

    expect(receipt).toEqual({
      adapter: 'fake-github',
      accepted: true,
      reason: 'fake_accepted',
      repository: 'bluedevilcollectibles/bdc-harness',
      pr_number: 42,
      head_sha: 'c'.repeat(40),
      base_branch: 'dev',
      base_sha: 'd'.repeat(40),
      snapshot_id: 'snapshot-1',
      proposal_id: 'proposal-1',
      execution_id: 'execution-1',
      action_kind: 'MERGE',
      mutation_sent: false,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual(
      expect.objectContaining({
        event_type: 'adapter_attempt',
        reason: 'fake_accepted',
        capability: 'merge',
        proposal_id: 'proposal-1',
        execution_id: 'execution-1',
      })
    );
  });

  test('rejects outside-fixture repository with credentials present and no provider call', async () => {
    process.env.GITHUB_TOKEN = 'poison-github-token';
    process.env.GH_TOKEN = 'poison-gh-token';
    const network = mock(async () => {
      throw new Error('network must be unreachable');
    });
    globalThis.fetch = network as typeof fetch;
    const attempts: AppendOverseerCapabilityEventInput[] = [];
    const adapter = createFakeGitHubAdapter({
      allowed_repositories: ['bluedevilcollectibles/bdc-harness'],
      record_attempt: mock(async event => {
        attempts.push(event);
      }),
    });

    const receipt = await adapter.attemptMutation(
      request('outsider/other-repo'),
      allowedMerge({ repository: 'outsider/other-repo' })
    );

    expect(receipt.accepted).toBe(false);
    expect(receipt.reason).toBe('repository_not_allowlisted');
    expect(receipt.mutation_sent).toBe(false);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.event_type).toBe('adapter_attempt');
    expect(attempts[0]?.reason).toBe('repository_not_allowlisted');
    expect(network).not.toHaveBeenCalled();
    expect(process.env.GITHUB_TOKEN).toBe('poison-github-token');
    expect(process.env.GH_TOKEN).toBe('poison-gh-token');
  });

  test('rejects a policy denial or mismatched action identity with one attempt each', async () => {
    const attempts: AppendOverseerCapabilityEventInput[] = [];
    const adapter = createFakeGitHubAdapter({
      allowed_repositories: ['bluedevilcollectibles/bdc-harness'],
      record_attempt: mock(async event => {
        attempts.push(event);
      }),
    });

    const deniedReceipt = await adapter.attemptMutation(request(), {
      allowed: false,
      reason: 'circuit_open',
      capability: 'merge',
    });
    const mismatchReceipt = await adapter.attemptMutation(
      request(),
      allowedMerge({ execution_id: 'different-execution' })
    );

    expect(deniedReceipt.reason).toBe('policy_not_allowed');
    expect(mismatchReceipt.reason).toBe('action_identity_mismatch');
    expect(attempts.map(attempt => attempt.reason)).toEqual([
      'policy_not_allowed',
      'action_identity_mismatch',
    ]);
  });

  test('source has no real provider, credential, shell, or network dependency', async () => {
    const source = await Bun.file(new URL('../adapters/fake-github.ts', import.meta.url)).text();
    for (const forbidden of [
      '@octokit',
      'Octokit',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'process.env',
      'fetch(',
      'Bun.spawn',
      'child_process',
      'node:http',
      'node:https',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
