import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyDigest } from '../../../paths/src/tee-time-policy';
import { acquireSupervisedController } from './tee-time-supervised-bootstrap';
import { supervisedAttemptHash, type SupervisedPlanReview } from './tee-time-supervised-model-phase';
import type { ProviderAttemptRecord } from './types';
import type { IWorkflowStore } from '../store';
import { claimMinimalDiagnosticAttempt } from './tee-time-minimal-admission';

const roots: string[] = [];
const hash = (char: string) => 'sha256:' + char.repeat(64);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true}); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'teetime-minimal-')); roots.push(root);
  const runId = 'a'.repeat(32), policy = { hash: hash('b'), codebaseId:'isolated', workflowDigest:hash('c') };
  const records: ProviderAttemptRecord[] = [];
  for (let i=0; i<4; i++) records.push({
    attemptId:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
    runId, nodeId:'implement', attemptNumber:i+1, provider:'codex-native-strict', model:'gpt-5.6-sol',
    declaredProvider:'codex-native-strict', declaredModel:'gpt-5.6-sol', requiredCapabilities:['text_generation'],
    startedAt:`2026-10-19T0${i}:00:00.000Z`, completedAt:`2026-10-19T0${i}:01:00.000Z`,
    servedModelId:null, outcomeClass:'quality', reasonCode:'required_stage_failed', resumeAt:null,
    supersedesAttemptId:i ? records[i-1].attemptId : null,
  });
  const predecessors = records.map((row,i)=>({attemptId:row.attemptId, completedAt:row.completedAt!,
    rowHash:supervisedAttemptHash(row), executionHash:hash('1'), resultHash:hash('2'), claimHash:hash('3'),
    owner:`teetime-auth-${String(i+1).padStart(12,'0')}`, manifestHash:hash('4'), lockHash:hash('5')}));
  const prepared = {version:1 as const,runId,caseHash:hash('6'),authorityHash:hash('7'),bindingHash:hash('8')};
  const review: SupervisedPlanReview = {head:'f'.repeat(40),state:'OPEN',author:'john',complete:true,
    reviews:[{id:123,login:'thinman-overseer[bot]',state:'APPROVED',head:'f'.repeat(40),
      submittedAt:'2026-10-19T05:00:00.000Z'}]};
  const run = {id:runId,status:'paused',metadata:{execution_policy:policy}};
  let remaining=400000, insert=true, reads=0, checks=0;
  const controller = await acquireSupervisedController(root,hash('9'));
  const store = {
    getWorkflowRun: async()=>structuredClone(run),
    listProviderAttempts:async (_id:string,node?:string)=>{
      expect(_id).toBe(runId); expect(node).toBeUndefined(); reads++;
      return structuredClone(records);
    },
    createProviderAttempt:async(row:ProviderAttemptRecord)=>{if(insert) records.push(structuredClone(row));return insert;},
  } as unknown as Pick<IWorkflowStore,'getWorkflowRun'|'listProviderAttempts'|'createProviderAttempt'>;
  const input = {controller,store,runId,admissionHash:hash('9'),executionHash:hash('a'),
    preparedBindingHash:prepared.bindingHash,authorityHash:prepared.authorityHash,runPolicyHash:policyDigest(policy),
    reviewHead:review.head,nonce:'0'.repeat(32),predecessors,
    readPrepared:async()=>structuredClone(prepared),readReview:async()=>structuredClone(review),
    recheckExecution:async()=>{checks++;},remainingMs:()=>remaining,
    observe:async()=>({predecessors:structuredClone(predecessors),runId,runPaused:true as const,
      resourcesAbsent:true as const,observedAt:Date.now(),expiresAt:Date.now()+25000}),
  };
  return {root,input,records,predecessors,review,run,prepared,
    remaining:(n:number)=>{remaining=n;},insert:(v:boolean)=>{insert=v;},reads:()=>reads,checks:()=>checks};
}

test('diagnostic claim admits only a separate persisted sidecar with unchanged complete history',async()=>{
  const f=await fixture(), before=f.records.map(supervisedAttemptHash);
  const row=await claimMinimalDiagnosticAttempt(f.input);
  expect(row.nodeId).toBe('diagnose-transport'); expect(row.attemptNumber).toBe(1);
  expect(row.supersedesAttemptId).toBeNull(); expect(row.servedModelId).toBeNull(); expect(row.resumeAt).toBeNull();
  expect(f.records.slice(0,4).map(supervisedAttemptHash)).toEqual(before); expect(f.records).toHaveLength(5);
  expect(f.run.status).toBe('paused'); expect(f.checks()).toBeGreaterThanOrEqual(2);
  const observation=JSON.parse(await readFile(join(f.root,'diagnostic-observation.json'),'utf8'));
  expect(observation.nonce).toBe(f.input.nonce); expect(observation.admissionHash).toBe(f.input.admissionHash);
  expect(observation.reviewId).toBe(123);
  await expect(claimMinimalDiagnosticAttempt(f.input)).rejects.toThrow();
});

test('changed complete attempt set, policy, preparation or review rejects before consumption',async()=>{
  for(const kind of ['extra','missing','active','changed','link','policy','running','prepared','review','stale','resources','budget']) {
    const f=await fixture();
    if(kind==='extra')f.records.push({...f.records[0],attemptId:'extra',nodeId:'unexpected'});
    if(kind==='missing')f.records.pop();
    if(kind==='active')Object.assign(f.records[3],{completedAt:null});
    if(kind==='changed')Object.assign(f.records[0],{servedModelId:'other'});
    if(kind==='link')Object.assign(f.records[3],{supersedesAttemptId:null});
    if(kind==='policy')f.run.metadata.execution_policy.hash=hash('0');
    if(kind==='running')f.run.status='running';
    if(kind==='prepared')f.prepared.authorityHash=hash('0');
    if(kind==='review')f.review.reviews[0].state='CHANGES_REQUESTED';
    if(kind==='budget')f.remaining(315000);
    const observe=f.input.observe;
    f.input.observe=async()=>{const o=await observe(); if(kind==='stale')o.observedAt-=60000;
      if(kind==='resources')Object.assign(o,{resourcesAbsent:false});return o;};
    await expect(claimMinimalDiagnosticAttempt(f.input)).rejects.toThrow();
    await expect(readFile(join(f.root,'diagnostic.claim.json'))).rejects.toThrow();
  }
});

test('persistence failure consumes claim and partial observation is never overwritten',async()=>{
  for(const partial of [false,true]) {
    const f=await fixture(); f.insert(false);
    if(partial)await writeFile(join(f.root,'diagnostic-observation.json'),'partial');
    await expect(claimMinimalDiagnosticAttempt(f.input)).rejects.toThrow();
    expect(await readFile(join(f.root,'diagnostic.claim.json'),'utf8')).toContain('diagnostic');
    if(partial)expect(await readFile(join(f.root,'diagnostic-observation.json'),'utf8')).toBe('partial');
    expect(f.records).toHaveLength(4); await expect(claimMinimalDiagnosticAttempt(f.input)).rejects.toThrow();
  }
});

test('concurrent claims insert one diagnostic attempt',async()=>{
  const f=await fixture();
  const results=await Promise.allSettled([claimMinimalDiagnosticAttempt(f.input),claimMinimalDiagnosticAttempt(f.input)]);
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1); expect(f.records).toHaveLength(5);
});

test('post-persistence drift and depleted budget keep consumed claim without admission',async()=>{
  for(const kind of ['budget','extra','history','run','readback']) {
    const f=await fixture(), insert=f.input.store.createProviderAttempt;
    f.input.store.createProviderAttempt=async row=>{const ok=await insert(row);
      if(kind==='budget')f.remaining(315000);
      if(kind==='extra')f.records.push({...row,attemptId:'extra',nodeId:'unexpected'});
      if(kind==='history')Object.assign(f.records[1],{startedAt:'changed'});
      if(kind==='run')f.run.status='running';
      if(kind==='readback')Object.assign(f.records[4],{model:'different'});
      return ok;};
    await expect(claimMinimalDiagnosticAttempt(f.input)).rejects.toThrow();
    expect(await readFile(join(f.root,'diagnostic.claim.json'),'utf8')).toContain('diagnostic');
  }
});

test('caller identity mutation during callbacks cannot change the frozen claim',async()=>{
  const f=await fixture(), old=f.input.recheckExecution;
  const observedPredecessors=structuredClone(f.predecessors);
  f.input.observe=async()=>({predecessors:structuredClone(observedPredecessors),runId:f.run.id,
    runPaused:true as const,resourcesAbsent:true as const,observedAt:Date.now(),expiresAt:Date.now()+25000});
  f.input.recheckExecution=async()=>{f.input.reviewHead='0'.repeat(40);f.input.nonce='1'.repeat(32);
    f.input.predecessors[0].owner='changed';await old();};
  const row=await claimMinimalDiagnosticAttempt(f.input); expect(row.nodeId).toBe('diagnose-transport');
  const o=JSON.parse(await readFile(join(f.root,'diagnostic-observation.json'),'utf8'));
  expect(o.nonce).toBe('0'.repeat(32));expect(o.reviewHead).toBe('f'.repeat(40));
});
