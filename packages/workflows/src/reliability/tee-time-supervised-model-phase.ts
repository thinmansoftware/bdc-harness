// Narrow supervised model transition. No provider, network or credential access.
// Operational callbacks must read actual current GitHub/run state under custody.
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { TEE_TIME_SUPERVISED_POLICY } from '../../../paths/src/tee-time-supervised-policy';
import type { IWorkflowStore } from '../store';
import type { ProviderAttemptRecord } from './types';
import {
  claimSupervisedPhase,
  type SupervisedController,
  type SupervisedBinding,
} from './tee-time-supervised-bootstrap';

export interface SupervisedPlanReview {
  head: string;
  state: 'OPEN' | 'CLOSED';
  author: string;
  complete: boolean;
  reviews: readonly {
    id: number;
    login: string;
    state: string;
    head: string;
    submittedAt: string;
  }[];
}

// Pure shared review chronology. The caller must obtain actual current GitHub
// records; structurally valid data alone is never an operational grant.
export function approvedSupervisedPlanReview(review: SupervisedPlanReview, reviewHead: string): number {
  const gate = 'thinman-overseer[bot]';
  if (
    review.head !== reviewHead || review.state !== 'OPEN' || !review.complete ||
    review.author.toLowerCase() === gate || !Array.isArray(review.reviews)
  ) throw new Error('current complete independent plan review required');
  const latest = new Map<string, SupervisedPlanReview['reviews'][number]>();
  for (const item of review.reviews) {
    if (!Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.login !== 'string' ||
      !/^[a-f0-9]{40}$/.test(item.head) || typeof item.submittedAt !== 'string' ||
      !Number.isFinite(Date.parse(item.submittedAt)) ||
      !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED', 'PENDING'].includes(item.state))
      throw new Error('malformed actual review record');
    if (item.state === 'COMMENTED' || item.state === 'PENDING') continue;
    const login = item.login.toLowerCase();
    const prior = latest.get(login);
    if (prior && Date.parse(prior.submittedAt) === Date.parse(item.submittedAt) &&
      (prior.state !== item.state || prior.head !== item.head))
      throw new Error('ambiguous actionable review chronology');
    if (!prior || Date.parse(prior.submittedAt) < Date.parse(item.submittedAt)) latest.set(login, item);
  }
  const approval = latest.get(gate);
  if (!approval || approval.state !== 'APPROVED' || approval.head !== reviewHead ||
      [...latest.values()].some(item => item.state === 'CHANGES_REQUESTED'))
    throw new Error('independent exact-head approval missing or superseded');
  return approval.id;
}

// This is one explicitly reviewed successor, not a retry policy. The operational
// callback must observe the original files, paused run and Docker resources.
export interface SupervisedPredecessor {
  attemptId: string;
  completedAt: string;
  rowHash: string;
  executionHash: string;
  resultHash: string;
  claimHash: string;
  owner: string;
  manifestHash: string;
  lockHash: string;
}
export interface SupervisedReconciliation {
  predecessor: SupervisedPredecessor;
  runId: string;
  nodeId: 'implement';
  attemptNumber: 1;
  outcomeClass: 'quality';
  reasonCode: 'required_stage_failed';
  runPaused: true;
  resourcesAbsent: true;
  observedAt: number;
  expiresAt: number;
}
export interface SupervisedChainReconciliation {
  predecessors: readonly SupervisedPredecessor[];
  runId: string;
  runPaused: true;
  resourcesAbsent: true;
  observedAt: number;
  expiresAt: number;
}

export function supervisedAttemptHash(row: ProviderAttemptRecord): string {
  // Fixed projection includes every persisted field, including null values.
  const values = [row.attemptId, row.runId, row.nodeId, row.attemptNumber,
    row.provider, row.model, row.declaredProvider, row.declaredModel,
    row.requiredCapabilities, row.startedAt, row.completedAt, row.servedModelId,
    row.outcomeClass, row.reasonCode, row.resumeAt, row.supersedesAttemptId];
  return 'sha256:' + createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function predecessorIdentity(value: SupervisedPredecessor): string {
  if (!value || Object.keys(value).sort().join(',') !==
      'attemptId,claimHash,completedAt,executionHash,lockHash,manifestHash,owner,resultHash,rowHash' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.attemptId) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.completedAt) ||
      !Number.isFinite(Date.parse(value.completedAt)) ||
      Number(value.completedAt.slice(0, 4)) < 1 ||
      new Date(value.completedAt).toISOString() !== value.completedAt ||
      !/^teetime-auth-[a-f0-9]{12}$/.test(value.owner) ||
      ![value.rowHash, value.executionHash, value.resultHash, value.claimHash,
        value.manifestHash, value.lockHash].every(
        item => typeof item === 'string' && /^sha256:[a-f0-9]{64}$/.test(item)))
    throw new Error('closed predecessor binding required');
  return JSON.stringify([value.attemptId, value.completedAt, value.rowHash,
    value.executionHash, value.resultHash, value.claimHash, value.owner, value.manifestHash, value.lockHash]);
}

function reconcileSuccessor(
  expected: SupervisedPredecessor,
  observed: SupervisedReconciliation,
  rows: readonly ProviderAttemptRecord[],
  runId: string
): string {
  const identity = predecessorIdentity(expected);
  const now = Date.now();
  if (!observed || Object.keys(observed).sort().join(',') !==
      'attemptNumber,expiresAt,nodeId,observedAt,outcomeClass,predecessor,reasonCode,resourcesAbsent,runId,runPaused' ||
      predecessorIdentity(observed.predecessor) !== identity ||
      observed.runId !== runId || observed.nodeId !== 'implement' ||
      observed.attemptNumber !== 1 || observed.outcomeClass !== 'quality' ||
      observed.reasonCode !== 'required_stage_failed' ||
      observed.runPaused !== true || observed.resourcesAbsent !== true ||
      !Number.isSafeInteger(observed.observedAt) || !Number.isSafeInteger(observed.expiresAt) ||
      observed.observedAt > now + 5000 || observed.observedAt < now - 30000 ||
      observed.expiresAt <= now || observed.expiresAt <= observed.observedAt ||
      observed.expiresAt > observed.observedAt + 30000)
    throw new Error('fresh verified predecessor reconciliation required');
  const row = rows[0];
  if (rows.length !== 1 || !row || row.attemptId !== expected.attemptId ||
      row.runId !== runId || row.nodeId !== 'implement' || row.attemptNumber !== 1 ||
      row.completedAt !== expected.completedAt || row.outcomeClass !== 'quality' ||
      row.reasonCode !== 'required_stage_failed' || row.resumeAt !== null ||
      row.supersedesAttemptId !== null ||
      row.provider !== TEE_TIME_SUPERVISED_POLICY.provider ||
      row.model !== TEE_TIME_SUPERVISED_POLICY.model ||
      row.declaredProvider !== TEE_TIME_SUPERVISED_POLICY.provider ||
      row.declaredModel !== TEE_TIME_SUPERVISED_POLICY.model ||
      supervisedAttemptHash(row) !== expected.rowHash)
    throw new Error('sole completed predecessor differs');
  return identity;
}

function chainIdentity(entries: readonly SupervisedPredecessor[], count: 2 | 3 = 2): string {
  if (!Array.isArray(entries) || entries.length !== count)
    throw new Error('closed predecessor count required');
  const identities = entries.map(predecessorIdentity);
  if (new Set(entries.map(item => item.attemptId)).size !== count ||
      new Set(entries.map(item => item.owner)).size !== count ||
      entries.slice(1).some((item,index) => entries[index].completedAt >= item.completedAt))
    throw new Error('distinct chronological predecessor chain required');
  return JSON.stringify(identities);
}

function reconcileThird(expected: readonly SupervisedPredecessor[], observed: SupervisedChainReconciliation,
  rows: readonly ProviderAttemptRecord[], runId: string, count: 2 | 3 = 2): string {
  const identity = chainIdentity(expected, count);
  const now = Date.now();
  if (!observed || Object.keys(observed).sort().join(',') !==
      'expiresAt,observedAt,predecessors,resourcesAbsent,runId,runPaused' ||
      chainIdentity(observed.predecessors, count) !== identity || observed.runId !== runId ||
      observed.runPaused !== true || observed.resourcesAbsent !== true ||
      !Number.isSafeInteger(observed.observedAt) || !Number.isSafeInteger(observed.expiresAt) ||
      observed.observedAt > now + 5000 || observed.observedAt < now - 30000 ||
      observed.expiresAt <= now || observed.expiresAt <= observed.observedAt ||
      observed.expiresAt > observed.observedAt + 30000 || rows.length !== count)
    throw new Error('fresh predecessor chain reconciliation required');
  for (let index = 0; index < count; index++) {
    const prior = expected[index];
    const row = rows.find(item => item.attemptNumber === index + 1);
    if (!row || row.attemptId !== prior.attemptId || row.runId !== runId || row.nodeId !== 'implement' ||
        row.completedAt !== prior.completedAt || row.outcomeClass !== 'quality' ||
        row.reasonCode !== 'required_stage_failed' || row.resumeAt !== null ||
        row.supersedesAttemptId !== (index === 0 ? null : expected[index-1].attemptId) ||
        row.provider !== TEE_TIME_SUPERVISED_POLICY.provider || row.model !== TEE_TIME_SUPERVISED_POLICY.model ||
        row.declaredProvider !== TEE_TIME_SUPERVISED_POLICY.provider ||
        row.declaredModel !== TEE_TIME_SUPERVISED_POLICY.model || supervisedAttemptHash(row) !== prior.rowHash)
      throw new Error('terminal predecessor rows differ');
  }
  return identity;
}

export async function claimSupervisedModelAttempt(input: {
  controller: SupervisedController;
  executionHash: string;
  preparedBindingHash: string;
  reviewHead: string;
  readPrepared: () => Promise<Readonly<SupervisedBinding>>;
  readReview: () => Promise<SupervisedPlanReview>;
  recheckExecution: () => Promise<void>;
  store: Pick<IWorkflowStore, 'listProviderAttempts' | 'createProviderAttempt'>;
  transportRepairSuccessor?: {
    predecessors: readonly SupervisedPredecessor[];
    observe: () => Promise<SupervisedChainReconciliation>;
  };
  diagnosticSuccessor?: {
    predecessors: readonly SupervisedPredecessor[];
    observe: () => Promise<SupervisedChainReconciliation>;
  };
  successor?: {
    predecessor: SupervisedPredecessor;
    observe: () => Promise<SupervisedReconciliation>;
  };
}): Promise<Readonly<ProviderAttemptRecord>> {
  const { controller, store } = input;
  // Snapshot before any operational callback can mutate the caller's descriptor.
  const successor = input.successor ? {
    predecessor: Object.freeze({ ...input.successor.predecessor }),
    observe: input.successor.observe,
  } : undefined;
  if (successor) predecessorIdentity(successor.predecessor);
  const third = input.diagnosticSuccessor ? {
    predecessors: Object.freeze(input.diagnosticSuccessor.predecessors.map(item => Object.freeze({ ...item }))),
    observe: input.diagnosticSuccessor.observe,
  } : undefined;
  if (third) chainIdentity(third.predecessors);
  const fourth = input.transportRepairSuccessor ? {
    predecessors: Object.freeze(input.transportRepairSuccessor.predecessors.map(item => Object.freeze({ ...item }))),
    observe: input.transportRepairSuccessor.observe,
  } : undefined;
  if (fourth) chainIdentity(fourth.predecessors, 3);
  if ([successor, third, fourth].filter(Boolean).length > 1) throw new Error('mixed successor modes rejected');
  if (
    !/^sha256:[a-f0-9]{64}$/.test(input.executionHash) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.preparedBindingHash) ||
    !/^[a-f0-9]{40}$/.test(input.reviewHead) ||
    controller.bindingHash !== input.executionHash
  )
    throw new Error('closed supervised model execution identity required');
  await controller.assertOwned();
  await input.recheckExecution();
  const prepared = await input.readPrepared();
  const preparedSnapshot = JSON.stringify(prepared);
  const runId = prepared.runId;
  if (prepared.bindingHash !== input.preparedBindingHash)
    throw new Error('current prepared binding differs');
  const review = await input.readReview();
  const reviewSnapshot = JSON.stringify(review);
  const gate = 'thinman-overseer[bot]';
  const approvalId = approvedSupervisedPlanReview(review, input.reviewHead);
  const previous = structuredClone(await store.listProviderAttempts(runId, 'implement'));
  const fourthSnapshot = fourth
    ? reconcileThird(fourth.predecessors, structuredClone(await fourth.observe()), previous, runId, 3) : null;
  const thirdSnapshot = third
    ? reconcileThird(third.predecessors, structuredClone(await third.observe()), previous, runId) : null;
  const predecessorSnapshot = successor
    ? reconcileSuccessor(successor.predecessor, structuredClone(await successor.observe()), previous, runId)
    : null;
  if (!successor && !third && !fourth && previous.length !== 0)
    throw new Error('supervised implementation attempt already exists');
  await input.recheckExecution();
  const finalPrepared = await input.readPrepared();
  const finalReview = await input.readReview();
  if (
    JSON.stringify(finalPrepared) !== preparedSnapshot ||
    JSON.stringify(finalReview) !== reviewSnapshot
  )
    throw new Error('supervised state changed before claim');
  if (successor) {
    const observed = structuredClone(await successor.observe());
    const rows = await store.listProviderAttempts(runId, 'implement');
    if (reconcileSuccessor(successor.predecessor, observed, rows, runId) !== predecessorSnapshot)
      throw new Error('predecessor changed before successor claim');
  }
  if (third) {
    const observed = structuredClone(await third.observe());
    const rows = structuredClone(await store.listProviderAttempts(runId, 'implement'));
    if (reconcileThird(third.predecessors, observed, rows, runId) !== thirdSnapshot)
      throw new Error('predecessor chain changed before claim');
  }
  if (fourth) {
    const observed = structuredClone(await fourth.observe());
    const rows = structuredClone(await store.listProviderAttempts(runId, 'implement'));
    if (reconcileThird(fourth.predecessors, observed, rows, runId, 3) !== fourthSnapshot)
      throw new Error('transport repair history changed before claim');
  }
  await claimSupervisedPhase(controller, 'model', {
    bindingHash: input.executionHash,
    reviewId: approvalId,
    reviewHead: input.reviewHead,
    reviewer: gate,
    state: 'APPROVED',
  });
  const attempt: ProviderAttemptRecord = Object.freeze({
    attemptId: randomUUID(),
    runId,
    nodeId: 'implement',
    attemptNumber: fourth ? 4 : third ? 3 : successor ? 2 : 1,
    provider: TEE_TIME_SUPERVISED_POLICY.provider,
    model: TEE_TIME_SUPERVISED_POLICY.model,
    declaredProvider: TEE_TIME_SUPERVISED_POLICY.provider,
    declaredModel: TEE_TIME_SUPERVISED_POLICY.model,
    requiredCapabilities: Object.freeze(['text_generation'] as const),
    startedAt: new Date().toISOString(),
    completedAt: null,
    servedModelId: null,
    outcomeClass: null,
    reasonCode: null,
    resumeAt: null,
    supersedesAttemptId: fourth ? fourth.predecessors[2].attemptId : third ? third.predecessors[1].attemptId : successor ? successor.predecessor.attemptId : null,
  });
  if (!(await store.createProviderAttempt(attempt)))
    throw new Error('provider attempt persistence failed; phase remains consumed');
  const persisted = await store.listProviderAttempts(runId, 'implement');
  const inserted = persisted.find(row => row.attemptId === attempt.attemptId);
  if (
    persisted.length !== (fourth ? 4 : third ? 3 : successor ? 2 : 1) || !inserted ||
    (fourth && fourth.predecessors.some(prior => {
      const row = persisted.find(item => item.attemptId === prior.attemptId);
      return !row || supervisedAttemptHash(row) !== prior.rowHash;
    })) ||
    (third && third.predecessors.some(prior => {
      const row = persisted.find(item => item.attemptId === prior.attemptId);
      return !row || supervisedAttemptHash(row) !== prior.rowHash;
    })) ||
    (successor && supervisedAttemptHash(persisted.find(row => row.attemptId ===
      successor.predecessor.attemptId)!) !== successor.predecessor.rowHash) ||
    Object.keys(attempt).some(
      key =>
        JSON.stringify(inserted[key as keyof ProviderAttemptRecord]) !==
        JSON.stringify(attempt[key as keyof ProviderAttemptRecord])
    )
  )
    throw new Error('provider attempt readback differs; phase remains consumed');
  await controller.assertOwned();
  return Object.freeze(attempt);
}
