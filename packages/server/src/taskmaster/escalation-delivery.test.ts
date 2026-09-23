/**
 * Unit tests for the Taskmaster escalation-delivery module
 * (WO-HARNESS-TASKMASTER-ESCALATE-TO-ISSUE-01). Everything is
 * dependency-injected (fake comment store, fake clock); no network.
 */
import { describe, expect, test } from 'bun:test';
import {
  TASKMASTER_ESCALATION_MARKER,
  TASKMASTER_ESCALATION_COOLDOWN_MS,
  buildEscalationCommentBody,
  deliverEscalationToIssue,
  parseGithubThreadRef,
  parseOwnerLabel,
  resolveEscalateToIssueEnabled,
  type EscalationIssueComment,
  type EscalationIssueRef,
} from './escalation-delivery';

const ISSUE: EscalationIssueRef = { owner: 'thinmansoftware', repo: 'bdc-harness', number: 194 };
const T0 = Date.parse('2026-09-23T12:00:00.000Z');

describe('parseGithubThreadRef', () => {
  test('parses gh:owner/repo#N with owner and repo split', () => {
    expect(parseGithubThreadRef('gh:thinmansoftware/bdc-harness#194')).toEqual({
      owner: 'thinmansoftware',
      repo: 'bdc-harness',
      number: 194,
    });
  });

  test('rejects non-gh and malformed refs', () => {
    expect(parseGithubThreadRef('dispatch:ruling-42')).toBeNull();
    expect(parseGithubThreadRef('gh:no-repo#1')).toBeNull();
    expect(parseGithubThreadRef('gh:owner/repo#0')).toBeNull();
    expect(parseGithubThreadRef('gh:owner/repo')).toBeNull();
    expect(parseGithubThreadRef('')).toBeNull();
  });
});

describe('resolveEscalateToIssueEnabled', () => {
  test('defaults to true when unset', () => {
    expect(resolveEscalateToIssueEnabled(undefined)).toBe(true);
  });

  test("only literal 'false' (any case, trimmed) disables", () => {
    expect(resolveEscalateToIssueEnabled('false')).toBe(false);
    expect(resolveEscalateToIssueEnabled('FALSE')).toBe(false);
    expect(resolveEscalateToIssueEnabled('  False  ')).toBe(false);
  });

  test('anything else keeps it enabled', () => {
    expect(resolveEscalateToIssueEnabled('true')).toBe(true);
    expect(resolveEscalateToIssueEnabled('1')).toBe(true);
    expect(resolveEscalateToIssueEnabled('')).toBe(true);
  });
});

describe('parseOwnerLabel', () => {
  test('extracts login from an owner:<login> label', () => {
    expect(parseOwnerLabel(JSON.stringify(['wo', 'P0', 'owner:major-build']))).toBe('major-build');
  });

  test('returns null when absent, empty, or malformed', () => {
    expect(parseOwnerLabel(JSON.stringify(['wo', 'P0']))).toBeNull();
    expect(parseOwnerLabel(JSON.stringify(['owner:']))).toBeNull();
    expect(parseOwnerLabel('not json')).toBeNull();
    expect(parseOwnerLabel(null)).toBeNull();
    expect(parseOwnerLabel(undefined)).toBeNull();
  });
});

describe('buildEscalationCommentBody', () => {
  test('is ASCII-only, carries the marker, attribution, and at most one mention', () => {
    const body = buildEscalationCommentBody({
      title: 'WO-HARNESS-EXAMPLE-01 fix the thing',
      threadRef: 'gh:thinmansoftware/bdc-harness#194',
      sinceIso: new Date(T0 - 50 * 60 * 60 * 1000).toISOString(),
      nextAction: 'Assign an owner and start the build.',
      ownerLabelLogin: 'major-build',
      nowMs: T0,
    });
    // ASCII-only (Rule 13).
    expect(/^[\x00-\x7F]*$/.test(body)).toBe(true);
    expect(body).toContain(TASKMASTER_ESCALATION_MARKER);
    expect(body).toContain('Escalated by Taskmaster (M-155).');
    expect(body).toContain('Next step: Assign an owner and start the build.');
    // At most one @-mention.
    expect((body.match(/@/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(body).toContain('@major-build');
    // "since" is rendered in days for a >48h gap.
    expect(body).toContain('for 2 days');
  });

  test('omits next-step and owner lines when absent, and falls back to threadRef', () => {
    const body = buildEscalationCommentBody({
      title: null,
      threadRef: 'gh:thinmansoftware/bdc-harness#208',
      sinceIso: null,
      nextAction: null,
      ownerLabelLogin: null,
      nowMs: T0,
    });
    expect(body).toContain('gh:thinmansoftware/bdc-harness#208');
    expect(body).not.toContain('Next step:');
    expect((body.match(/@/g) ?? []).length).toBe(0);
  });
});

describe('deliverEscalationToIssue', () => {
  test('no prior marker comment -> posts and returns posted:true', async () => {
    const nowMs = T0;
    let posts = 0;
    const comments: EscalationIssueComment[] = [
      { body: 'a human comment', created_at: new Date(T0 - 1000).toISOString() },
    ];
    const deps = {
      listIssueComments: async () => comments,
      postIssueComment: async (_i: EscalationIssueRef, body: string) => {
        posts += 1;
        comments.push({ body, created_at: new Date(nowMs).toISOString() });
      },
      now: () => new Date(nowMs),
    };
    const result = await deliverEscalationToIssue(
      {
        issue: ISSUE,
        threadRef: 'gh:thinmansoftware/bdc-harness#194',
        body: `${TASKMASTER_ESCALATION_MARKER}\n\nbody`,
      },
      deps
    );
    expect(result.posted).toBe(true);
    expect(posts).toBe(1);
  });

  test('prior marker comment younger than 72h -> does not post', async () => {
    const nowMs = T0;
    let posts = 0;
    const comments: EscalationIssueComment[] = [
      {
        body: `${TASKMASTER_ESCALATION_MARKER}\n\nprevious escalation`,
        created_at: new Date(T0 - (TASKMASTER_ESCALATION_COOLDOWN_MS - 60_000)).toISOString(),
      },
    ];
    const deps = {
      listIssueComments: async () => comments,
      postIssueComment: async () => {
        posts += 1;
      },
      now: () => new Date(nowMs),
    };
    const result = await deliverEscalationToIssue(
      { issue: ISSUE, threadRef: 'gh:thinmansoftware/bdc-harness#194', body: 'x' },
      deps
    );
    expect(result.posted).toBe(false);
    expect(posts).toBe(0);
  });

  test('prior marker comment older than 72h -> posts again', async () => {
    const nowMs = T0;
    let posts = 0;
    const comments: EscalationIssueComment[] = [
      {
        body: `${TASKMASTER_ESCALATION_MARKER}\n\nstale escalation`,
        created_at: new Date(T0 - (TASKMASTER_ESCALATION_COOLDOWN_MS + 60_000)).toISOString(),
      },
    ];
    const deps = {
      listIssueComments: async () => comments,
      postIssueComment: async () => {
        posts += 1;
      },
      now: () => new Date(nowMs),
    };
    const result = await deliverEscalationToIssue(
      { issue: ISSUE, threadRef: 'gh:thinmansoftware/bdc-harness#194', body: 'x' },
      deps
    );
    expect(result.posted).toBe(true);
    expect(posts).toBe(1);
  });
});
