import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSupervisedController } from './tee-time-supervised-bootstrap';
import {
  claimSupervisedModelAttempt,
  supervisedAttemptHash,
  type SupervisedPlanReview,
  type SupervisedPredecessor,
  type SupervisedReconciliation,
} from './tee-time-supervised-model-phase';
import type { ProviderAttemptRecord } from './types';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

async function successorFixture() {
  const f = await fixture();
  const previous: ProviderAttemptRecord = {
    attemptId: 'ec3fd06e-5f27-4eda-9af1-2f759e4157ae', runId: 'prepared-run',
    nodeId: 'implement', attemptNumber: 1, provider: 'codex-native-strict',
    model: 'gpt-5.6-sol', declaredProvider: 'codex-native-strict', declaredModel: 'gpt-5.6-sol',
    requiredCapabilities: ['text_generation'], startedAt: '2026-10-19T02:40:48.408Z',
    completedAt: '2026-10-19T02:43:09.062Z', servedModelId: null,
    outcomeClass: 'quality', reasonCode: 'required_stage_failed', resumeAt: null,
    supersedesAttemptId: null,
  };
  f.records.push(previous);
  const predecessor: SupervisedPredecessor = {
    attemptId: previous.attemptId, completedAt: previous.completedAt!,
    rowHash: supervisedAttemptHash(previous), executionHash: 'sha256:' + '1'.repeat(64),
    resultHash: 'sha256:' + '2'.repeat(64), claimHash: 'sha256:' + '3'.repeat(64),
    owner: 'teetime-auth-5eca42816a98',
    manifestHash: 'sha256:'+'4'.repeat(64), lockHash: 'sha256:'+'5'.repeat(64),
  };
  const observe = async (): Promise<SupervisedReconciliation> => ({
    predecessor: { ...predecessor }, runId: 'prepared-run', nodeId: 'implement',
    attemptNumber: 1, outcomeClass: 'quality', reasonCode: 'required_stage_failed',
    runPaused: true, resourcesAbsent: true, observedAt: Date.now(), expiresAt: Date.now() + 20000,
  });
  return { ...f, predecessor, previous, input: { ...f.input, successor: { predecessor, observe } } };
}

test('fresh reconciled successor preserves terminal predecessor and links attempt 2', async () => {
  const f = await successorFixture();
  const original = supervisedAttemptHash(f.previous);
  const next = await claimSupervisedModelAttempt(f.input);
  expect(next.attemptNumber).toBe(2);
  expect(next.supersedesAttemptId).toBe(f.previous.attemptId);
  expect(supervisedAttemptHash(f.records[0])).toBe(original);
  expect(f.records).toHaveLength(2);
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
  await f.input.controller.releaseAfterNormalCompletion();
});

async function thirdFixture() {
  const f = await successorFixture();
  const second: ProviderAttemptRecord = {...f.previous,
    attemptId:'2a99ad54-3b2b-45ae-a923-6c1a7073ac30',attemptNumber:2,
    startedAt:'2026-10-19T03:27:24.370Z',completedAt:'2026-10-19T03:27:36.872Z',
    supersedesAttemptId:f.previous.attemptId};
  f.records.push(second);
  const entries = [{...f.predecessor},{...f.predecessor,attemptId:second.attemptId,
    completedAt:second.completedAt!,rowHash:supervisedAttemptHash(second),owner:'teetime-auth-d2a4ae153136'}];
  const {successor: _old, ...base} = f.input;
  return {...f,entries,second,input:{...base,diagnosticSuccessor:{predecessors:entries,
    observe:async () => ({predecessors:entries.map(item=>({...item})),runId:'prepared-run',
      runPaused:true as const,resourcesAbsent:true as const,observedAt:Date.now(),expiresAt:Date.now()+20000})}}};
}

test('closed third claim preserves both histories and links only the second attempt',async()=>{
  const f=await thirdFixture();const hashes=f.records.map(supervisedAttemptHash);
  const next=await claimSupervisedModelAttempt(f.input);
  expect(next.attemptNumber).toBe(3);expect(next.supersedesAttemptId).toBe(f.second.attemptId);
  expect(f.records.slice(0,2).map(supervisedAttemptHash)).toEqual(hashes);
  expect(f.records).toHaveLength(3);
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
  await f.input.controller.releaseAfterNormalCompletion();
});

test('third claim rejects chain, row, freshness and ownership drift before consumption',async()=>{
  for(const kind of ['reversed','duplicate','owner','extra','missing','supersession','active','row',
    'stale','resources','paused','expiry']){
    const f=await thirdFixture();const observe=f.input.diagnosticSuccessor.observe;
    if(kind==='reversed')f.entries.reverse();
    if(kind==='duplicate')f.entries[1].attemptId=f.entries[0].attemptId;
    if(kind==='owner')f.entries[1].owner=f.entries[0].owner;
    if(kind==='extra')f.entries.push({...f.entries[1]});
    if(kind==='missing')f.records.pop();
    if(kind==='supersession')Object.assign(f.second,{supersedesAttemptId:null});
    if(kind==='active')Object.assign(f.second,{completedAt:null});
    if(kind==='row')Object.assign(f.previous,{declaredModel:'foreign'});
    f.input.diagnosticSuccessor.observe=async()=>{
      const value=await observe();
      if(kind==='stale')value.observedAt-=60000;
      if(kind==='resources')Object.assign(value,{resourcesAbsent:false});
      if(kind==='paused')Object.assign(value,{runPaused:false});
      if(kind==='expiry')value.expiresAt=Date.now()-1;
      return value;
    };
    await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
    await expect(readFile(join(f.root,'model.claim.json'))).rejects.toThrow();
    await f.input.controller.releaseAfterNormalCompletion();
  }
});

test('third claim snapshots both descriptors and rejects either changed predecessor on readback',async()=>{
  for(const index of [0,1]){
    const f=await thirdFixture();let checks=0;
    f.input.recheckExecution=async()=>{if(++checks===2)f.entries[index].resultHash='sha256:'+'0'.repeat(64);};
    await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
    await expect(readFile(join(f.root,'model.claim.json'))).rejects.toThrow();
    await f.input.controller.releaseAfterNormalCompletion();
    const g=await thirdFixture();const create=g.input.store.createProviderAttempt;
    g.input.store.createProviderAttempt=async(attempt)=>{
      const created=await create(attempt);Object.assign(g.records[index],{reasonCode:'changed'});return created;
    };
    await expect(claimSupervisedModelAttempt(g.input)).rejects.toThrow('readback differs');
    expect(JSON.parse(await readFile(join(g.root,'model.claim.json'),'utf8')).phase).toBe('model');
    await g.input.controller.releaseAfterNormalCompletion();
  }
});

test('stale, forged, uncertain and failed resource observations reject before claim', async () => {
  for (const kind of ['stale', 'future', 'expiry', 'result', 'claim', 'execution', 'owner',
    'run', 'resources', 'paused', 'extra', 'query-failure']) {
    const f = await successorFixture();
    const initial = f.input.successor.observe;
    f.input.successor.observe = async () => {
      if (kind === 'query-failure') throw new Error('Docker observation failed');
      const value = await initial();
      if (kind === 'stale') value.observedAt -= 60000;
      if (kind === 'future') value.observedAt += 60000;
      if (kind === 'expiry') value.expiresAt = Date.now() - 1;
      if (kind === 'result') value.predecessor.resultHash = 'sha256:' + '0'.repeat(64);
      if (kind === 'claim') value.predecessor.claimHash = 'sha256:' + '0'.repeat(64);
      if (kind === 'execution') value.predecessor.executionHash = 'sha256:' + '0'.repeat(64);
      if (kind === 'owner') value.predecessor.owner = 'teetime-auth-000000000000';
      if (kind === 'run') value.runId = 'foreign-run';
      if (kind === 'resources') Object.assign(value, { resourcesAbsent: false });
      if (kind === 'paused') Object.assign(value, { runPaused: false });
      if (kind === 'extra') Object.assign(value, { ignored: true });
      return value;
    };
    await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
    expect(f.records).toHaveLength(1);
    await expect(readFile(join(f.root, 'model.claim.json'))).rejects.toThrow();
    await f.input.controller.releaseAfterNormalCompletion();
  }
});

test('nonterminal, changed or duplicated predecessor rows reject before claim', async () => {
  for (const kind of ['completion', 'outcome', 'reason', 'provider', 'link', 'capabilities', 'successor']) {
    const f = await successorFixture();
    if (kind === 'completion') Object.assign(f.previous, { completedAt: null });
    if (kind === 'outcome') Object.assign(f.previous, { outcomeClass: 'success' });
    if (kind === 'reason') Object.assign(f.previous, { reasonCode: 'execution_completed' });
    if (kind === 'provider') Object.assign(f.previous, { provider: 'foreign' });
    if (kind === 'link') Object.assign(f.previous, { supersedesAttemptId: 'foreign' });
    if (kind === 'capabilities') Object.assign(f.previous, { requiredCapabilities: [] });
    if (kind === 'successor') f.records.push({ ...f.previous, attemptNumber: 2 });
    await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
    await expect(readFile(join(f.root, 'model.claim.json'))).rejects.toThrow();
    await f.input.controller.releaseAfterNormalCompletion();
  }
});

test('predecessor mutation during final recheck cannot consume successor claim', async () => {
  const f = await successorFixture();
  let reads = 0;
  const initial = f.input.successor.observe;
  f.input.successor.observe = async () => {
    if (++reads === 2) Object.assign(f.previous, { servedModelId: 'changed' });
    return initial();
  };
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
  await expect(readFile(join(f.root, 'model.claim.json'))).rejects.toThrow();
  await f.input.controller.releaseAfterNormalCompletion();
});

test('concurrent successor claims cannot insert two attempts', async () => {
  const f = await successorFixture();
  const settled = await Promise.allSettled([
    claimSupervisedModelAttempt(f.input), claimSupervisedModelAttempt(f.input),
  ]);
  expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(f.records).toHaveLength(2);
  expect(f.records[1].supersedesAttemptId).toBe(f.previous.attemptId);
  await f.input.controller.releaseAfterNormalCompletion();
});

test('initial callbacks cannot replace the supplied predecessor identity', async () => {
  const f = await successorFixture();
  const initial = f.input.recheckExecution;
  f.input.recheckExecution = async () => {
    f.predecessor.resultHash = 'sha256:' + '0'.repeat(64);
    return initial();
  };
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
  await expect(readFile(join(f.root, 'model.claim.json'))).rejects.toThrow();
  await f.input.controller.releaseAfterNormalCompletion();
});

test('returned reconciliation is snapshotted before subsequent store callbacks', async () => {
  const f = await successorFixture();
  const initial = f.input.successor.observe;
  let observation: SupervisedReconciliation | undefined;
  let reads = 0;
  f.input.successor.observe = async () => {
    observation = await initial();
    if (++reads === 2) Object.assign(observation, { resourcesAbsent: false });
    return observation;
  };
  const list = f.input.store.listProviderAttempts;
  f.input.store.listProviderAttempts = async () => {
    // A shared mutable false observation must not become true after it returned.
    if (observation) Object.assign(observation, { resourcesAbsent: true });
    return list();
  };
  await expect(claimSupervisedModelAttempt(f.input)).rejects.toThrow();
  await expect(readFile(join(f.root, 'model.claim.json'))).rejects.toThrow();
  await f.input.controller.releaseAfterNormalCompletion();
});

test('complete attempt projection detects drift in every persisted field', async () => {
  const f = await successorFixture();
  const expected = supervisedAttemptHash(f.previous);
  for (const key of Object.keys(f.previous) as (keyof ProviderAttemptRecord)[]) {
    const changed = { ...f.previous, [key]: key === 'requiredCapabilities' ? [] : 'different' };
    expect(supervisedAttemptHash(changed as ProviderAttemptRecord)).not.toBe(expected);
  }
  await f.input.controller.releaseAfterNormalCompletion();
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
