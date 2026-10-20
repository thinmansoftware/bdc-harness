import { describe, expect, test } from 'bun:test';
import {
  OPS_INBOX_LABEL,
  ensureOpsInboxIssue,
  upsertDigestSection,
  type OpsInboxGitHub,
} from './ops-inbox';

interface FakeState {
  labels: Set<string>;
  issues: { number: number; labels: string[] }[];
  comments: { id: number; issueNumber: number; body: string }[];
  counts: {
    createLabel: number;
    createIssue: number;
    createComment: number;
    updateComment: number;
  };
  nextIssue: number;
  nextComment: number;
}

function makeFakeGitHub(seedIssueWithLabel = false): { gh: OpsInboxGitHub; state: FakeState } {
  const state: FakeState = {
    labels: new Set<string>(),
    issues: [],
    comments: [],
    counts: { createLabel: 0, createIssue: 0, createComment: 0, updateComment: 0 },
    nextIssue: 100,
    nextComment: 5000,
  };
  if (seedIssueWithLabel) {
    state.labels.add(OPS_INBOX_LABEL);
    state.issues.push({ number: state.nextIssue++, labels: [OPS_INBOX_LABEL] });
  }
  const gh: OpsInboxGitHub = {
    async findOpenIssueByLabel(label) {
      const issue = state.issues.find(i => i.labels.includes(label));
      return issue ? { number: issue.number } : null;
    },
    async labelExists(label) {
      return state.labels.has(label);
    },
    async createLabel(label) {
      state.counts.createLabel += 1;
      state.labels.add(label);
    },
    async createIssue(input) {
      state.counts.createIssue += 1;
      const number = state.nextIssue++;
      state.issues.push({ number, labels: input.labels });
      return { number };
    },
    async listComments(issueNumber) {
      return state.comments
        .filter(c => c.issueNumber === issueNumber)
        .map(c => ({ id: c.id, body: c.body }));
    },
    async createComment(issueNumber, body) {
      state.counts.createComment += 1;
      const id = state.nextComment++;
      state.comments.push({ id, issueNumber, body });
      return { id };
    },
    async updateComment(commentId, body) {
      state.counts.updateComment += 1;
      const comment = state.comments.find(c => c.id === commentId);
      if (!comment) throw new Error('comment_not_found');
      comment.body = body;
    },
  };
  return { gh, state };
}

describe('ops-inbox', () => {
  test('ops_inbox_issue_created_once_when_absent', async () => {
    const { gh, state } = makeFakeGitHub(false);
    const first = await ensureOpsInboxIssue(gh);
    const second = await ensureOpsInboxIssue(gh);
    expect(first).toBe(second);
    expect(state.counts.createLabel).toBe(1);
    expect(state.counts.createIssue).toBe(1);
  });

  test('daily_digest_is_one_comment_with_upserted_sections', async () => {
    const { gh, state } = makeFakeGitHub(true);
    const day = '2026-10-20';

    await upsertDigestSection(gh, day, 'routine', 'routine line one');
    await upsertDigestSection(gh, day, 'john-queue', 'john queue line');
    await upsertDigestSection(gh, day, 'routine', 'routine line two');

    const dayComments = state.comments.filter(c => c.body.includes(`ops-inbox-digest:${day}`));
    expect(dayComments.length).toBe(1);
    const body = dayComments[0].body;
    expect(body).toContain('<!-- section:routine -->');
    expect(body).toContain('<!-- section:john-queue -->');
    // The second routine write replaced only the routine section.
    expect(body).toContain('routine line two');
    expect(body).not.toContain('routine line one');
    expect(body).toContain('john queue line');
    // One create for the first write, two updates for the next two.
    expect(state.counts.createComment).toBe(1);
    expect(state.counts.updateComment).toBe(2);

    // The next UTC date creates a second comment.
    await upsertDigestSection(gh, '2026-10-21', 'routine', 'next day');
    const allDigestComments = state.comments.filter(c =>
      c.body.includes('ops-inbox-digest:2026-10-2')
    );
    expect(allDigestComments.length).toBe(2);
    expect(state.counts.createComment).toBe(2);
  });
});
