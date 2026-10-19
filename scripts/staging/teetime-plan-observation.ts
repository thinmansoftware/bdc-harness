// Parse only a live trusted-operator SSH packet, never a caller-selected file.
// This cannot authenticate arbitrary callers or substitute for current run checks.
import { createHash } from 'node:crypto';
import type { SupervisedPlanReview } from '../../packages/workflows/src/reliability/tee-time-supervised-model-phase';

export interface ObservationBinding {
  nonce: string;
  baseSha: string;
  executionHash: string;
  preparedBindingHash: string;
  runId: string;
  reviewHead: string;
}

export function readPlanObservation(
  raw: Buffer,
  expected: ObservationBinding,
  nowMs: number
): {
  observationHash: string;
  expiresAtMs: number;
  review: SupervisedPlanReview;
} {
  if (
    !Buffer.isBuffer(raw) ||
    !raw.length ||
    raw.length > 65536 ||
    raw.some(byte => byte > 127) ||
    !Number.isSafeInteger(nowMs)
  )
    throw new Error('bounded fresh operator observation required');
  const value = JSON.parse(raw.toString('ascii'));
  const keys = [
    'version',
    'kind',
    'remote',
    'nonce',
    'remoteStagingSha',
    'observedAtMs',
    'expiresAtMs',
    'executionHash',
    'preparedBindingHash',
    'runId',
    'repository',
    'pullRequest',
    'packagePath',
    'review',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',') ||
    JSON.stringify(value) !== raw.toString('ascii')
  )
    throw new Error('closed observation packet required');
  if (
    value.version !== 1 ||
    value.kind !== 'tee-time-plan-observation' ||
    value.remote !== 'bdc-server' ||
    value.repository !== 'thinmansoftware/bdc-xo' ||
    value.pullRequest !== 3392 ||
    value.packagePath !== 'docs/tee-time/supervised-demo-execution.json' ||
    value.nonce !== expected.nonce ||
    value.remoteStagingSha !== expected.baseSha ||
    !/^[a-f0-9]{40}$/.test(expected.baseSha) ||
    !/^[a-f0-9]{32}$/.test(expected.nonce) ||
    value.executionHash !== expected.executionHash ||
    !/^sha256:[a-f0-9]{64}$/.test(expected.executionHash) ||
    value.preparedBindingHash !== expected.preparedBindingHash ||
    !/^sha256:[a-f0-9]{64}$/.test(expected.preparedBindingHash) ||
    value.runId !== expected.runId ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(expected.runId)
  )
    throw new Error('observation invocation binding differs');
  if (
    !Number.isSafeInteger(value.observedAtMs) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs - value.observedAtMs !== 60000 ||
    nowMs >= value.expiresAtMs ||
    value.observedAtMs > nowMs + 5000
  )
    throw new Error('observation expired or clock differs');
  const review = value.review;
  if (
    !review ||
    Object.keys(review).sort().join(',') !== 'author,complete,head,reviews,state' ||
    review.head !== expected.reviewHead ||
    !/^[a-f0-9]{40}$/.test(expected.reviewHead) ||
    review.state !== 'OPEN' ||
    review.complete !== true ||
    typeof review.author !== 'string' ||
    !Array.isArray(review.reviews) ||
    review.reviews.length > 2000
  )
    throw new Error('complete bound review observation required');
  const records = review.reviews.map((item: Record<string, unknown>) => {
    if (!item || Object.keys(item).sort().join(',') !== 'head,id,login,state,submittedAt')
      throw new Error('closed review record required');
    return Object.freeze({ ...item });
  });
  // The phase helper performs actionable chronology and independent-actor checks.
  return Object.freeze({
    observationHash: 'sha256:' + createHash('sha256').update(raw).digest('hex'),
    expiresAtMs: value.expiresAtMs,
    review: Object.freeze({ ...review, reviews: Object.freeze(records) }) as SupervisedPlanReview,
  });
}
