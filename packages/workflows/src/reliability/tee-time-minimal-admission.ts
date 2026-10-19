// Source-only diagnostic admission. No provider, credential or launcher imports.
// Operational callbacks must measure actual current reviewed carrier/inventory,
// historical files and owned resources. Pure packet validation cannot grant use.
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { policyDigest } from '../../../paths/src/tee-time-policy';
import { TEE_TIME_SUPERVISED_POLICY } from '../../../paths/src/tee-time-supervised-policy';
import type { IWorkflowStore } from '../store';
import type { ProviderAttemptRecord } from './types';
import { claimSupervisedDiagnosticPhase, type SupervisedBinding, type SupervisedController } from './tee-time-supervised-bootstrap';
import { approvedSupervisedPlanReview, reconcileMinimalDiagnosticHistory, supervisedAttemptHash,
  type SupervisedChainReconciliation, type SupervisedPlanReview, type SupervisedPredecessor } from './tee-time-supervised-model-phase';

export interface MinimalDiagnosticAdmission {
  controller: SupervisedController;
  store: Pick<IWorkflowStore,'getWorkflowRun'|'listProviderAttempts'|'createProviderAttempt'>;
  runId: string;
  admissionHash: string;
  executionHash: string;
  preparedBindingHash: string;
  authorityHash: string;
  runPolicyHash: string;
  reviewHead: string;
  nonce: string;
  predecessors: readonly SupervisedPredecessor[];
  readPrepared(): Promise<Readonly<SupervisedBinding>>;
  readReview(): Promise<SupervisedPlanReview>;
  recheckExecution(): Promise<void>;
  observe(): Promise<SupervisedChainReconciliation>;
  remainingMs(): number;
}

export async function claimMinimalDiagnosticAttempt(input: MinimalDiagnosticAdmission): Promise<Readonly<ProviderAttemptRecord>> {
  // Snapshot every descriptor/function before first await. Store/controller are
  // trusted capabilities, not untrusted packet objects.
  const frozen = Object.freeze({...input,
    predecessors:Object.freeze(input.predecessors.map(item=>Object.freeze({...item})))});
  const {controller,store,runId,admissionHash,executionHash,preparedBindingHash,authorityHash,
    runPolicyHash,reviewHead,nonce,predecessors,readPrepared,readReview,recheckExecution,observe,remainingMs}=frozen;
  const getRun=store.getWorkflowRun.bind(store), list=store.listProviderAttempts.bind(store),
    create=store.createProviderAttempt.bind(store);
  if (!/^[a-f0-9]{32}$/.test(runId) || !/^[a-f0-9]{32}$/.test(nonce) ||
      !/^[a-f0-9]{40}$/.test(reviewHead) ||
      ![admissionHash,executionHash,preparedBindingHash,authorityHash,runPolicyHash].every(v=>/^sha256:[a-f0-9]{64}$/.test(v)) ||
      controller.bindingHash!==admissionHash || predecessors.length!==4)
    throw new Error('closed minimal diagnostic identity required');
  const budget=()=>{const ms=remainingMs();if(!Number.isFinite(ms)||ms<=315000)
    throw new Error('insufficient diagnostic transport budget');};
  let stateSnapshot: string | undefined;
  let reviewSnapshot: string | undefined;
  let approvalId=0;
  async function state(): Promise<void> {
    const prepared=structuredClone(await readPrepared());
    const run=structuredClone(await getRun(runId));
    const review=structuredClone(await readReview());
    if(!run || run.id!==runId || run.status!=='paused' ||
        !run.metadata.execution_policy || policyDigest(run.metadata.execution_policy)!==runPolicyHash ||
        prepared.runId!==runId || prepared.bindingHash!==preparedBindingHash || prepared.authorityHash!==authorityHash)
      throw new Error('paused prepared diagnostic run differs');
    const id=approvedSupervisedPlanReview(review,reviewHead);
    const s=JSON.stringify([prepared,run]), r=JSON.stringify(review);
    if((stateSnapshot!==undefined && stateSnapshot!==s)||(reviewSnapshot!==undefined && reviewSnapshot!==r))
      throw new Error('diagnostic state or review changed');
    stateSnapshot=s;reviewSnapshot=r;approvalId=id;
  }
  async function history(expected?:ProviderAttemptRecord): Promise<SupervisedChainReconciliation> {
    const observed=structuredClone(await observe());
    const rows=structuredClone(await list(runId)); // Never filter out unexpected nodes.
    const historical=expected ? rows.filter(row=>row.attemptId!==expected.attemptId) : rows;
    reconcileMinimalDiagnosticHistory(predecessors,observed,historical,runId);
    if(expected) {
      const inserted=rows.filter(row=>row.attemptId===expected.attemptId);
      if(rows.length!==5 || inserted.length!==1 || supervisedAttemptHash(inserted[0])!==supervisedAttemptHash(expected))
        throw new Error('diagnostic provider attempt readback differs; claim remains consumed');
    }
    return observed;
  }
  await controller.assertOwned(); await recheckExecution(); await state(); await history();
  await recheckExecution(); await state();
  const observation=await history();
  await controller.assertOwned(); budget();
  await claimSupervisedDiagnosticPhase(controller,{bindingHash:admissionHash,reviewHead,reviewId:approvalId,
    reviewer:'thinman-overseer[bot]',state:'APPROVED'});
  const bytes=Buffer.from(JSON.stringify({version:1,kind:'teetime-minimal-admission-observation',nonce,
    admissionHash,executionHash,reviewHead,reviewId:approvalId,observation})+'\n','ascii');
  const path=join(controller.root,'diagnostic-observation.json');
  await controller.assertOwned();
  const file=await open(path,'wx',0o600);
  try {await file.writeFile(bytes);await file.sync();} finally {await file.close();}
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||!(await readFile(path)).equals(bytes))
    throw new Error('diagnostic observation readback failed; claim remains consumed');
  const attempt: ProviderAttemptRecord=Object.freeze({attemptId:randomUUID(),runId,nodeId:'diagnose-transport',attemptNumber:1,
    provider:TEE_TIME_SUPERVISED_POLICY.provider,model:TEE_TIME_SUPERVISED_POLICY.model,
    declaredProvider:TEE_TIME_SUPERVISED_POLICY.provider,declaredModel:TEE_TIME_SUPERVISED_POLICY.model,
    requiredCapabilities:Object.freeze(['text_generation'] as const),startedAt:new Date().toISOString(),completedAt:null,
    servedModelId:null,outcomeClass:null,reasonCode:null,resumeAt:null,supersedesAttemptId:null});
  if(!(await create(attempt)))throw new Error('diagnostic persistence failed; claim remains consumed');
  await history(attempt); await state(); await recheckExecution(); await controller.assertOwned(); budget();
  // Caller still owns the closed transport and must check the same deadline
  // immediately before launch. Returning this row never starts a provider.
  return attempt;
}
