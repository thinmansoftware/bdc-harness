// Isolated orchestration fixture. No Docker, Python, SQLite, account or provider.
// Common preflight/read-only observations are explicit mocks. Claim files,
// admission helper, forwarding transport and lifecycle code are real.
import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as urls from 'node:url';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as bootstrap from '../../packages/workflows/src/reliability/tee-time-supervised-bootstrap';
import { supervisedAttemptHash } from '../../packages/workflows/src/reliability/tee-time-supervised-model-phase';
import { policyDigest } from '../../packages/paths/src/tee-time-policy';
import type { ProviderAttemptRecord } from '../../packages/workflows/src/reliability/types';

const scenario=process.argv[2]!,home=process.argv[3]!;
const join=path.join,resolve=path.resolve,realpath=fs.realpath,open=fs.open,readdir=fs.readdir;
const fileURLToPath=urls.fileURLToPath,sourceUrl=new URL('../../',import.meta.url).href;
const realBunFile=Bun.file,writeOut=process.stdout.write.bind(process.stdout),realTimer=globalThis.setTimeout;
const worktree=resolve(import.meta.dirname,'../..'),root=join(home,'teetime-supervised-01');
const source=join(root,'minimal-diagnostic-execution-harness'),prepared=join(root,'harness'),control=join(root,'control-minimal-diagnostic-1');
for(const dir of [source,prepared,join(root,'control'),join(root,'plan'),join(root,'archon')])await fs.mkdir(dir,{recursive:true});
const h=(char:string)=>'sha256:'+char.repeat(64),digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const events:string[]=[],runId='a'.repeat(32),nonce='b'.repeat(32),revision='c'.repeat(40),reviewHead='d'.repeat(40);
const records:ProviderAttemptRecord[]=[];
for(let i=0;i<4;i++)records.push({attemptId:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
  runId,nodeId:'implement',attemptNumber:i+1,provider:'codex-native-strict',model:'gpt-5.6-sol',
  declaredProvider:'codex-native-strict',declaredModel:'gpt-5.6-sol',requiredCapabilities:['text_generation'],
  startedAt:`2026-10-19T0${i}:00:00.000Z`,completedAt:`2026-10-19T0${i}:01:00.000Z`,servedModelId:null,
  outcomeClass:'quality',reasonCode:'required_stage_failed',resumeAt:null,supersedesAttemptId:i?records[i-1].attemptId:null});
const original=records.map(supervisedAttemptHash);
const predecessors=records.map((r,i)=>({attemptId:r.attemptId,completedAt:r.completedAt!,rowHash:supervisedAttemptHash(r),
  executionHash:h('1'),resultHash:h('2'),claimHash:h('3'),manifestHash:h('4'),lockHash:h('5'),
  owner:`teetime-auth-${String(i+1).padStart(12,'0')}`}));
const policy={hash:h('6'),codebaseId:'isolated',workflowDigest:h('7')};
const run={id:runId,status:'paused',metadata:{execution_policy:policy}};
const binding={version:1,runId,caseHash:h('8'),authorityHash:h('9'),bindingHash:h('a')};
const packageBytes=Buffer.from('{}'),executionHash=digest(packageBytes),inventoryHash='e'.repeat(64);
const input={harnessSource:'f'.repeat(40),sourceManifestSha256:'1'.repeat(64),caseSha256:'2'.repeat(64),
  helperHashes:{},binaryPaths:{git:join(home,'git'),python:join(home,'python')},binaryHashes:{git:'3'.repeat(64),python:'4'.repeat(64)},
  assetHashes:{},planFileHashes:{},specSha256:'5'.repeat(64),dispatchId:'fixture',specRevision:'6'.repeat(40),
  baseSha:'7'.repeat(40),runScopeSha:'8'.repeat(40)};
const inputBytes=Buffer.from(JSON.stringify(input,null,2)+'\n'),inputHash=digest(inputBytes);
const admissionHash='sha256:'+digest(Buffer.from(JSON.stringify({executionHash,installedManifestHash:inventoryHash,
  kind:'teetime-minimal-admission',operatorInputHash:inputHash,source:revision,version:1})));
const metadata={packageHash:executionHash,preparedBindingHash:binding.bindingHash,authorityHash:binding.authorityHash,
  runPolicyHash:policyDigest(policy),providerPolicyHash:h('b'),runId,image:h('c'),source:revision,
  baseSource:'9'.repeat(40),operatorInputHash:inputHash,predecessors};
const now=Date.now();
const observation={version:1,kind:'tee-time-minimal-plan-observation',remote:'bdc-server',nonce,
  remoteStagingSha:input.baseSha,observedAtMs:now,expiresAtMs:now+60000,executionHash:'sha256:'+executionHash,
  preparedBindingHash:binding.bindingHash,runId,repository:'thinmansoftware/bdc-xo',pullRequest:3392,
  packagePath:'docs/tee-time/minimal-diagnostic-admission.json',sourceSha:revision,
  installedManifestHash:'sha256:'+inventoryHash,operatorInputHash:inputHash,admissionHash,
  review:{head:reviewHead,state:'OPEN',author:'builder',complete:true,reviews:[{id:123,login:'thinman-overseer[bot]',
    state:'APPROVED',head:reviewHead,submittedAt:'2026-10-19T06:00:00.000Z'}]}};
let inputController!:ReadableStreamDefaultController<Uint8Array>;
const inputStream=new ReadableStream<Uint8Array>({start(c){inputController=c;c.enqueue(Buffer.from(JSON.stringify(observation)+'\n'));}});
const underlying=inputStream.getReader();
let cancelCalls=0;
const inputReader={read:()=>underlying.read(),cancel:async()=>{
  cancelCalls++;events.push('cancel');await underlying.cancel();
  if(scenario==='cancel-reject')throw new Error('synthetic cancel rejection');
  if(scenario==='cancel-repeat-reject'&&cancelCalls>1)throw new Error('synthetic repeated cancellation rejection');
  if(scenario==='cancel-hang')return new Promise<void>(()=>{});
}};
const nativeBunVersion=Bun.version;
const runtime=Bun as unknown as {stdin:unknown;file:unknown;spawn:unknown};
runtime.stdin={stream:()=>({getReader:()=>inputReader})};
runtime.file=(_name:Parameters<typeof Bun.file>[0])=>({arrayBuffer:async()=>Buffer.from('pinned').buffer});
globalThis.setTimeout=((fn:()=>void,ms?:number,...args:unknown[])=>realTimer(fn,
  [3000,5000,15000].includes(ms??0)?25:ms,...args)) as typeof setTimeout;
process.stdout.write=((chunk:Uint8Array|string,...args:unknown[])=>{
  const raw=Buffer.from(chunk).toString();
  if(raw.startsWith('{')){
    try {if(JSON.parse(raw).type==='RESULT')events.push('emitted-result');
      if(JSON.parse(raw).type==='READY'){
      events.push('emitted-ready');inputController.enqueue(Buffer.from([0,0,0,1,42]));inputController.close();
    }}catch { /* Newline writes are not protocol packets. */ }
  }
  return writeOut(chunk,...args as []);
}) as typeof process.stdout.write;
mock.module('node:os',()=>({homedir:()=>home}));
mock.module('node:url',()=>({...urls,fileURLToPath:(value:URL|string)=>
  String(value)===sourceUrl?worktree:fileURLToPath(value)}));
mock.module('node:path',()=>({...path,resolve:(value:string,...rest:string[])=>
  resolve(value,...rest)===worktree?source:resolve(value,...rest)}));
mock.module('node:fs/promises',()=>({...fs,
  readdir:async(value:string,...args:unknown[])=>value===source||value===prepared?[]:readdir(value,...args as []),
  realpath:async(value:string)=>value.includes(join('node_modules','@archon'))
    ?join(value.slice(0,value.indexOf('node_modules')),'packages',path.basename(value)):realpath(value),
  open:async(value:string,...args:unknown[])=>{
    if(scenario==='retention-fail'&&value.endsWith('diagnostic-result.json'))throw new Error('synthetic retention failure');
    return open(value,...args as [string,number]);
  }}));
const sourceCase={version:1,kind:'teetime-supervised-demo-source-contract',repository:'thinmansoftware/whats-that-tee-time',
  woId:'WO-TEETIME-SIMULATED-WALKTHROUGH-01',workflow:'bdc-teetime-supervised-walkthrough',executionAdmitted:false,preparedAssets:{}};
mock.module(join(worktree,'scripts/staging/teetime-supervised-entry-guard.ts'),()=>({
  assertPrepareRuntime:()=>{events.push('mocked-runtime-preflight');},
  assertPrepareEnvironment:()=>{},ordinaryDirectory:async()=>{},assertFreshSqliteLocation:async()=>{throw new Error('fresh DB forbidden');},
  validatePrepareManifest:()=>input,validatePreparationObservation:(v:unknown)=>v,
  frozenEntryFile:async(name:string)=>{
    if(name.endsWith('operator-input.json'))return inputBytes;
    if(name.endsWith('harness-source-manifest.json'))return Buffer.from(JSON.stringify({version:1,source:input.harnessSource,files:{}}));
    if(name.endsWith('minimal-diagnostic-execution-source-manifest.json'))return Buffer.from(JSON.stringify({version:1,source:revision,files:{}}));
    if(name.endsWith('teetime-demo-case.json'))return Buffer.from(JSON.stringify(sourceCase));
    if(name.endsWith('minimal-execution.json'))return packageBytes;
    return Buffer.from('pinned');
  }}));
const store={getWorkflowRun:async()=>structuredClone(run),listProviderAttempts:async(_id:string,node?:string)=>{
  if(node!==undefined)throw new Error('filtered attempt read forbidden');events.push('list:'+records.length);return structuredClone(records);},
  createProviderAttempt:async(row:ProviderAttemptRecord)=>{events.push('insert');records.push(structuredClone(row));
    if(scenario==='admission-readback')Object.assign(records[4],{model:'changed'});return true;},
  completeProviderAttempt:async(value:Record<string,unknown>)=>{events.push('complete:'+value.reasonCode);
    if(scenario==='completion-write')return false;
    Object.assign(records.find(r=>r.attemptId===value.attemptId)!,value);
    if(scenario==='completion-readback')Object.assign(records[4],{servedModelId:'changed'});return true;}};
mock.module(join(worktree,'packages/workflows/src/reliability/tee-time-supervised-bootstrap.ts'),()=>({...bootstrap,
  readSupervisedBinding:async()=>structuredClone(binding)}));
mock.module(join(worktree,'packages/paths/src/index.ts'),()=>({rootLogger:{level:'silent'},
  getProjectRoot:()=>join(home,'repo'),getProjectWorktreesPath:()=>join(home,'worktrees'),getRunArtifactsPath:()=>join(home,'artifacts')}));
mock.module(join(worktree,'packages/core/src/db/connection.ts'),()=>({getDatabase:()=>({dialect:'sqlite',
  query:async(sql:string)=>({rows:sql.includes('journal_mode')?[{journal_mode:'wal'}]:sql.includes('synchronous')?[{synchronous:2}]:[]})}),
  closeDatabase:async()=>{events.push('db-close');}}));
for(const name of ['codebases','conversations','workflows'])mock.module(join(worktree,'packages/core/src/db',name+'.ts'),()=>({}));
mock.module(join(worktree,'packages/core/src/workflows/store-adapter.ts'),()=>({createWorkflowStore:()=>store}));
function completedChild(value:unknown,writingHangs=false) {
  return {stdout:new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from(JSON.stringify(value)));c.close();}}),
    exited:Promise.resolve(0),exitCode:0,kill:()=>{events.push('check-kill');},
    stdin:{write:()=>{},flush:()=>writingHangs?new Promise<void>(()=>{}):Promise.resolve(),end:()=>{}}};
}
runtime.spawn=(command:string[])=>{
  if(command.some(s=>s.endsWith('teetime_minimal_controller_check.py'))){
    const mode=command[command.length-2];events.push('check:'+mode);
    if(mode==='metadata')return completedChild(scenario==='admission-after-insert'&&records.length===5?{...metadata,image:h('f')}:metadata);
    if(mode==='predecessor')return completedChild({resourcesAbsent:true,observedAt:Date.now(),expiresAt:Date.now()+30000,
      predecessors:predecessors.map(p=>({manifestHash:p.manifestHash,lockHash:p.lockHash}))});
    if(mode==='ready')return completedChild({readyVerified:true},scenario==='check-writer-hang');
    return completedChild({passed:scenario!=='failing-report',cleanupVerified:true,proxyMetricsVerified:true,modelInvocations:1});
  }
  if(!command.some(s=>s.endsWith('run-teetime-auth-canary.py'))||command.includes('--artifact-source')||
      !command.includes('--diagnostic-source')||!command.includes('minimal-diagnostic'))throw new Error('unexpected launcher');
  if(records.length!==5||!existsSync(join(control,'diagnostic.claim.json'))||!existsSync(join(control,'diagnostic-observation.json')))
    throw new Error('launch preceded admission readback');
  events.push('launch');let c!:ReadableStreamDefaultController<Uint8Array>,code:number|null=null;
  let done!:(value:number)=>void;const exited=new Promise<number>(r=>{done=r;});
  let outputClosed=false;
  const stdout=new ReadableStream<Uint8Array>({start(value){c=value;c.enqueue(Buffer.from(JSON.stringify({type:'READY',nonce})+'\n'));},
    cancel(){outputClosed=true;}});
  let frames=0,closed=false;
  const end=(exit:number)=>{if(closed)return;closed=true;code=exit;if(!outputClosed)c.close();done(exit);};
  return {stdout,exited,get exitCode(){return code;},kill:()=>end(1),stdin:{write:(bytes:Uint8Array)=>{frames+=bytes.length;events.push('frame');},
    flush:async()=>{},end:()=>{
      if(frames!==5)throw new Error('synthetic credential frame differs');
      if(scenario!=='missing-report')c.enqueue(Buffer.from(JSON.stringify({type:scenario==='malformed-report'?'BROKEN':'RESULT',
        nonce,passed:scenario!=='failing-report'})+'\n'));
      end(scenario==='failing-report'?1:0);
    }}};
};
process.argv=[process.execPath,join(worktree,'scripts/staging/teetime-supervised-controller.ts'),'--claim-minimal-diagnostic',
  '--input-sha256',inputHash,'--execution-sha256',executionHash,'--source-manifest-sha256',inventoryHash,
  '--source-sha',revision,'--review-head',reviewHead,'--nonce',nonce];
let failure:unknown;
try {await (await import('./teetime-supervised-controller')).prepare();}
catch(error){failure=error;process.exitCode=1;}
finally {
  runtime.file=realBunFile;
  await fs.writeFile(join(home,'audit.json'),JSON.stringify({events,records,nativeBunVersion,
    unchanged:records.slice(0,4).map(supervisedAttemptHash).every((v,i)=>v===original[i]),
    run,lockRetained:existsSync(join(control,'controller.lock')),claimRetained:existsSync(join(control,'diagnostic.claim.json')),
    failure:failure instanceof Error?{name:failure.name,message:failure.message,stack:failure.stack}:null}));
}
