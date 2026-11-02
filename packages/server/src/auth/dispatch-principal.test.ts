import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  authenticateDispatchPrincipal,
  DispatchPrincipalAuthError,
  parseDispatchPrincipalsRegistry,
  resolveAuthenticatedSender,
  resolveDispatchSenderAuthMode,
} from './dispatch-principal';

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function registry(records: unknown[]): string {
  return JSON.stringify(records);
}

const baseClaude = {
  credential_id: 'claude-active',
  principal_id: 'claude',
  token_sha256: digest('claude-token-active'),
  status: 'active',
  send_as: ['claude'],
  receive_as: ['claude'],
  roles: ['send', 'receive'],
};

describe('dispatch principal registry', () => {
  beforeEach(() => {
    delete process.env.DISPATCH_SENDER_AUTH_MODE;
    delete process.env.DISPATCH_PRINCIPALS_JSON;
  });
  afterEach(() => {
    delete process.env.DISPATCH_SENDER_AUTH_MODE;
    delete process.env.DISPATCH_PRINCIPALS_JSON;
  });

  test('accepts active/retiring overlap and send-only empty receive_as', () => {
    const json = registry([
      baseClaude,
      {
        ...baseClaude,
        credential_id: 'claude-retiring',
        token_sha256: digest('claude-token-retiring'),
        status: 'retiring',
      },
      {
        credential_id: 'notify-only',
        principal_id: 'notifier',
        token_sha256: digest('notify-token'),
        status: 'active',
        send_as: ['notifier'],
        receive_as: [],
        roles: ['send'],
      },
    ]);
    const records = parseDispatchPrincipalsRegistry(json);
    expect(records).toHaveLength(3);
    const active = authenticateDispatchPrincipal({
      principal_id: 'claude',
      token: 'claude-token-active',
      credentialsJson: json,
    });
    expect(active.credential_id).toBe('claude-active');
    const retiring = authenticateDispatchPrincipal({
      principal_id: 'claude',
      token: 'claude-token-retiring',
      credentialsJson: json,
    });
    expect(retiring.status).toBe('retiring');
    const sendOnly = authenticateDispatchPrincipal({
      principal_id: 'notifier',
      token: 'notify-token',
      credentialsJson: json,
    });
    expect(sendOnly.receive_as).toEqual([]);
  });

  test('rejects disabled, wrong token, missing send role, duplicates, reserved ids', () => {
    const disabled = registry([
      {
        ...baseClaude,
        credential_id: 'disabled',
        status: 'disabled',
        token_sha256: digest('disabled-token'),
      },
    ]);
    expect(() =>
      authenticateDispatchPrincipal({
        principal_id: 'claude',
        token: 'disabled-token',
        credentialsJson: disabled,
      })
    ).toThrow(DispatchPrincipalAuthError);

    const noSend = registry([
      {
        ...baseClaude,
        credential_id: 'recv',
        roles: ['receive'],
        token_sha256: digest('recv-token'),
      },
    ]);
    expect(() =>
      authenticateDispatchPrincipal({
        principal_id: 'claude',
        token: 'recv-token',
        credentialsJson: noSend,
      })
    ).toThrow(/missing_send_role/);

    expect(() =>
      authenticateDispatchPrincipal({
        principal_id: 'claude',
        token: 'wrong',
        credentialsJson: registry([baseClaude]),
      })
    ).toThrow(DispatchPrincipalAuthError);

    expect(() =>
      parseDispatchPrincipalsRegistry(
        registry([baseClaude, { ...baseClaude, token_sha256: digest('other') }])
      )
    ).toThrow(/duplicate_credential_id/);

    expect(() =>
      parseDispatchPrincipalsRegistry(
        registry([
          baseClaude,
          {
            ...baseClaude,
            credential_id: 'dup-digest',
            token_sha256: baseClaude.token_sha256,
          },
        ])
      )
    ).toThrow(/duplicate_principal_digest/);

    expect(() =>
      parseDispatchPrincipalsRegistry(
        registry([
          {
            ...baseClaude,
            principal_id: 'system:dispatch',
          },
        ])
      )
    ).toThrow(/reserved/);

    expect(() =>
      parseDispatchPrincipalsRegistry(
        registry([
          baseClaude,
          {
            ...baseClaude,
            credential_id: 'scope-mismatch',
            token_sha256: digest('other'),
            send_as: ['other'],
          },
        ])
      )
    ).toThrow(/scope_mismatch/);
  });

  test('partial headers and modes', () => {
    expect(resolveDispatchSenderAuthMode(undefined)).toBe('off');
    expect(resolveDispatchSenderAuthMode('')).toBe('off');
    expect(resolveDispatchSenderAuthMode('warn')).toBe('warn');
    expect(() => resolveDispatchSenderAuthMode('banana')).toThrow(/mode_invalid/);
    expect(() =>
      authenticateDispatchPrincipal({
        principal_id: 'claude',
        token: null,
        credentialsJson: registry([baseClaude]),
      })
    ).toThrow(/partial/);
    expect(() =>
      authenticateDispatchPrincipal({
        principal_id: null,
        token: null,
        credentialsJson: registry([baseClaude]),
      })
    ).toThrow(/missing/);
  });

  test('sender selector stays inside send_as and never returns raw token', () => {
    const multi = registry([
      {
        ...baseClaude,
        send_as: ['claude', 'fusion'],
        token_sha256: digest('multi-token'),
      },
    ]);
    const credential = authenticateDispatchPrincipal({
      principal_id: 'claude',
      token: 'multi-token',
      requested_sender: 'Fusion',
      credentialsJson: multi,
    });
    expect(resolveAuthenticatedSender({ credential, requested_sender: 'Fusion' })).toBe('fusion');
    expect(() => resolveAuthenticatedSender({ credential, requested_sender: 'xo' })).toThrow(
      /selector_forbidden/
    );
    expect(JSON.stringify(credential)).not.toContain('multi-token');
  });

  test('rejects non-canonical send_as and receive_as addresses', () => {
    expect(() =>
      parseDispatchPrincipalsRegistry(
        registry([
          {
            ...baseClaude,
            send_as: ['Claude'],
          },
        ])
      )
    ).toThrow(/invalid_send_as/);
    expect(() =>
      parseDispatchPrincipalsRegistry(
        registry([
          {
            ...baseClaude,
            send_as: [' claude'],
          },
        ])
      )
    ).toThrow(/invalid_send_as/);
    expect(() =>
      parseDispatchPrincipalsRegistry(
        registry([
          {
            ...baseClaude,
            receive_as: ['Claude '],
          },
        ])
      )
    ).toThrow(/invalid_receive_as/);
  });

  test('malformed registry fails closed', () => {
    expect(() => parseDispatchPrincipalsRegistry('{')).toThrow(/malformed/);
    expect(() => parseDispatchPrincipalsRegistry(undefined)).toThrow(/unavailable/);
    expect(() => parseDispatchPrincipalsRegistry('{}')).toThrow(/malformed/);
  });
});
