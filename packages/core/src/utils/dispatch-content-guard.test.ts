import { describe, expect, test } from 'bun:test';
import { assessDispatchMessageBody } from './dispatch-content-guard';

describe('assessDispatchMessageBody', () => {
  test('rejects repo-mutating agent_message content', () => {
    const result = assessDispatchMessageBody(
      'agent_message',
      'Please commit this change, push the branch, and deploy it to production.'
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('repo_mutating_agent_message_rejected');
  });

  test('allows benign agent_message content', () => {
    const result = assessDispatchMessageBody(
      'agent_message',
      'Please review this proposal and summarize the main risks.'
    );

    expect(result.allowed).toBe(true);
  });

  test('allows explicit non-mutating task types', () => {
    const result = assessDispatchMessageBody('run_report', 'Report on the latest CI failure.');

    expect(result.allowed).toBe(true);
  });

  test('rejects repo mutation hidden in a free-form report task', () => {
    expect(
      assessDispatchMessageBody('run_report', 'Push this branch and merge it to dev.')
    ).toEqual({
      allowed: false,
      reason: 'repo_mutating_dispatch_body_rejected',
    });
  });

  // ---------------------------------------------------------------------------
  // Regression: the v1 guard tested VOCABULARY, not INTENT. Measured against the
  // 97 real motion files in bdc-xo docs/board/motions, it rejected 85 of them
  // (87%) -- including M-20260710-10-dispatch-dropbox-exception.md, the motion
  // that authorized this bus. Discussing a merge is the board's job; commanding
  // one is what M-10.2 bans. These cases pin that distinction.
  // ---------------------------------------------------------------------------

  describe('board discussion is not a mutation instruction', () => {
    const discussions: [string, string][] = [
      [
        'repo-split question (the packet that bounced 2026-07-26)',
        'Should BDC governance records move out of BDC_XO into a dedicated bdc-board repo? Motions cite WO specs and vice versa, so splitting turns every cross-reference into a link that can rot.',
      ],
      [
        'M-76 shape: give a site its own repo',
        'Give the ComicStoreOS marketing website its own repo instead of sharing one with the live customer stores.',
      ],
      [
        'M-73 shape: staging-to-production standard',
        'Set one standard staging-to-production path for every customer-facing product repo (real staging branch, promotion PR, evidence, rollback).',
      ],
      [
        'M-68/69/70 shape: rebuild the engine',
        'Rebuild the Cauldron engine so the Overseer failure-classifier code is actually running in the live container.',
      ],
      [
        'past tense narration',
        'The fix was merged to dev at 11:29 but the container was built at 13:10, so it never shipped.',
      ],
      ['question form', 'Should we merge this, or wait for the staging evidence?'],
      [
        'read-only git command is not a mutation',
        'Verify ancestry with:\ngit merge-base --is-ancestor <sha> origin/dev',
      ],
      ['quoted failure evidence', "The run failed with: 'cannot push to origin, auth missing'."],
    ];

    for (const [name, body] of discussions) {
      test(`allows: ${name}`, () => {
        expect(assessDispatchMessageBody('agent_message', body).allowed).toBe(true);
      });
    }
  });

  describe('imperative mutation is still blocked (M-10.2 intent)', () => {
    const instructions: [string, string][] = [
      ['bare imperative', 'Merge PR #123 into main.'],
      ['second person directive', 'You should push the branch to origin.'],
      ['please form', 'Please deploy this to production.'],
      ['urgency framing', 'Rebase it now and force-push.'],
      ['bullet list task', 'Tasks:\n- push the fix to dev\n- close the issue'],
      ['raw git command', 'Run this:\n$ git push origin main --force'],
      ['gh cli command', 'gh pr merge 42 --squash'],
      ['numbered step', '1. deploy the container\n2. verify it came up'],
    ];

    for (const [name, body] of instructions) {
      test(`rejects: ${name}`, () => {
        const result = assessDispatchMessageBody('agent_message', body);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('repo_mutating_agent_message_rejected');
      });
    }
  });

  test('board_motion stays content-exempt (gated elsewhere, not here)', () => {
    // board_delivery ships disabled by design; M-27 authorized spec/prep only.
    // This exemption must never be used to route around the guard.
    expect(assessDispatchMessageBody('board_motion', 'gh pr merge 42 --squash').allowed).toBe(true);
  });
});
