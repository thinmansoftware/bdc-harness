// Narrow supervised model transition. No provider, network or credential access.
// Operational callbacks must read actual current GitHub/run state under custody.
import { randomUUID } from 'node:crypto';
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

export async function claimSupervisedModelAttempt(input: {
  controller: SupervisedController;
  executionHash: string;
  preparedBindingHash: string;
  reviewHead: string;
  readPrepared: () => Promise<Readonly<SupervisedBinding>>;
  readReview: () => Promise<SupervisedPlanReview>;
  recheckExecution: () => Promise<void>;
  store: Pick<IWorkflowStore, 'listProviderAttempts' | 'createProviderAttempt'>;
}): Promise<Readonly<ProviderAttemptRecord>> {
  const { controller, store } = input;
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
  if (
    review.head !== input.reviewHead ||
    review.state !== 'OPEN' ||
    !review.complete ||
    review.author.toLowerCase() === gate ||
    !Array.isArray(review.reviews)
  )
    throw new Error('current complete independent plan review required');
  const latest = new Map<string, SupervisedPlanReview['reviews'][number]>();
  for (const item of review.reviews) {
    if (
      !Number.isSafeInteger(item.id) ||
      item.id <= 0 ||
      typeof item.login !== 'string' ||
      !/^[a-f0-9]{40}$/.test(item.head) ||
      typeof item.submittedAt !== 'string' ||
      !Number.isFinite(Date.parse(item.submittedAt)) ||
      !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED', 'PENDING'].includes(item.state)
    )
      throw new Error('malformed actual review record');
    if (item.state === 'COMMENTED' || item.state === 'PENDING') continue;
    const login = item.login.toLowerCase();
    const prior = latest.get(login);
    if (
      prior &&
      Date.parse(prior.submittedAt) === Date.parse(item.submittedAt) &&
      (prior.state !== item.state || prior.head !== item.head)
    )
      throw new Error('ambiguous actionable review chronology');
    if (!prior || Date.parse(prior.submittedAt) < Date.parse(item.submittedAt))
      latest.set(login, item);
  }
  const approval = latest.get(gate);
  if (
    !approval ||
    approval.state !== 'APPROVED' ||
    approval.head !== input.reviewHead ||
    [...latest.values()].some(item => item.state === 'CHANGES_REQUESTED')
  )
    throw new Error('independent exact-head approval missing or superseded');
  const approvalId = approval.id;
  if ((await store.listProviderAttempts(runId, 'implement')).length !== 0)
    throw new Error('supervised implementation attempt already exists');
  await input.recheckExecution();
  const finalPrepared = await input.readPrepared();
  const finalReview = await input.readReview();
  if (
    JSON.stringify(finalPrepared) !== preparedSnapshot ||
    JSON.stringify(finalReview) !== reviewSnapshot
  )
    throw new Error('supervised state changed before claim');
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
    attemptNumber: 1,
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
    supersedesAttemptId: null,
  });
  if (!(await store.createProviderAttempt(attempt)))
    throw new Error('provider attempt persistence failed; phase remains consumed');
  const persisted = await store.listProviderAttempts(runId, 'implement');
  if (
    persisted.length !== 1 ||
    Object.keys(attempt).some(
      key =>
        JSON.stringify(persisted[0][key as keyof ProviderAttemptRecord]) !==
        JSON.stringify(attempt[key as keyof ProviderAttemptRecord])
    )
  )
    throw new Error('provider attempt readback differs; phase remains consumed');
  await controller.assertOwned();
  return Object.freeze(attempt);
}
