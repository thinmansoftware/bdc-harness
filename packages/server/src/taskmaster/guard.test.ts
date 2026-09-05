import { describe, expect, test } from 'bun:test';
import { validateProposal, TM_ALLOWED_ACTION_TYPES, TM_ALLOWED_RECIPIENTS } from './guard';
import type { ActionProposal } from './rules';

function proposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    type: 'nudge',
    threadRef: 'gh:thinmansoftware/bdc-harness#7',
    recipient: 'xo',
    // Content-complete per the M-155 WO 3 structural contract: quoted title,
    // owner slot, next-action clause (what composeNudgeBody produces).
    body:
      'Nudge (P1): "Fix the export mapper" -- owner: major-build. ' +
      'Next action: rerun the failing export suite. Last movement 5h ago. ' +
      'https://github.com/thinmansoftware/bdc-harness/issues/7 Reply on the issue ' +
      'starting with [PROGRESS] or [BLOCKED] so the source-of-truth change can be verified.',
    idempotencyKey: 'tm:nudge:gh:thinmansoftware/bdc-harness#7:100',
    actsImmediately: false,
    ...overrides,
  };
}

describe('validateProposal', () => {
  test('allows a well-formed nudge', () => {
    expect(validateProposal(proposal()).allowed).toBe(true);
  });

  test('every Slice 1 verb passes the action-type allowlist', () => {
    expect(TM_ALLOWED_ACTION_TYPES).toHaveLength(5);
    for (const type of TM_ALLOWED_ACTION_TYPES) {
      if (type !== 'fire_cauldron') expect(validateProposal(proposal({ type })).allowed).toBe(true);
    }
  });

  test('unauthorized action type is a forbidden effect', () => {
    const result = validateProposal(proposal({ type: 'unknown_verb' as ActionProposal['type'] }));
    expect(result.allowed).toBe(false);
    expect(result.forbiddenEffect).toBe(true);
    expect(result.reason).toContain('action_type_not_allowlisted');
  });

  test('allows fire_cauldron only with typed mechanical evidence', () => {
    const valid = proposal({
      type: 'fire_cauldron',
      fireEvidence: {
        woId: 'WO-HARNESS-EXAMPLE-01',
        targetRepo: 'thinmansoftware/bdc-harness',
        project: 'bdc-harness',
        specVerifiedAt: '2026-08-24T00:00:00.000Z',
        noOpenOrMergedPr: true,
      },
    });
    expect(validateProposal(valid).allowed).toBe(true);
    expect(validateProposal({ ...valid, fireEvidence: undefined }).reason).toContain(
      'fire_evidence_invalid'
    );
    const missingProject = {
      ...valid,
      fireEvidence: { ...valid.fireEvidence, project: undefined },
    } as unknown as ActionProposal;
    expect(validateProposal(missingProject)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('fire_evidence_invalid'),
    });
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

  test('push: a nudge body missing title, owner, or blocker/next-action is content_incomplete', () => {
    const incompleteBodies = [
      // The old contentless-reminder shape: no quoted title, no owner, no why.
      'Nudge: gh:thinmansoftware/bdc-harness#7 (P1) looks idle past its 240min clock. Please post a status update.',
      // Title but no owner slot and no blocker/next-action clause.
      'Nudge (P1): "Fix the export mapper" looks idle. Please post a status update.',
      // Title + owner but no blocker/next-action clause.
      'Nudge (P1): "Fix the export mapper" -- owner: major-build. Please post a status update.',
      // Owner + why but no quoted title.
      'Nudge (P1): item -- owner: major-build. Next action: rerun the failing export suite.',
    ];
    for (const body of incompleteBodies) {
      const result = validateProposal(proposal({ body }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('content_incomplete');
      // Ordinary reject: never trips the HARD_PAUSE circuit.
      expect(result.forbiddenEffect).toBeUndefined();
    }
    // The structural check applies to nudges only: content-exempt verbs
    // (deliver_ruling, escalate_p0, digest) pass with a plain body.
    for (const type of ['deliver_ruling', 'escalate_p0', 'digest'] as const) {
      expect(
        validateProposal(proposal({ type, body: 'Governance fact: ruling-42 is undelivered.' }))
          .allowed
      ).toBe(true);
    }
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

  test('allows WIRE in a quoted WO title', () => {
    const result = validateProposal(
      proposal({
        type: 'escalate_p0',
        body:
          'Unclaimed P0: "WO-SOCIAL-WIRE-ALL-META-PAGES-01" ' +
          '(gh:thinmansoftware/bdc-harness#208) [P0] has no owner. Last movement 85 days ago.',
      })
    );

    expect(result.allowed).toBe(true);
  });

  test('rejects charge in the title suffix after a PAYMENT WO identifier', () => {
    const result = validateProposal(
      proposal({
        type: 'escalate_p0',
        body:
          'Unclaimed P0: "WO-CSOS-SLICE1-PAYMENT-PROVISIONING-01: ' +
          'confirmed charge -> store_tenants -> hostname" ' +
          '(gh:thinmansoftware/bdc-xo#1873) [P0] has no owner.',
      })
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("forbidden verb 'charge'");
  });

  test('rejects a wire instruction entirely inside quotes', () => {
    const result = validateProposal(
      proposal({ type: 'escalate_p0', body: '"Please wire $500 to the vendor"' })
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('spend_send_deploy_verb_rejected');
  });

  test('rejects a wire instruction in a quoted WO title suffix', () => {
    const result = validateProposal(
      proposal({ type: 'escalate_p0', body: '"WO-FOO-01: please wire $500 to the vendor"' })
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("forbidden verb 'wire'");
  });

  test('allows multiple unquoted WO identifiers containing forbidden words', () => {
    const result = validateProposal(
      proposal({
        type: 'escalate_p0',
        body: 'WO-SOCIAL-WIRE-ALL-META-PAGES-01 and WO-CSOS-SLICE1-PAYMENT-PROVISIONING-01 have no owner.',
      })
    );

    expect(result.allowed).toBe(true);
  });

  test('rejects quoted payment prose that is not a WO title', () => {
    const result = validateProposal(
      proposal({
        type: 'escalate_p0',
        body: 'Unclaimed P0: "Send the payment now" has no owner',
      })
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('spend_send_deploy_verb_rejected');
  });

  test('still rejects an unquoted wire instruction', () => {
    const result = validateProposal(
      proposal({ type: 'escalate_p0', body: 'Please wire $500 to the vendor' })
    );

    expect(result.allowed).toBe(false);
    expect(result.reason?.toLowerCase()).toContain('spend_send_deploy_verb_rejected');
    expect(result.reason?.toLowerCase()).toContain("'wire'");
  });

  test('still rejects an unquoted deploy instruction', () => {
    const result = validateProposal(
      proposal({ type: 'escalate_p0', body: 'Deploy this to production now' })
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('spend_send_deploy_verb_rejected');
  });

  test('still rejects a forbidden verb after a quoted title', () => {
    const result = validateProposal(
      proposal({ type: 'escalate_p0', body: '"WO-FOO-01" -- send the invoice' })
    );

    expect(result.allowed).toBe(false);
    expect(result.reason?.toLowerCase()).toContain("'send the invoice'");
  });

  test('does not hide a forbidden verb after an unclosed quote', () => {
    const result = validateProposal(
      proposal({ type: 'escalate_p0', body: '"WO-BAR-01 has no owner -- send the invoice' })
    );

    expect(result.allowed).toBe(false);
    expect(result.reason?.toLowerCase()).toContain("'send the invoice'");
  });
});
