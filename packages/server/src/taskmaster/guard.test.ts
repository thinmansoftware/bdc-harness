import { describe, expect, test } from 'bun:test';
import { validateProposal, TM_ALLOWED_ACTION_TYPES, TM_ALLOWED_RECIPIENTS } from './guard';
import type { ActionProposal } from './rules';

function proposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    type: 'nudge',
    threadRef: 'gh:bluedevilcollectibles/bdc-harness#7',
    recipient: 'xo',
    body: 'Nudge: please post a status update on this thread.',
    idempotencyKey: 'tm:nudge:gh:bluedevilcollectibles/bdc-harness#7:100',
    actsImmediately: false,
    ...overrides,
  };
}

describe('validateProposal', () => {
  test('allows a well-formed nudge', () => {
    expect(validateProposal(proposal()).allowed).toBe(true);
  });

  test('every Slice 1 verb passes the action-type allowlist', () => {
    for (const type of TM_ALLOWED_ACTION_TYPES) {
      expect(validateProposal(proposal({ type })).allowed).toBe(true);
    }
  });

  test('unauthorized action type is a forbidden effect', () => {
    const result = validateProposal(proposal({ type: 'fire_cauldron' as ActionProposal['type'] }));
    expect(result.allowed).toBe(false);
    expect(result.forbiddenEffect).toBe(true);
    expect(result.reason).toContain('action_type_not_allowlisted');
  });

  test('broadcast/board/invented recipients are forbidden effects', () => {
    for (const recipient of ['board', 'everyone', 'customer', '*']) {
      const result = validateProposal(proposal({ recipient }));
      expect(result.allowed).toBe(false);
      expect(result.forbiddenEffect).toBe(true);
    }
  });

  test('all allowlisted recipients pass', () => {
    for (const recipient of TM_ALLOWED_RECIPIENTS) {
      expect(validateProposal(proposal({ recipient })).allowed).toBe(true);
    }
  });

  test('missing idempotency key is rejected', () => {
    const result = validateProposal(proposal({ idempotencyKey: '  ' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('idempotency_key_missing');
  });

  test('empty body is rejected', () => {
    const result = validateProposal(proposal({ body: '   ' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('body_empty');
  });

  test('spend/send/deploy verbs in the body are rejected (ported DO guard)', () => {
    const bodies = [
      'Please refund the customer for order 123.',
      'Go ahead and deploy to production now.',
      'You should merge to main and push to prod.',
      'Send the email to the customer about their pulls.',
    ];
    for (const body of bodies) {
      const result = validateProposal(proposal({ body }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('spend_send_deploy_verb_rejected');
      // Content rejections are journal-only, NOT hard-pause circuits.
      expect(result.forbiddenEffect).toBeUndefined();
    }
  });
});
