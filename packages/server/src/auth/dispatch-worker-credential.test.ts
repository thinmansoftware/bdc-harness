import { createHash } from 'crypto';
import { describe, expect, test } from 'bun:test';
import { authenticateDispatchWorkerCredential } from './dispatch-worker-credential';

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function credentials(status: 'active' | 'retiring' | 'disabled' = 'active'): string {
  return JSON.stringify([
    {
      credential_id: 'board-worker-1',
      worker_id: 'worker-a',
      role: 'board_delivery_worker',
      allowed_principals: ['claude', 'gpt'],
      token_sha256: sha('secret'),
      status,
    },
  ]);
}

describe('authenticateDispatchWorkerCredential', () => {
  test('accepts active and retiring board delivery worker credentials', () => {
    for (const status of ['active', 'retiring'] as const) {
      const credential = authenticateDispatchWorkerCredential({
        credential_id: 'board-worker-1',
        token: 'secret',
        worker_id: 'worker-a',
        delivery_principal: 'claude',
        credentialsJson: credentials(status),
      });
      expect(credential.role).toBe('board_delivery_worker');
      expect(credential.allowed_principals).toContain('claude');
    }
  });

  test('fails closed for missing, malformed, disabled, mismatched, and disallowed credentials', () => {
    for (const input of [
      {
        credential_id: null,
        token: 'secret',
        worker_id: 'worker-a',
        credentialsJson: credentials(),
      },
      {
        credential_id: 'board-worker-1',
        token: null,
        worker_id: 'worker-a',
        credentialsJson: credentials(),
      },
      {
        credential_id: 'board-worker-1',
        token: 'secret',
        worker_id: 'worker-a',
        credentialsJson: 'nope',
      },
      {
        credential_id: 'board-worker-1',
        token: 'secret',
        worker_id: 'worker-a',
        credentialsJson: credentials('disabled'),
      },
      {
        credential_id: 'board-worker-1',
        token: 'wrong',
        worker_id: 'worker-a',
        credentialsJson: credentials(),
      },
      {
        credential_id: 'board-worker-1',
        token: 'secret',
        worker_id: 'worker-b',
        credentialsJson: credentials(),
      },
      {
        credential_id: 'board-worker-1',
        token: 'secret',
        worker_id: 'worker-a',
        delivery_principal: 'codex',
        credentialsJson: credentials(),
      },
    ]) {
      expect(() => authenticateDispatchWorkerCredential(input)).toThrow('worker_unauthorized');
    }
  });

  test('distinguishes non-mutating read probes from claim credentials by returning identity only', () => {
    const credential = authenticateDispatchWorkerCredential({
      credential_id: 'board-worker-1',
      token: 'secret',
      worker_id: 'worker-a',
      delivery_principal: 'gpt',
      credentialsJson: credentials('retiring'),
    });
    expect(credential).toEqual({
      credential_id: 'board-worker-1',
      worker_id: 'worker-a',
      role: 'board_delivery_worker',
      allowed_principals: ['claude', 'gpt'],
      status: 'retiring',
    });
    expect(JSON.stringify(credential)).not.toContain('secret');
    expect(JSON.stringify(credential)).not.toContain(sha('secret'));
  });
});
