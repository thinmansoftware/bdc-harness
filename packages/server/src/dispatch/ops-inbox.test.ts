import { expect, test } from 'bun:test';
import { ensureOpsInboxIssue, upsertDigestSection, type OpsInboxGithub } from './ops-inbox';

test('ops inbox issue and daily section upserts are idempotent', async () => {
  let issue: { number: number } | null = null;
  const comments: { id: number; body: string }[] = [];
  let labels = 0, issues = 0;
  const github: OpsInboxGithub = {
    findOpenIssue: async () => issue,
    createLabel: async () => { labels += 1; },
    createIssue: async () => { issues += 1; return issue = { number: 7 }; },
    listComments: async () => comments,
    createComment: async (_r,_i,body) => { comments.push({ id: 1, body }); },
    updateComment: async (_r,id,body) => { (comments.find(x => x.id === id)!).body = body; },
  };
  expect((await ensureOpsInboxIssue(github)).number).toBe(7);
  expect((await ensureOpsInboxIssue(github)).number).toBe(7);
  expect([labels, issues]).toEqual([1, 1]);
  await upsertDigestSection(github, '2026-10-20', 'routine', 'first');
  await upsertDigestSection(github, '2026-10-20', 'john-queue', 'john');
  await upsertDigestSection(github, '2026-10-20', 'routine', 'second');
  expect(comments).toHaveLength(1);
  expect(comments[0].body).toContain('second');
  expect(comments[0].body).toContain('john');
  expect(comments[0].body).not.toContain('first');
});
