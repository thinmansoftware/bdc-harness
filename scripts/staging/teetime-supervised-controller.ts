// Fixed preparation or supervised model entry. Never resumes the generic executor.
// Must be invoked with installed Bun --no-env-file from the frozen staging source.
import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPrepareEnvironment,
  frozenEntryFile,
  ordinaryDirectory,
  validatePrepareManifest,
  validatePreparationObservation,
  assertFreshSqliteLocation,
} from './teetime-supervised-entry-guard';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const ROOT = join(homedir(), 'teetime-supervised-01');
const SOURCE = resolve(fileURLToPath(new URL('../../', import.meta.url)));
class MinimalPersistenceUnresolved extends Error {
  constructor(){super('minimal diagnostic persistence unresolved');this.name='MinimalPersistenceUnresolved';}
}
async function verifySource(
  source: string,
  expected: string,
  revision: string,
  manifestName = 'harness-source-manifest.json'
): Promise<void> {
  const bytes = await frozenEntryFile(join(ROOT, manifestName), expected, 2 * 1024 * 1024);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (
    !manifest ||
    Object.keys(manifest).sort().join(',') !== 'files,source,version' ||
    manifest.version !== 1 ||
    manifest.source !== revision ||
    !manifest.files ||
    Array.isArray(manifest.files) ||
    Object.keys(manifest.files).length > 8192
  )
    throw new Error('frozen source inventory required');
  const paths: string[] = [];
  async function walk(folder: string, prefix: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue; // Acquired separately by frozen install.
      const path = prefix + entry.name;
      if (entry.isSymbolicLink() || entry.name === '.git')
        throw new Error('source indirection rejected');
      if (entry.isDirectory()) await walk(join(folder, entry.name), path + '/');
      else if (entry.isFile()) paths.push(path);
      else throw new Error('ordinary source files required');
      if (paths.length > 8192) throw new Error('source inventory bound');
    }
  }
  await walk(source, '');
  if (paths.sort().join('|') !== Object.keys(manifest.files).sort().join('|'))
    throw new Error('complete source inventory differs');
  let total = 0;
  for (const path of paths) {
    if (
      !/^[A-Za-z0-9_./-]+$/.test(path) ||
      path.split('/').some(part => ['', '.', '..'].includes(part))
    )
      throw new Error('closed source path required');
    const file = await frozenEntryFile(
      join(source, ...path.split('/')),
      manifest.files[path],
      16 * 1024 * 1024
    );
    total += file.length;
    if (total > 256 * 1024 * 1024) throw new Error('source aggregate bound');
  }
  for (const name of ['core', 'paths', 'workflows', 'providers', 'git', 'isolation'])
    if (
      (await realpath(join(source, 'node_modules', '@archon', name))) !==
      join(source, 'packages', name)
    )
      throw new Error('workspace dependency target differs');
}

export async function prepare(): Promise<Record<string, unknown>> {
  const minimal = process.argv[2] === '--claim-minimal-diagnostic';
  const diagnosticDeadline = minimal ? performance.now() + 420000 : undefined;
  // No database consumer has been imported above this boundary.
  assertPrepareEnvironment(ROOT, join(homedir(), 'teetime-supervised-01'), process.env);
  const fourth = process.argv[2] === '--claim-transport-repair';
  const third = process.argv[2] === '--claim-diagnostic-successor';
  const successor = process.argv[2] === '--claim-successor';
  const claim = minimal || fourth || third || successor || process.argv[2] === '--claim-model';
  if (
    process.platform !== 'win32' ||
    Bun.version !== '1.3.13' ||
    SOURCE !== join(ROOT, minimal ? 'minimal-diagnostic-execution-harness' : fourth ? 'transport-repair-execution-harness' : third ? 'diagnostic-execution-harness' : successor ? 'successor-execution-harness' : claim ? 'execution-harness' : 'harness') ||
    process.argv.length !== (claim ? 15 : 5) ||
    (!claim && process.argv[2] !== '--prepare') ||
    process.argv[3] !== '--input-sha256' ||
    !/^[a-f0-9]{64}$/.test(process.argv[4]!)
  )
    throw new Error('fixed Windows staging entry required');
  if (
    claim &&
    (process.argv[5] !== '--execution-sha256' ||
      !/^[a-f0-9]{64}$/.test(process.argv[6]!) ||
      process.argv[7] !== '--source-manifest-sha256' ||
      !/^[a-f0-9]{64}$/.test(process.argv[8]!) ||
      process.argv[9] !== '--source-sha' ||
      !/^[a-f0-9]{40}$/.test(process.argv[10]!) ||
      process.argv[11] !== '--review-head' ||
      !/^[a-f0-9]{40}$/.test(process.argv[12]!) ||
      process.argv[13] !== '--nonce' ||
      !/^[a-f0-9]{32}$/.test(process.argv[14]!))
  )
    throw new Error('closed supervised claim arguments required');
  const preparedSource = join(ROOT, 'harness');
  for (const path of [
    homedir(),
    ROOT,
    SOURCE,
    preparedSource,
    join(ROOT, 'plan'),
    join(ROOT, 'archon'),
  ])
    await ordinaryDirectory(path);
  const raw = await frozenEntryFile(join(ROOT, 'operator-input.json'), process.argv[4]!);
  const parsed = JSON.parse(raw.toString('utf8'));
  if (JSON.stringify(parsed, null, 2) + '\n' !== raw.toString('utf8'))
    throw new Error('closed pretty JSON input required');
  // Read only the source-owned case after the complete source inventory check.
  await verifySource(preparedSource, parsed.sourceManifestSha256, parsed.harnessSource);
  if (claim) {
    await verifySource(
      SOURCE,
      process.argv[8]!,
      process.argv[10]!,
      minimal ? 'minimal-diagnostic-execution-source-manifest.json' : fourth ? 'transport-repair-execution-source-manifest.json' : third ? 'diagnostic-execution-source-manifest.json' : successor ? 'successor-execution-source-manifest.json' : 'execution-source-manifest.json'
    );
    for (const name of [
      'packages/workflows/src/executor.ts',
      'packages/workflows/src/defaults/bundled-defaults.ts',
      'packages/workflows/src/defaults/bundled-defaults.generated.ts',
      'packages/workflows/src/reliability/runtime-revisions.ts',
      'packages/paths/src/tee-time-supervised-policy.ts',
    ]) {
      const original = await Bun.file(join(preparedSource, name)).arrayBuffer();
      const current = await frozenEntryFile(
        join(SOURCE, name),
        hash(new Uint8Array(original)),
        16 * 1024 * 1024
      );
      if (!current.equals(Buffer.from(original))) throw new Error('prepared runtime inputs differ');
    }
  }
  const caseBytes = await frozenEntryFile(
    join(preparedSource, 'scripts/staging/teetime-demo-case.json'),
    parsed.caseSha256
  );
  const sourceCase = JSON.parse(caseBytes.toString('utf8'));
  if (
    sourceCase.version !== 1 ||
    sourceCase.kind !== 'teetime-supervised-demo-source-contract' ||
    sourceCase.repository !== 'thinmansoftware/whats-that-tee-time' ||
    sourceCase.woId !== 'WO-TEETIME-SIMULATED-WALKTHROUGH-01' ||
    sourceCase.workflow !== 'bdc-teetime-supervised-walkthrough' ||
    sourceCase.executionAdmitted !== false
  )
    throw new Error('closed unadmitted preparation case required');
  const input = validatePrepareManifest(parsed, Object.keys(sourceCase.preparedAssets));
  for (const [name, sha256] of Object.entries(input.helperHashes))
    await frozenEntryFile(join(preparedSource, 'scripts/staging', name), sha256);
  for (const name of ['git', 'python'] as const)
    await frozenEntryFile(input.binaryPaths[name], input.binaryHashes[name], 64 * 1024 * 1024);
  for (const [target, asset] of Object.entries(sourceCase.preparedAssets)) {
    if (typeof asset !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(asset))
      throw new Error('closed prepared asset path required');
    await frozenEntryFile(
      join(preparedSource, 'scripts/staging/teetime-demo-assets', asset),
      input.assetHashes[target]!
    );
  }
  for (const [name, sha256] of Object.entries(input.planFileHashes))
    await frozenEntryFile(join(ROOT, 'plan', name), sha256);
  const specBytes = await frozenEntryFile(join(ROOT, 'plan/work-order.md'), input.specSha256);
  const archon = join(ROOT, 'archon');
  // A fresh preparation must never attach to an existing database.
  if (!claim) await assertFreshSqliteLocation(archon);
  const originalControl = join(ROOT, 'control');
  const control = minimal ? join(ROOT, 'control-minimal-diagnostic-1') : fourth ? join(ROOT, 'control-attempt-4') : third ? join(ROOT, 'control-attempt-3') : successor ? join(ROOT, 'control-attempt-2') : originalControl;
  if (minimal || fourth || third || successor) {
    await ordinaryDirectory(originalControl);
    await mkdir(control); // Deterministic exclusive successor location. Never recover/reuse.
  } else if (claim) await ordinaryDirectory(control);
  else await mkdir(control); // No recursive reuse or stale-claim recovery.
  process.env.ARCHON_HOME = archon;
  process.env.DEFAULT_AI_ASSISTANT = 'codex';
  process.env.ARCHON_TELEMETRY_DISABLED = '1';
  process.env.DO_NOT_TRACK = '1';
  const bootstrap =
    await import('../../packages/workflows/src/reliability/tee-time-supervised-bootstrap');
  const caseHash = 'sha256:' + hash(raw);
  const minimalAdmissionHash = minimal ? 'sha256:' + hash(Buffer.from(JSON.stringify({
    executionHash: process.argv[6]!, installedManifestHash: process.argv[8]!,
    kind: 'teetime-minimal-admission', operatorInputHash: process.argv[4]!, source: process.argv[10]!, version: 1,
  }), 'ascii')) : undefined;
  const ownership = await bootstrap.acquireSupervisedController(
    control,
    minimal ? minimalAdmissionHash! : claim ? 'sha256:' + process.argv[6]! : caseHash
  );
  let connection: typeof import('../../packages/core/src/db/connection') | undefined;
  try {
    const paths = await import('../../packages/paths/src/index');
    paths.rootLogger.level = 'silent';
    connection = await import('../../packages/core/src/db/connection');
    const db = connection.getDatabase();
    if (db.dialect !== 'sqlite') throw new Error('isolated SQLite required');
    await db.query('PRAGMA synchronous = FULL');
    const journal = await db.query<{ journal_mode: string }>('PRAGMA journal_mode');
    const synchronous = await db.query<{ synchronous: number }>('PRAGMA synchronous');
    if (journal.rows[0]?.journal_mode !== 'wal' || synchronous.rows[0]?.synchronous !== 2)
      throw new Error('actual WAL/FULL required before run mutations');
    const codes = await import('../../packages/core/src/db/codebases');
    const conversations = await import('../../packages/core/src/db/conversations');
    const runs = await import('../../packages/core/src/db/workflows');
    const { createWorkflowStore } = await import('../../packages/core/src/workflows/store-adapter');
    const project = paths.getProjectRoot('thinmansoftware', 'whats-that-tee-time');
    const repository = join(project, 'source');
    const worktree = join(
      paths.getProjectWorktreesPath('thinmansoftware', 'whats-that-tee-time'),
      'simulated-walkthrough-01'
    );
    async function observe() {
      await ownership.assertOwned();
      const env: Record<string, string> = {
        PATH: dirname(input.binaryPaths.git) + ';' + dirname(input.binaryPaths.python),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: 'NUL',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
      };
      for (const key of ['SYSTEMROOT', 'WINDIR'])
        if (process.env[key]) env[key] = process.env[key]!;
      const child = Bun.spawn(
        [
          input.binaryPaths.python,
          '-I',
          '-B',
          join(preparedSource, 'scripts/staging/teetime_git_base.py'),
          input.binaryPaths.git,
          repository,
          input.baseSha,
          '--observe-worktree',
          worktree,
          input.runScopeSha,
          'demo/simulated-walkthrough-01',
        ],
        { cwd: control, env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }
      );
      const timer = setTimeout(() => child.kill(), 30000);
      try {
        const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        // Trusted constrained reader enforces its own output cap before emission.
        if (exit !== 0 || output.length > 65536) throw new Error('constrained observer failed');
        const value = JSON.parse(output);
        return validatePreparationObservation(value);
      } finally {
        clearTimeout(timer);
      }
    }
    const api = {
      store: createWorkflowStore(),
      createCodebase: codes.createCodebase,
      getCodebase: codes.getCodebase,
      getOrCreateConversation: conversations.getOrCreateConversation,
      updateConversation: conversations.updateConversation,
      getConversationById: conversations.getConversationById,
      pauseWorkflowRunByOperator: runs.pauseWorkflowRunByOperator,
      artifactsPath: (id: string) =>
        paths.getRunArtifactsPath('thinmansoftware', 'whats-that-tee-time', id),
    };
    const preparation = {
      preparationRoot: originalControl,
      repositoryRoot: repository,
      worktreePath: worktree,
      dispatchId: input.dispatchId,
      caseHash,
      specSource:
        'github:thinmansoftware/bdc-xo:docs/work-orders/WO-TEETIME-SIMULATED-WALKTHROUGH-01.md',
      specRevision: input.specRevision,
      specBytes,
      baseSha: input.baseSha,
      runScopeSha: input.runScopeSha,
      headBranch: 'demo/simulated-walkthrough-01',
      observe,
    };
    if (minimal) {
      const { claimMinimalDiagnosticAttempt, MinimalDiagnosticAdmissionFailure } = await import('../../packages/workflows/src/reliability/tee-time-minimal-admission');
      const { supervisedAttemptHash } = await import('../../packages/workflows/src/reliability/tee-time-supervised-model-phase');
      const { readMinimalPlanObservation } = await import('./teetime-plan-observation');
      const { readObservationLine, forwardMinimalDiagnosticLauncher } = await import('./teetime-supervised-transport');
      const { open, readFile, lstat } = await import('node:fs/promises');
      const deadline=diagnosticDeadline!;
      const remaining=()=>deadline-performance.now();
      async function bounded<T>(promise:Promise<T>, limit:number):Promise<T> {
        const ms=Math.min(limit,remaining()-10000);
        if(ms<=0)throw new Error('minimal controller deadline');
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {return await Promise.race([promise,new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('minimal controller deadline')),ms);})]);}
        finally {clearTimeout(timer);}
      }
      const executionHash=process.argv[6]!;
      const packageBytes=await frozenEntryFile(join(SOURCE,'minimal-execution.json'),executionHash,32768);
      const env={SYSTEMROOT:process.env.SYSTEMROOT!,WINDIR:process.env.WINDIR!,USERPROFILE:homedir(),
        PATH:dirname(input.binaryPaths.python)};
      async function check(mode:'metadata'|'predecessor'|'ready'|'report',bytes?:Buffer) {
        if(remaining()<=10000)throw new Error('minimal check budget exhausted');
        const child=Bun.spawn([input.binaryPaths.python,'-I','-B',
          join(SOURCE,'scripts/staging/teetime_minimal_controller_check.py'),mode,executionHash],
          {cwd:control,env,stdin:bytes?'pipe':'ignore',stdout:'pipe',stderr:'ignore'});
        const output=(async()=>{
          const chunks:Buffer[]=[];let count=0;
          for await(const chunk of child.stdout){count+=chunk.length;if(count>16384)
            throw new Error('minimal check output bound');chunks.push(Buffer.from(chunk));}
          return Buffer.concat(chunks);
        })();
        // Always observe rejection even if stdin delivery fails first.
        void output.catch(()=>undefined);
        const writing=(async()=>{if(bytes&&child.stdin){child.stdin.write(bytes);await child.stdin.flush();child.stdin.end();}})();
        void writing.catch(()=>undefined);
        try {
          const [raw,exit]=await bounded(Promise.all([output,child.exited,writing]),mode==='predecessor'?30000:15000);
          if(exit!==0)throw new Error('independent minimal check rejected');
          return JSON.parse(raw.toString('ascii'));
        } finally {
          if(child.exitCode===null)child.kill();
          let timer:ReturnType<typeof setTimeout>|undefined;
          try {await Promise.race([Promise.all([child.exited,output.catch(()=>undefined),writing.catch(()=>undefined)]),
            new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('minimal check cleanup uncertain')),
              Math.max(1,Math.min(5000,remaining())));})]);} finally {clearTimeout(timer);}
        }
      }
      const execution=await check('metadata');
      if(execution.source!==process.argv[10] || execution.packageHash!==executionHash ||
          execution.operatorInputHash!==process.argv[4] || !Array.isArray(execution.predecessors) || execution.predecessors.length!==4)
        throw new Error('minimal metadata differs from frozen invocation');
      const initial=await bootstrap.readSupervisedBinding(api,preparation);
      const pausedRunSnapshot=JSON.stringify(await api.store.getWorkflowRun(initial.runId));
      if(initial.runId!==execution.runId || initial.authorityHash!==execution.authorityHash ||
          initial.bindingHash!==execution.preparedBindingHash)throw new Error('minimal prepared binding differs');
      const inputReader=Bun.stdin.stream().getReader();
      let cancellation:Promise<void>|undefined;
      const reader={read:()=>inputReader.read(),cancel:()=>
        cancellation??=Promise.resolve().then(()=>inputReader.cancel())};
      async function settleReader(){
        let timer:ReturnType<typeof setTimeout>|undefined;
        try {await Promise.race([reader.cancel(),new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('minimal reader cleanup uncertain')),Math.max(1,Math.min(3000,remaining())));})]);}
        finally {clearTimeout(timer);}
      }
      let phaseFailed=false;
      try {
        const observationRaw=await bounded(readObservationLine(reader),15000);
        const expected={nonce:process.argv[14]!,baseSha:input.baseSha,executionHash:'sha256:'+executionHash,
          preparedBindingHash:initial.bindingHash,runId:initial.runId,reviewHead:process.argv[12]!,
          admissionHash:minimalAdmissionHash!,installedManifestHash:'sha256:'+process.argv[8]!,
          sourceSha:process.argv[10]!,operatorInputHash:process.argv[4]!};
        const observation=()=>readMinimalPlanObservation(observationRaw,expected,Date.now());
        const attempt=await claimMinimalDiagnosticAttempt({controller:ownership,store:api.store,runId:initial.runId,
          admissionHash:minimalAdmissionHash!,executionHash:expected.executionHash,preparedBindingHash:initial.bindingHash,
          authorityHash:initial.authorityHash,runPolicyHash:execution.runPolicyHash,reviewHead:expected.reviewHead,
          nonce:expected.nonce,predecessors:execution.predecessors,remainingMs:remaining,
          readPrepared:async()=>{observation();return bootstrap.readSupervisedBinding(api,preparation);},
          readReview:async()=>observation().review,
          recheckExecution:async()=>{
            observation();
            await verifySource(SOURCE,process.argv[8]!,process.argv[10]!,'minimal-diagnostic-execution-source-manifest.json');
            if(!(await frozenEntryFile(join(SOURCE,'minimal-execution.json'),executionHash,32768)).equals(packageBytes) ||
                JSON.stringify(await check('metadata'))!==JSON.stringify(execution))throw new Error('minimal execution changed');
          },
          observe:async()=>{
            await bootstrap.readSupervisedBinding(api,preparation);
            const actual=await check('predecessor');
            if(!actual || Object.keys(actual).sort().join(',')!=='expiresAt,observedAt,predecessors,resourcesAbsent' ||
                !Array.isArray(actual.predecessors)||actual.predecessors.length!==4 ||
                actual.predecessors.some((p:Record<string,unknown>,i:number)=>!p ||
                  Object.keys(p).sort().join(',')!=='lockHash,manifestHash' ||
                  p.lockHash!==execution.predecessors[i].lockHash||p.manifestHash!==execution.predecessors[i].manifestHash))
              throw new Error('minimal actual historical reconciliation differs');
            return {predecessors:execution.predecessors.map((p:Record<string,unknown>)=>({...p})),runId:initial.runId,
              runPaused:true as const,resourcesAbsent:actual.resourcesAbsent,observedAt:actual.observedAt,expiresAt:actual.expiresAt};
          }}).catch(async error=>{
            if(error instanceof MinimalDiagnosticAdmissionFailure)await complete(error.attempt,null);
            throw error;
          });
        async function complete(attempt:Parameters<typeof supervisedAttemptHash>[0],passed:boolean|null) {
          async function readback(expected:Parameters<typeof supervisedAttemptHash>[0]) {
            const rows=await api.store.listProviderAttempts(initial.runId);
            const row=rows.find(p=>p.attemptId===attempt.attemptId);
            if(rows.length!==5||!row||supervisedAttemptHash(row)!==supervisedAttemptHash(expected)||
                execution.predecessors.some((p:{attemptId:string;rowHash:string})=>{
                  const prior=rows.find(r=>r.attemptId===p.attemptId);return !prior||supervisedAttemptHash(prior)!==p.rowHash;}) ||
                JSON.stringify(await bootstrap.readSupervisedBinding(api,preparation))!==JSON.stringify(initial) ||
                JSON.stringify(await api.store.getWorkflowRun(initial.runId))!==pausedRunSnapshot)
              throw new Error('minimal completion readback unresolved');
          }
          const completion={attemptId:attempt.attemptId,completedAt:new Date().toISOString(),servedModelId:null,
            outcomeClass:passed===true?'success' as const:'quality' as const,
            reasonCode:passed===null?'required_stage_indeterminate' as const:
              passed?'execution_completed' as const:'required_stage_failed' as const,resumeAt:null};
          try {
            await readback(attempt);
            if(!(await api.store.completeProviderAttempt(completion)))throw new Error('minimal completion persistence unresolved');
            await readback({...attempt,...completion});
          }catch {throw new MinimalPersistenceUnresolved();}
        }
        async function retain(name:string,bytes:Buffer) {
          await ownership.assertOwned();const path=join(control,name);const file=await open(path,'wx',0o600);
          try {await file.writeFile(bytes);await file.sync();}finally{await file.close();}
          const info=await lstat(path);
          if(!info.isFile()||info.isSymbolicLink()||!(await readFile(path)).equals(bytes))
            throw new Error('minimal retained observation readback failed');
        }
        const result=await (async()=>{
          await retain('diagnostic-plan-observation.json',observationRaw);
          if(remaining()<=315000)throw new Error('insufficient minimal launch budget');
          const result=await forwardMinimalDiagnosticLauncher({reader,nonce:expected.nonce,deadlineMs:deadline,
            spawn:()=>Bun.spawn([input.binaryPaths.python,'-I','-B',join(SOURCE,'scripts/staging/run-teetime-auth-canary.py'),
              '--docker','C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe','--image',execution.image,
              '--expected-sha',execution.baseSource,'--nonce',expected.nonce,'--task','minimal-diagnostic',
              '--diagnostic-source',execution.source],{cwd:control,env,stdin:'pipe',stdout:'pipe',stderr:'ignore'}),
            validateReady:async bytes=>{await ownership.assertOwned();await check('ready',bytes);},
            validateReport:async bytes=>{await ownership.assertOwned();return check('report',bytes);},
            emitReady:bytes=>{process.stdout.write(bytes);process.stdout.write('\n');}});
          await settleReader();
          await retain('diagnostic-result.json',result.report);
          return result;
        })().catch(async error=>{await complete(attempt,null);throw error;});
        await complete(attempt,result.summary.passed);
        await connection.closeDatabase();connection=undefined;
        if(result.summary.passed)await ownership.releaseAfterNormalCompletion();
        process.stdout.write(result.report);process.stdout.write('\n');
        if(!result.summary.passed)process.exitCode=1;
        return {forwarded:true};
      }catch(error){phaseFailed=true;throw error;} finally {
        try {await settleReader();}catch(error){if(!phaseFailed)throw error;}
      }
    }
    if (claim) {
      const { claimSupervisedModelAttempt, supervisedAttemptHash } =
        await import('../../packages/workflows/src/reliability/tee-time-supervised-model-phase');
      const { readPlanObservation } = await import('./teetime-plan-observation');
      const { readObservationLine, forwardSupervisedLauncher } =
        await import('./teetime-supervised-transport');
      const executionHash = process.argv[6]!;
      const packageBytes = await frozenEntryFile(
        join(SOURCE, 'demo-execution.json'),
        executionHash,
        262144
      );
      const reader = Bun.stdin.stream().getReader();
      async function check(mode: 'metadata' | 'ready' | 'report' | 'predecessor', bytes?: Buffer) {
        const child = Bun.spawn(
          [
            input.binaryPaths.python,
            '-I',
            '-B',
            join(SOURCE, 'scripts/staging/teetime_demo_controller_check.py'),
            mode,
            executionHash,
          ],
          {
            cwd: control,
            env: { SYSTEMROOT: process.env.SYSTEMROOT!, WINDIR: process.env.WINDIR!,
                   USERPROFILE: homedir(), PATH: dirname(input.binaryPaths.python) },
            stdin: bytes ? 'pipe' : 'ignore',
            stdout: 'pipe',
            stderr: 'ignore',
          }
        );
        // The predecessor collector has a 20s total query budget plus bounded
        // child reaping. Its 30s freshness rule still rejects slow observations.
        const timer = setTimeout(() => child.kill(), mode === 'predecessor' ? 30000 : 15000);
        try {
          if (bytes && child.stdin) {
            child.stdin.write(bytes);
            await child.stdin.flush();
            child.stdin.end();
          }
          const [output, exit] = await Promise.all([
            new Response(child.stdout).text(),
            child.exited,
          ]);
          if (exit !== 0 || output.length > 4096)
            throw new Error('independent demo check rejected');
          return JSON.parse(output);
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) child.kill();
          await child.exited;
        }
      }
      const execution = await check('metadata');
      if (execution.binding.attempt !== (fourth ? 4 : third ? 3 : successor ? 2 : 1) ||
          (successor ? execution.predecessor === null : execution.predecessor !== null) ||
          !Array.isArray(execution.predecessors) || execution.predecessors.length !== (fourth ? 3 : third ? 2 : 0))
        throw new Error('execution package differs from closed entry mode');
      if (execution.source !== process.argv[10] || execution.packageHash !== executionHash)
        throw new Error('actual execution source differs');
      const initial = await bootstrap.readSupervisedBinding(api, preparation);
      if (
        initial.runId !== execution.binding.runId ||
        initial.authorityHash !== execution.binding.authorityHash ||
        initial.bindingHash !== execution.preparedBindingHash
      )
        throw new Error('actual run differs from execution package');
      const observationRaw = await readObservationLine(reader);
      const expected = {
        nonce: process.argv[14]!,
        baseSha: input.baseSha,
        executionHash: 'sha256:' + executionHash,
        preparedBindingHash: initial.bindingHash,
        runId: initial.runId,
        reviewHead: process.argv[12]!,
      };
      const observation = () => readPlanObservation(observationRaw, expected, Date.now());
      let reconciliation: Record<string, unknown> | undefined;
      const chainSuccessor = third || fourth ? {
        predecessors: execution.predecessors,
        observe: async () => {
          await bootstrap.readSupervisedBinding(api, preparation);
          const actual = await check('predecessor');
          if (Object.keys(actual).sort().join(',') !==
              'expiresAt,observedAt,predecessors,resourcesAbsent' ||
              !Array.isArray(actual.predecessors) || actual.predecessors.length !== (fourth ? 3 : 2) ||
              actual.predecessors.some((item: Record<string, unknown>, index: number) =>
                !item || Object.keys(item).sort().join(',') !== 'lockHash,manifestHash' ||
                item.lockHash !== execution.predecessors[index].lockHash ||
                item.manifestHash !== execution.predecessors[index].manifestHash))
            throw new Error('actual historical chain reconciliation differs');
          const value = {predecessors: execution.predecessors.map((item: Record<string, unknown>) => ({...item})),
            runId: initial.runId, runPaused: true as const, resourcesAbsent: actual.resourcesAbsent,
            observedAt: actual.observedAt, expiresAt: actual.expiresAt};
          reconciliation = structuredClone(value);
          return value;
        },
      } : undefined;
      const attempt = await claimSupervisedModelAttempt({
        controller: ownership,
        executionHash: expected.executionHash,
        preparedBindingHash: initial.bindingHash,
        reviewHead: expected.reviewHead,
        store: api.store,
        readPrepared: async () => {
          observation();
          return bootstrap.readSupervisedBinding(api, preparation);
        },
        readReview: async () => observation().review,
        recheckExecution: async () => {
          observation();
          if (
            !(
              await frozenEntryFile(join(SOURCE, 'demo-execution.json'), executionHash, 262144)
            ).equals(packageBytes)
          )
            throw new Error('execution package changed');
          if (JSON.stringify(await check('metadata')) !== JSON.stringify(execution))
            throw new Error('execution context changed');
        },
        ...(fourth ? {transportRepairSuccessor: chainSuccessor} : {}),
        ...(third ? {diagnosticSuccessor: chainSuccessor} : {}),
        ...(successor ? { successor: {
          predecessor: execution.predecessor,
          observe: async () => {
            // This independently verifies the actual operator-paused run,
            // authority, runtime revisions and original preparation custody.
            await bootstrap.readSupervisedBinding(api, preparation);
            const actual = await check('predecessor');
            if (Object.keys(actual).sort().join(',') !==
                'expiresAt,lockHash,manifestHash,observedAt,resourcesAbsent' ||
                actual.lockHash !== execution.predecessor.lockHash ||
                actual.manifestHash !== execution.predecessor.manifestHash)
              throw new Error('actual predecessor reconciliation differs');
            const value = {
              predecessor: { ...execution.predecessor }, runId: initial.runId,
              nodeId: 'implement' as const, attemptNumber: 1 as const,
              outcomeClass: 'quality' as const, reasonCode: 'required_stage_failed' as const,
              runPaused: true as const, resourcesAbsent: actual.resourcesAbsent,
              observedAt: actual.observedAt, expiresAt: actual.expiresAt,
            };
            reconciliation = structuredClone(value);
            return value;
          },
        } } : {}),
      });
      // Observation is evidence only; this file is written AFTER the durable claim.
      const { open } = await import('node:fs/promises');
      const evidence = await open(join(control, 'model-observation.json'), 'wx', 0o600);
      try {
        await evidence.writeFile(observationRaw);
        await evidence.sync();
      } finally {
        await evidence.close();
      }
      if (fourth || third || successor) {
        if (!reconciliation) throw new Error('successor reconciliation evidence missing');
        const evidence = await open(join(control, 'predecessor-reconciliation.json'), 'wx', 0o600);
        try {
          await evidence.writeFile(JSON.stringify(reconciliation));
          await evidence.sync();
        } finally { await evidence.close(); }
      }
      const result = await forwardSupervisedLauncher({
        reader,
        nonce: expected.nonce,
        spawn: () =>
          Bun.spawn(
            [
              input.binaryPaths.python,
              '-I',
              '-B',
              join(SOURCE, 'scripts/staging/run-teetime-auth-canary.py'),
              '--docker',
              'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
              '--image',
              execution.image,
              '--expected-sha',
              execution.baseSource,
              '--nonce',
              expected.nonce,
              '--task',
              'supervised-demo',
              '--artifact-source',
              execution.source,
              '--demo-package-hash',
              executionHash,
            ],
            {
              cwd: control,
              env: {
                SYSTEMROOT: process.env.SYSTEMROOT!,
                WINDIR: process.env.WINDIR!,
                USERPROFILE: homedir(),
                PATH: dirname(input.binaryPaths.python),
              },
              stdin: 'pipe',
              stdout: 'pipe',
              stderr: 'ignore',
            }
          ),
        validateReady: async bytes => {
          await ownership.assertOwned();
          await check('ready', bytes);
        },
        validateReport: async bytes => {
          await ownership.assertOwned();
          return check('report', bytes);
        },
        emitReady: bytes => {
          process.stdout.write(bytes);
          process.stdout.write('\n');
        },
      }).catch(async error => {
        await api.store.completeProviderAttempt({
          attemptId: attempt.attemptId,
          completedAt: new Date().toISOString(),
          servedModelId: null,
          outcomeClass: 'quality',
          reasonCode: 'required_stage_indeterminate',
          resumeAt: null,
        });
        throw error; // Consumed claim/lock remain; no automatic relaunch.
      });
      const completedAt = new Date().toISOString();
      const completion = {
        attemptId: attempt.attemptId, completedAt, servedModelId: null,
        outcomeClass: result.summary.passed ? 'success' as const : 'quality' as const,
        reasonCode: result.summary.passed ? 'execution_completed' as const : 'required_stage_failed' as const,
        resumeAt: null,
      };
      const expectedCompleted = { ...attempt, ...completion };
      if (
        !(await api.store.completeProviderAttempt(completion))
      )
        throw new Error('attempt completion persistence failed');
      const persisted = await api.store.listProviderAttempts(initial.runId, 'implement');
      const completed = persisted.find(row => row.attemptId === attempt.attemptId);
      const history = fourth || third ? execution.predecessors : successor ? [execution.predecessor] : [];
      const historyChanged = history.some((prior: {attemptId: string;rowHash: string}) => {
        const row = persisted.find(item => item.attemptId === prior.attemptId);
        return !row || supervisedAttemptHash(row) !== prior.rowHash;
      });
      if (
        persisted.length !== (fourth ? 4 : third ? 3 : successor ? 2 : 1) || !completed ||
        supervisedAttemptHash(completed) !== supervisedAttemptHash(expectedCompleted) ||
        historyChanged
      )
        throw new Error('attempt completion readback differs');
      const receipt = await open(join(control, 'model-result.json'), 'wx', 0o600);
      try {
        await receipt.writeFile(result.report);
        await receipt.sync();
      } finally {
        await receipt.close();
      }
      await connection.closeDatabase();
      connection = undefined;
      if (result.summary.passed) await ownership.releaseAfterNormalCompletion();
      process.stdout.write(result.report);
      process.stdout.write('\n');
      if (!result.summary.passed) process.exitCode = 1;
      return { forwarded: true };
    }
    const binding = await bootstrap.prepareSupervisedRun(api, preparation);
    const readback = await bootstrap.readSupervisedBinding(api, preparation);
    if (JSON.stringify(binding) !== JSON.stringify(readback))
      throw new Error('actual binding readback differs');
    await connection.closeDatabase();
    connection = undefined;
    await ownership.releaseAfterNormalCompletion();
    return {
      kind: 'tee-time-supervised-prepare',
      passed: true,
      ...binding,
      accountProvided: false,
      modelInvocations: 0,
      operationalLaneReady: false,
    };
  } finally {
    if (connection) await connection.closeDatabase();
    // Abnormal outcome deliberately retains exclusive control/prepare claims.
  }
}
if (import.meta.main) {
  try {
    const result = await prepare();
    if (result.forwarded !== true) process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        kind:
          process.argv[2] === '--claim-minimal-diagnostic' ? 'tee-time-supervised-minimal-diagnostic' :
          ['--claim-model', '--claim-successor', '--claim-diagnostic-successor', '--claim-transport-repair'].includes(process.argv[2]!)
            ? 'tee-time-supervised-model'
            : 'tee-time-supervised-prepare',
        passed: false,
        failureCategory: error instanceof MinimalPersistenceUnresolved ? 'persistence-unresolved' : 'entry-rejected',
        accountProvided: ['--claim-minimal-diagnostic','--claim-model', '--claim-successor', '--claim-diagnostic-successor', '--claim-transport-repair'].includes(process.argv[2]!) ? null : false,
        modelInvocations: ['--claim-minimal-diagnostic','--claim-model', '--claim-successor', '--claim-diagnostic-successor', '--claim-transport-repair'].includes(process.argv[2]!) ? null : 0,
        operationalLaneReady: false,
      }) + '\n'
    );
    process.exitCode = 1;
  }
}
