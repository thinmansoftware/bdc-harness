import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSupervisedController } from './tee-time-supervised-bootstrap';
import {
  claimSupervisedModelAttempt,
  type SupervisedPlanReview,
} from './tee-time-supervised-model-phase';
import type { ProviderAttemptRecord } from './types';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'teetime-model-phase-'));
  roots.push(root);
  const executionHash = 'sha256:' + 'a'.repeat(64);
  const preparedBindingHash = 'sha256:' + 'b'.repeat(64);
  const head = 'c'.repeat(40);
  const controller = await acquireSupervisedController(root, executionHash);
  const records: ProviderAttemptRecord[] = [];
  const review: SupervisedPlanReview = {
    head,
    state: 'OPEN',
    author: 'builder',
    complete: true,
    reviews: [
      {
        id: 123,
        login: 'thinman-overseer[bot]',
        state: 'APPROVED',
        head,
        submittedAt: '2026-10-19T00:00:00Z',
      },
    ],
  };
  const prepared = {
    version: 1 as const,
    runId: 'prepared-run',
    caseHash: 'sha256:' + 'd'.repeat(64),
    authorityHash: 'sha256:' + 'e'.repeat(64),
    bindingHash: preparedBindingHash,
  };
  const events: string[] = [];
  const input = {
    controller,
    executionHash,
    preparedBindingHash,
    reviewHead: head,
    readPrepared: async () => prepared,
    readReview: async () => review,
    recheckExecution: async () => {
      events.push('checked');
    },
    store: {
      listProviderAttempts: async () => records,
      createProviderAttempt: async (attempt: ProviderAttemptRecord) => {
        // Actual exclusive claim must be durable before an attempt is inserted.
        const claim = JSON.parse(await readFile(join(root, 'model.claim.json'), 'utf8'));
        expect(claim.bindingHash).toBe(executionHash);
        expect(claim.reviewId).toBe(123);
        events.push('inserted');
        records.push(attempt);
        return true;
      },
    },
  };
  return { root, input, records, events, review };
}

test('claims execution package then persists and reads the sole restricted attempt', async () => {
  const f = await fixture();
  const attempt = await claimSupervisedModelAttempt(f.input);
  expect(attempt.runId).toBe('prepared-run');
  expect(attempt.provider).toBe('codex-native-strict');
  expect(attempt.requiredCapabilities).toEqual(['text_generation']);
  expect(attempt.servedModelId).toBeNull();
  expect(f.events).toEqual(['checked', 'checked', 'inserted']);
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
  expect(f.records).toHaveLength(1);
  await f.input.controller.releaseAfterNormalCompletion();
});

test('foreign, stale, incomplete or superseded approval cannot insert an attempt', async () => {
  for (const kind of ['foreign', 'stale', 'incomplete', 'dismissed', 'changes', 'self']) {
    const f = await fixture();
    if (kind === 'foreign') f.review.reviews = [{ ...f.review.reviews[0], login: 'builder' }];
    if (kind === 'stale') f.review.reviews = [{ ...f.review.reviews[0], head: '0'.repeat(40) }];
    if (kind === 'incomplete') f.review.complete = false;
    if (kind === 'dismissed' || kind === 'changes')
      f.review.reviews = [
        ...f.review.reviews,
        {
          ...f.review.reviews[0],
          id: 124,
          submittedAt: '2026-10-19T00:00:01Z',
          state: kind === 'dismissed' ? 'DISMISSED' : 'CHANGES_REQUESTED',
        },
      ];
    if (kind === 'self') f.review.author = 'thinman-overseer[bot]';
    await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
    expect(f.records).toHaveLength(0);
    await expect(readFile(join(f.root, 'model.claim.json'))).rejects.toThrow();
    await f.input.controller.releaseAfterNormalCompletion();
  }
});

test('changed review at final readback rejects before claim', async () => {
  const f = await fixture();
  let reads = 0;
  f.input.readReview = async () =>
    ++reads === 1 ? f.review : { ...f.review, head: '0'.repeat(40) };
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
  expect(f.records).toHaveLength(0);
  await expect(readFile(join(f.root, 'model.claim.json'))).rejects.toThrow();
  await f.input.controller.releaseAfterNormalCompletion();
});

test('persistence failure retains consumed claim and prevents retry', async () => {
  const f = await fixture();
  f.input.store.createProviderAttempt = async () => false;
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow('persistence failed');
  expect(JSON.parse(await readFile(join(f.root, 'model.claim.json'), 'utf8')).phase).toBe('model');
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
  await f.input.controller.releaseAfterNormalCompletion();
});

test('shared mutable observations cannot change the first readback snapshot', async () => {
  for (const kind of ['review', 'prepared']) {
    const f = await fixture();
    let reads = 0;
    if (kind === 'review')
      f.input.readReview = async () => {
        if (++reads === 2) f.review.head = '0'.repeat(40);
        return f.review;
      };
    else {
      const shared = await f.input.readPrepared();
      f.input.readPrepared = async () => {
        if (++reads === 2) shared.runId = 'changed-run';
        return shared;
      };
    }
    await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
    expect(f.records).toHaveLength(0);
    await expect(readFile(join(f.root, 'model.claim.json'))).rejects.toThrow();
    await f.input.controller.releaseAfterNormalCompletion();
  }
});

test('submission time rather than review creation ID determines supersession', async () => {
  const f = await fixture();
  f.review.reviews = [
    ...f.review.reviews,
    {
      ...f.review.reviews[0],
      id: 100,
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-10-19T00:00:02Z',
    },
  ];
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
  expect(f.records).toHaveLength(0);
  await f.input.controller.releaseAfterNormalCompletion();
});

test('attempt readback mismatch retains consumed phase', async () => {
  const f = await fixture();
  f.input.store.listProviderAttempts = async () =>
    f.records.map(item => ({ ...item, runId: 'wrong-run' }));
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow('readback differs');
  expect(JSON.parse(await readFile(join(f.root, 'model.claim.json'), 'utf8')).phase).toBe('model');
  await f.input.controller.releaseAfterNormalCompletion();
});
