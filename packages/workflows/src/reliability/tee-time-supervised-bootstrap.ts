// One operator-owned staging controller. No provider, GitHub or server import.
// Flush supports process-crash fencing; power-loss durability is not attested.
// One root belongs to ONE immutable run/node/attempt binding. It is exclusively
// writable by the trusted operator, never a model/test mount. A privileged actor
// concurrently replacing that root is outside the filesystem custody guarantee.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IWorkflowStore } from '../store';
import type { WorkflowDefinition } from '../schemas/workflow';
import type { RunAuthorityRecord } from './types';
import { persistRunAuthority } from './run-authority';
import { captureRuntimeRevisions } from './runtime-revisions';
import { policyDigest, TEE_TIME_REPOSITORY } from '../../../paths/src/tee-time-policy';
import {
  supervisedRunPolicy,
  TEE_TIME_SUPERVISED_WO,
  TEE_TIME_SUPERVISED_WORKFLOW,
  TEE_TIME_SUPERVISED_POLICY,
} from '../../../paths/src/tee-time-supervised-policy';

export interface SupervisedReview {
  bindingHash: string;
  reviewId: number;
  reviewHead: string;
  reviewer: string;
  state: 'APPROVED';
}
export interface SupervisedController {
  readonly root: string;
  readonly bindingHash: string;
  assertOwned(): Promise<void>;
  releaseAfterNormalCompletion(): Promise<void>;
}
const active = new WeakSet<SupervisedController>();
const busy = new WeakSet<SupervisedController>();
const digest = /^sha256:[a-f0-9]{64}$/;

async function ownedDirectory(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(root) !== (await realpath(root)))
    throw new Error('ordinary canonical control root required');
}
async function exclusiveFlushed(path: string, bytes: Buffer): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  // Deliberately leave partial files on write/flush failure: no automatic retry.
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !(await readFile(path)).equals(bytes))
    throw new Error('exclusive flushed control file readback failed');
}

export async function acquireSupervisedController(
  root: string,
  bindingHash: string
): Promise<SupervisedController> {
  if (!digest.test(bindingHash)) throw new Error('exact binding hash required');
  await ownedDirectory(root);
  const path = join(root, 'controller.lock');
  const bytes = Buffer.from(
    JSON.stringify({ version: 1, bindingHash, owner: randomUUID(), pid: process.pid }) + '\n'
  );
  await exclusiveFlushed(path, bytes);
  let released = false;
  const controller: SupervisedController = {
    root,
    bindingHash,
    async assertOwned(): Promise<void> {
      if (released || !active.has(controller)) throw new Error('inactive controller');
      await ownedDirectory(root);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || !(await readFile(path)).equals(bytes))
        throw new Error('controller lock changed; explicit reconciliation required');
    },
    async releaseAfterNormalCompletion(): Promise<void> {
      await exclusiveOperation(controller, async () => {
        await controller.assertOwned();
        await unlink(path);
        released = true;
        active.delete(controller);
      });
    },
  };
  active.add(controller);
  return Object.freeze(controller);
}

async function exclusiveOperation(
  controller: SupervisedController,
  operation: () => Promise<void>
): Promise<void> {
  if (!active.has(controller) || busy.has(controller))
    throw new Error('inactive or busy controller');
  busy.add(controller);
  try {
    await operation();
  } finally {
    busy.delete(controller);
  }
}

// Caller must read actual GitHub review/head/binding immediately before this
// function. Structurally valid input alone is never a review or model grant.
export async function claimSupervisedPhase(
  controller: SupervisedController,
  phase: 'model' | 'publish',
  review: SupervisedReview
): Promise<void> {
  if (!active.has(controller) || !['model', 'publish'].includes(phase))
    throw new Error('owned controller and closed phase required');
  if (
    !review ||
    Object.keys(review).sort().join(',') !== 'bindingHash,reviewHead,reviewId,reviewer,state' ||
    review.bindingHash !== controller.bindingHash ||
    !digest.test(review.bindingHash) ||
    review.state !== 'APPROVED' ||
    !Number.isSafeInteger(review.reviewId) ||
    review.reviewId <= 0 ||
    !/^[a-f0-9]{40}$/.test(review.reviewHead) ||
    !/^[A-Za-z0-9][A-Za-z0-9_\[\]-]{0,99}$/.test(review.reviewer)
  )
    throw new Error('exact approved review binding required');
  const receipt = Buffer.from(
    JSON.stringify({
      version: 1,
      phase,
      bindingHash: review.bindingHash,
      reviewId: review.reviewId,
      reviewHead: review.reviewHead,
      reviewer: review.reviewer,
      state: review.state,
    }) + '\n'
  );
  await exclusiveOperation(controller, async () => {
    await controller.assertOwned();
    await exclusiveFlushed(join(controller.root, phase + '.claim.json'), receipt);
    await controller.assertOwned();
  });
}

// Identity capture only. A generic executor must fail rather than invoke this as
// a build workflow. The supervised entry never starts that executor.
const SUPERVISED_WORKFLOW_IDENTITY: WorkflowDefinition = Object.freeze({
  name: TEE_TIME_SUPERVISED_WORKFLOW,
  description: 'Identity-only supervised staging walkthrough; no generic execution',
  provider: TEE_TIME_SUPERVISED_POLICY.provider,
  model: TEE_TIME_SUPERVISED_POLICY.model,
  target_repo: TEE_TIME_REPOSITORY,
  nodes: [{ id: 'operator-only', bash: 'exit 77' }],
});
interface CodebaseIdentity {
  id: string;
  name: string;
  repository_url: string | null;
  default_cwd: string;
  ai_assistant_type: string;
}
interface ConversationIdentity {
  id: string;
  codebase_id: string | null;
  ai_assistant_type: string;
  cwd: string | null;
}
export interface SupervisedPreparationApi {
  store: IWorkflowStore;
  getCodebase(id: string): Promise<CodebaseIdentity | null>;
  createCodebase(data: {
    name: string;
    repository_url: string;
    default_cwd: string;
    ai_assistant_type: string;
  }): Promise<CodebaseIdentity>;
  getOrCreateConversation(
    platform: string,
    id: string,
    codebaseId: string
  ): Promise<ConversationIdentity>;
  updateConversation(id: string, data: { cwd: string }): Promise<void>;
  getConversationById(id: string): Promise<ConversationIdentity | null>;
  pauseWorkflowRunByOperator(id: string): Promise<void>;
  artifactsPath(runId: string): string;
}
export interface SupervisedGitObservation {
  headCommit: string;
  headBranch: string;
  localStagingCommit: string;
  remoteStagingCommit: string;
}
export interface SupervisedPreparation {
  preparationRoot: string;
  repositoryRoot: string;
  worktreePath: string;
  dispatchId: string;
  caseHash: string;
  specSource: string;
  specRevision: string;
  specBytes: Uint8Array;
  baseSha: string;
  runScopeSha: string;
  headBranch: string;
  observe(): Promise<SupervisedGitObservation>;
}
export interface SupervisedBinding {
  version: 1;
  runId: string;
  caseHash: string;
  authorityHash: string;
  bindingHash: string;
}

// Called only after the operator entry validates isolation before DB imports and
// verifies the actual SQLite connection durability. No model/provider call here.
export async function prepareSupervisedRun(
  api: SupervisedPreparationApi,
  input: SupervisedPreparation
): Promise<SupervisedBinding> {
  input = { ...input, specBytes: Uint8Array.from(input.specBytes) };
  if (
    !digest.test(input.caseHash) ||
    !/^[a-f0-9]{40}$/.test(input.specRevision) ||
    !/^[a-f0-9]{40}$/.test(input.baseSha) ||
    !/^[a-f0-9]{40}$/.test(input.runScopeSha) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.dispatchId) ||
    input.headBranch !== 'demo/simulated-walkthrough-01' ||
    input.specSource !==
      'github:thinmansoftware/bdc-xo:docs/work-orders/' + TEE_TIME_SUPERVISED_WO + '.md' ||
    input.specBytes.byteLength === 0 ||
    input.specBytes.byteLength > 65536
  )
    throw new Error('closed supervised preparation identity required');
  await ownedDirectory(input.preparationRoot);
  function verifyObservation(actual: SupervisedGitObservation): void {
    if (
      actual.headCommit !== input.runScopeSha ||
      actual.headBranch !== input.headBranch ||
      actual.localStagingCommit !== input.baseSha ||
      actual.remoteStagingCommit !== input.baseSha
    )
      throw new Error('constrained actual worktree/staging observation differs');
  }
  verifyObservation(await input.observe());
  // The entry invokes this inside exclusive root ownership. Failure after this
  // point remains consumed even if no run row was returned; never guess/retry.
  await exclusiveFlushed(
    join(input.preparationRoot, 'prepare.claim.json'),
    Buffer.from(
      JSON.stringify({ version: 1, dispatchId: input.dispatchId, caseHash: input.caseHash }) + '\n'
    )
  );
  const codebase = await api.createCodebase({
    name: TEE_TIME_REPOSITORY,
    repository_url: 'https://github.com/' + TEE_TIME_REPOSITORY + '.git',
    default_cwd: input.repositoryRoot,
    ai_assistant_type: 'codex',
  });
  if (
    !codebase.id ||
    codebase.name !== TEE_TIME_REPOSITORY ||
    codebase.ai_assistant_type !== 'codex' ||
    codebase.default_cwd !== input.repositoryRoot ||
    codebase.repository_url !== 'https://github.com/' + TEE_TIME_REPOSITORY + '.git'
  )
    throw new Error('actual isolated codebase differs');
  const conversation = await api.getOrCreateConversation(
    'tee-time-supervised',
    input.dispatchId,
    codebase.id
  );
  if (
    !conversation.id ||
    conversation.codebase_id !== codebase.id ||
    conversation.ai_assistant_type !== 'codex' ||
    (conversation.cwd !== null && conversation.cwd !== input.worktreePath)
  )
    throw new Error('foreign conversation rejected');
  if (conversation.cwd === null)
    await api.updateConversation(conversation.id, { cwd: input.worktreePath });
  const verified = await api.getConversationById(conversation.id);
  if (
    verified?.codebase_id !== codebase.id ||
    verified.cwd !== input.worktreePath ||
    verified.ai_assistant_type !== 'codex'
  )
    throw new Error('conversation readback differs');
  const revisions = await captureRuntimeRevisions(SUPERVISED_WORKFLOW_IDENTITY);
  const policy = supervisedRunPolicy(codebase.id, policyDigest(SUPERVISED_WORKFLOW_IDENTITY));
  const run = await api.store.createWorkflowRun({
    workflow_name: TEE_TIME_SUPERVISED_WORKFLOW,
    conversation_id: conversation.id,
    codebase_id: codebase.id,
    user_message: TEE_TIME_SUPERVISED_WO,
    working_path: input.worktreePath,
    metadata: { execution_policy: policy, supervised_case_hash: input.caseHash },
  });
  if (!run.id || run.status !== 'pending') throw new Error('actual pending run required');
  const authority = await persistRunAuthority(api.store, api.artifactsPath(run.id), {
    runId: run.id,
    dispatchId: input.dispatchId,
    woId: TEE_TIME_SUPERVISED_WO,
    specSource: input.specSource,
    specRevision: input.specRevision,
    specBytes: input.specBytes,
    workflowName: TEE_TIME_SUPERVISED_WORKFLOW,
    codebaseId: codebase.id,
    canonicalRemote: 'https://github.com/' + TEE_TIME_REPOSITORY + '.git',
    baseBranch: 'staging',
    baseSha: input.baseSha,
    runScopeSha: input.runScopeSha,
    headBranch: input.headBranch,
    worktreePath: input.worktreePath,
    ...revisions,
    createdAt: new Date().toISOString(),
  });
  if (policyDigest(await api.store.getRunAuthority(run.id)) !== policyDigest(authority))
    throw new Error('actual authority readback differs');
  await api.store.updateWorkflowRun(run.id, { status: 'running' });
  if ((await api.store.getWorkflowRun(run.id))?.status !== 'running')
    throw new Error('running readback differs');
  await api.pauseWorkflowRunByOperator(run.id);
  const paused = await api.store.getWorkflowRun(run.id);
  if (
    paused?.status !== 'paused' ||
    paused.metadata?.paused_by !== 'operator' ||
    policyDigest(paused.metadata.execution_policy) !== policyDigest(policy)
  )
    throw new Error('actual operator pause readback differs');
  verifyObservation(await input.observe());
  const authorityHash = policyDigest(authority);
  const binding = {
    version: 1 as const,
    runId: run.id,
    caseHash: input.caseHash,
    authorityHash,
    bindingHash: policyDigest({ runId: run.id, caseHash: input.caseHash, authorityHash }),
  };
  await exclusiveFlushed(
    join(input.preparationRoot, 'prepared-binding.json'),
    Buffer.from(JSON.stringify(binding) + '\n')
  );
  return Object.freeze(binding);
}

export async function readSupervisedBinding(
  api: SupervisedPreparationApi,
  input: SupervisedPreparation
): Promise<Readonly<SupervisedBinding>> {
  input = { ...input, specBytes: Uint8Array.from(input.specBytes) };
  await ownedDirectory(input.preparationRoot);
  const path = join(input.preparationRoot, 'prepared-binding.json');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new Error('bounded prepared binding required');
  const raw = await readFile(path);
  const value: SupervisedBinding = JSON.parse(raw.toString('utf8'));
  if (
    Object.keys(value).sort().join(',') !== 'authorityHash,bindingHash,caseHash,runId,version' ||
    JSON.stringify(value) + '\n' !== raw.toString('utf8') ||
    value.version !== 1 ||
    value.caseHash !== input.caseHash ||
    !digest.test(value.authorityHash) ||
    !digest.test(value.bindingHash) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.runId)
  )
    throw new Error('closed canonical prepared binding required');
  const run = await api.store.getWorkflowRun(value.runId);
  const authority = await api.store.getRunAuthority(value.runId);
  if (
    !run ||
    !authority ||
    run.status !== 'paused' ||
    run.metadata?.paused_by !== 'operator' ||
    run.workflow_name !== TEE_TIME_SUPERVISED_WORKFLOW ||
    run.codebase_id !== authority.codebaseId ||
    run.working_path !== input.worktreePath ||
    authority.runId !== run.id ||
    authority.workflowName !== run.workflow_name ||
    authority.woId !== TEE_TIME_SUPERVISED_WO ||
    authority.dispatchId !== input.dispatchId ||
    authority.specSource !== input.specSource ||
    authority.specRevision !== input.specRevision ||
    authority.specHash !== 'sha256:' + createHash('sha256').update(input.specBytes).digest('hex') ||
    authority.baseSha !== input.baseSha ||
    authority.runScopeSha !== input.runScopeSha ||
    authority.baseBranch !== 'staging' ||
    authority.headBranch !== input.headBranch ||
    authority.worktreePath !== input.worktreePath ||
    authority.canonicalRemote !== 'https://github.com/' + TEE_TIME_REPOSITORY + '.git' ||
    run.metadata.supervised_case_hash !== input.caseHash ||
    policyDigest(authority) !== value.authorityHash ||
    policyDigest({
      runId: run.id,
      caseHash: input.caseHash,
      authorityHash: value.authorityHash,
    }) !== value.bindingHash
  )
    throw new Error('actual paused run/authority binding differs');
  const codebase = await api.getCodebase(authority.codebaseId);
  if (
    codebase?.name !== TEE_TIME_REPOSITORY ||
    codebase.default_cwd !== input.repositoryRoot ||
    codebase.ai_assistant_type !== 'codex' ||
    codebase.repository_url !== authority.canonicalRemote
  )
    throw new Error('actual codebase drifted');
  const conversation = await api.getConversationById(run.conversation_id);
  if (
    conversation?.codebase_id !== codebase.id ||
    conversation.cwd !== input.worktreePath ||
    conversation.ai_assistant_type !== 'codex'
  )
    throw new Error('actual conversation drifted');
  const expectedPolicy = supervisedRunPolicy(
    codebase.id,
    policyDigest(SUPERVISED_WORKFLOW_IDENTITY)
  );
  if (policyDigest(run.metadata.execution_policy) !== policyDigest(expectedPolicy))
    throw new Error('actual supervised policy drifted');
  const revisions = await captureRuntimeRevisions(SUPERVISED_WORKFLOW_IDENTITY);
  if (
    Object.entries(revisions).some(
      ([key, expected]) => authority[key as keyof RunAuthorityRecord] !== expected
    )
  )
    throw new Error('supervised runtime source drifted');
  const artifacts = api.artifactsPath(run.id);
  if (
    !(await readFile(join(artifacts, 'authority', 'work-order.md'))).equals(
      Buffer.from(input.specBytes)
    ) ||
    policyDigest(
      JSON.parse(await readFile(join(artifacts, 'authority', 'run-authority.json'), 'utf8'))
    ) !== value.authorityHash
  )
    throw new Error('frozen spec/authority files drifted');
  const observed = await input.observe();
  if (
    observed.headCommit !== input.runScopeSha ||
    observed.headBranch !== input.headBranch ||
    observed.localStagingCommit !== input.baseSha ||
    observed.remoteStagingCommit !== input.baseSha
  )
    throw new Error('actual worktree/staging observation differs');
  if (!(await readFile(path)).equals(raw)) throw new Error('binding changed during readback');
  return Object.freeze(value);
}
