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
  // No database consumer has been imported above this boundary.
  assertPrepareEnvironment(ROOT, join(homedir(), 'teetime-supervised-01'), process.env);
  const claim = process.argv[2] === '--claim-model';
  if (
    process.platform !== 'win32' ||
    Bun.version !== '1.3.13' ||
    SOURCE !== join(ROOT, claim ? 'execution-harness' : 'harness') ||
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
      'execution-source-manifest.json'
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
  const control = join(ROOT, 'control');
  if (claim) await ordinaryDirectory(control);
  else await mkdir(control); // No recursive reuse or stale-claim recovery.
  process.env.ARCHON_HOME = archon;
  process.env.DEFAULT_AI_ASSISTANT = 'codex';
  process.env.ARCHON_TELEMETRY_DISABLED = '1';
  process.env.DO_NOT_TRACK = '1';
  const bootstrap =
    await import('../../packages/workflows/src/reliability/tee-time-supervised-bootstrap');
  const caseHash = 'sha256:' + hash(raw);
  const ownership = await bootstrap.acquireSupervisedController(
    control,
    claim ? 'sha256:' + process.argv[6]! : caseHash
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
      preparationRoot: control,
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
    if (claim) {
      const { claimSupervisedModelAttempt } =
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
      async function check(mode: 'metadata' | 'ready' | 'report', bytes?: Buffer) {
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
            env: { SYSTEMROOT: process.env.SYSTEMROOT!, WINDIR: process.env.WINDIR! },
            stdin: bytes ? 'pipe' : 'ignore',
            stdout: 'pipe',
            stderr: 'ignore',
          }
        );
        const timer = setTimeout(() => child.kill(), 15000);
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
      if (
        !(await api.store.completeProviderAttempt({
          attemptId: attempt.attemptId,
          completedAt,
          servedModelId: null,
          outcomeClass: result.summary.passed ? 'success' : 'quality',
          reasonCode: result.summary.passed ? 'execution_completed' : 'required_stage_failed',
          resumeAt: null,
        }))
      )
        throw new Error('attempt completion persistence failed');
      const persisted = await api.store.listProviderAttempts(initial.runId, 'implement');
      if (
        persisted.length !== 1 ||
        persisted[0].attemptId !== attempt.attemptId ||
        persisted[0].completedAt !== completedAt ||
        persisted[0].outcomeClass !== (result.summary.passed ? 'success' : 'quality')
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
  } catch {
    process.stdout.write(
      JSON.stringify({
        kind:
          process.argv[2] === '--claim-model'
            ? 'tee-time-supervised-model'
            : 'tee-time-supervised-prepare',
        passed: false,
        failureCategory: 'entry-rejected',
        accountProvided: process.argv[2] === '--claim-model' ? null : false,
        modelInvocations: process.argv[2] === '--claim-model' ? null : 0,
        operationalLaneReady: false,
      }) + '\n'
    );
    process.exitCode = 1;
  }
}
