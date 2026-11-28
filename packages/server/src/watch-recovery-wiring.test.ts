import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { getRunArtifactsPath } from '@archon/paths';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDatabase, getDatabase, resetDatabase } from '@archon/core/db/connection';
import { getOrCreateConversation } from '@archon/core/db/conversations';
import {
  acknowledgeMessage,
  addressMessage,
  createAuthenticatedMessage,
  listMessagesByCorrelationId,
} from '@archon/core/db/dispatch';
import {
  getOverseerRecoveryStages,
  listRunEventsForOverseer,
  listRunsForOverseerWatch,
} from '@archon/core/db/overseer';
import {
  createRunAuthority,
  createWorkflowRun,
  getRunAuthority,
  getWorkflowRun,
} from '@archon/core/db/workflows';
import {
  getM31ActionProposalV2,
  listM31ExecutionReceiptEventsV2,
} from '@archon/core/db/m31-target-v2';
import { getRecoveryExecutionClaim } from '@archon/core/db/execution-claims';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { WebAdapter } from './adapters/web';
import { registerApiRoutes } from './routes/api';
import { ConversationLockManager, loadConfig } from '@archon/core';
import { removeTempDirWithRetry } from '@archon/core/test/temp-dir';
import { hashWorkflowDefinition } from '@archon/workflows/reliability/runtime-revisions';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { composeOverseerRecovery } from './overseer-runtime';
import type { OverseerRecoveryTransport, RecoveryGitHubReads } from './overseer-recovery';
import { dispatchGuardedWoRun } from './routes/wo-fire-guard';
import { handleRecord } from '@archon/overseer/service';
import { watchOnce } from '@archon/overseer/watch';
import type { PullRequestEvidence } from '@archon/overseer';

const REPO = 'thinmansoftware/bdc-harness';
const REMOTE = `https://github.com/${REPO}.git`;
const WORKFLOW = 'bdc-feature-development';
const SPEC = 'Base branch: dev\n';
const SPEC_HASH = `sha256:${createHash('sha256').update(SPEC).digest('hex')}`;
const OLD = '2020-01-01T00:00:00.000Z';
const MISSING_PR: PullRequestEvidence = {
  exists: false,
  state: 'missing',
  mergeable: null,
  checks: { total: 0, passed: 0, failed: 0, pending: 0 },
};
const env = {
  OVERSEER_ENABLED: '1',
  OVERSEER_EMERGENCY_STOP: '0',
  OVERSEER_DRY_RUN: '0',
  OVERSEER_REPAIR_ACTIONS_ENABLED: '1',
  OVERSEER_JUDGE_FIRST: '1',
  OVERSEER_OWNER_ROUTING: 'off',
  SMART_CAULDRON_HERMETIC: '1',
};
const priorEnv = new Map<string, string | undefined>();
let home: string;
let base: string;
let path: string;
let workflowRevision: string;
let fireCalls: number;
let resumeCalls: number;
let fireWillThrow: boolean;
let resumeCompletes: boolean;

function runId(label: string): string {
  return createHash('sha256').update(label).digest('hex').slice(0, 32);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim();
}

async function sql(statement: string, params: unknown[] = []): Promise<void> {
  await getDatabase().query(statement, params);
}

beforeEach(async () => {
  await closeDatabase();
  resetDatabase();
  home = mkdtempSync(join(tmpdir(), 'watch-recovery-'));
  for (const key of [...Object.keys(env), 'ARCHON_HOME', 'DATABASE_URL'])
    priorEnv.set(key, process.env[key]);
  Object.assign(process.env, env, { ARCHON_HOME: home });
  delete process.env.DATABASE_URL;
  fireCalls = resumeCalls = 0;
  fireWillThrow = false;
  resumeCompletes = true;
  writeFileSync(join(home, 'config.yaml'), 'defaults:\n  loadDefaultWorkflows: false\n');
  path = join(home, 'fixture');
  mkdirSync(join(path, '.archon', 'workflows'), { recursive: true });
  writeFileSync(
    join(path, '.archon', 'workflows', `${WORKFLOW}.yaml`),
    `
name: ${WORKFLOW}
description: Recovery fixture
run_authority:
  required: true
  spec_repository: thinmansoftware/bdc-xo
  spec_revision: main
  spec_paths: ['docs/work-orders/{WO_ID}.md']
nodes:
  - id: verify
    bash: echo verified
    timeout: 2700000
`
  );
  git('init', '-b', 'dev');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Recovery Test');
  git('remote', 'add', 'origin', REMOTE);
  git('add', '.');
  git('commit', '-m', 'fixture base');
  base = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/dev', base);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev');
  git('switch', '-q', '-c', 'feat/recovery-fixture');
  writeFileSync(join(path, 'work.txt'), 'salvage');
  git('add', 'work.txt');
  git('commit', '-m', 'fixture salvage');
  const workflows = await discoverWorkflowsWithConfig(path, loadConfig);
  const definition = workflows.workflows.find(item => item.workflow.name === WORKFLOW)?.workflow;
  if (!definition || definition.nodes.length !== 1 || definition.nodes[0]?.id !== 'verify') {
    throw new Error('fixture_local_only_workflow_unavailable');
  }
  workflowRevision = hashWorkflowDefinition(definition);
  await sql(
    `INSERT INTO remote_agent_codebases (id, name, repository_url, default_cwd)
    VALUES ('codebase', $1, $2, $3)`,
    [REPO, REMOTE, path]
  );
  await sql(
    `UPDATE overseer_capability_state SET action_enabled=1, circuit_state='closed',
    policy_digest=$1, verifier_registry_digest=$2 WHERE capability='repair'`,
    ['a'.repeat(64), 'b'.repeat(64)]
  );
});

afterEach(async () => {
  await closeDatabase();
  resetDatabase();
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeTempDirWithRetry(home);
});

async function event(
  run: string,
  type: string,
  at = OLD,
  data = {},
  step = 'verify'
): Promise<void> {
  await sql(
    `INSERT INTO remote_agent_workflow_events
    (id, workflow_run_id, event_type, step_name, data, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [crypto.randomUUID(), runId(run), type, step, JSON.stringify(data), at]
  );
}

async function seed(
  id: string,
  status = 'failed',
  resumable = true,
  workingPath = path,
  previousWo?: string
): Promise<string> {
  const wo = previousWo ?? `WO-RECOVERY-${id.toUpperCase()}-01`;
  const conversation = await getOrCreateConversation('web', `test-${id}`);
  await sql(
    `INSERT INTO remote_agent_workflow_runs
    (id, workflow_name, conversation_id, parent_conversation_id, codebase_id, user_message, status, working_path,
    started_at, last_activity_at, completed_at)
    VALUES ($1,$2,$3,$3,'codebase',$4,$5,$6,$7,$7,$8)`,
    [
      runId(id),
      WORKFLOW,
      conversation.id,
      `WO_ID=${wo}`,
      status,
      workingPath,
      OLD,
      status === 'failed' ? OLD : null,
    ]
  );
  await createRunAuthority({
    runId: runId(id),
    dispatchId: `dispatch-${id}`,
    woId: wo,
    specSource: 'fixture/spec',
    specRevision: 'a'.repeat(40),
    specHash: SPEC_HASH,
    workflowName: WORKFLOW,
    codebaseId: 'codebase',
    canonicalRemote: REMOTE,
    baseBranch: 'dev',
    baseSha: base,
    runScopeSha: base,
    headBranch: 'feat/recovery-fixture',
    worktreePath: workingPath,
    workflowRevision,
    bundleRevision: 'sha256:fixture',
    engineRevision: 'sha256:fixture',
    runtimeImageRevision: null,
    createdAt: OLD,
  });
  if (workingPath === path) {
    const authority = await getRunAuthority(runId(id));
    const artifactDir = join(
      getRunArtifactsPath('thinmansoftware', 'bdc-harness', runId(id)),
      'authority'
    );
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, 'work-order.md'), SPEC);
    writeFileSync(join(artifactDir, 'run-authority.json'), JSON.stringify(authority));
  }
  if (resumable)
    await event(id, 'node_completed', OLD, { node_output: 'scope proven' }, 'capture-run-scope');
  if (status === 'failed') await event(id, 'node_failed', '2020-01-01T00:01:00.000Z');
  if (status === 'running') {
    await event(id, 'node_started', '2020-01-01T00:01:00.000Z');
    await sql(
      `INSERT INTO remote_agent_run_leases
      (run_id, owner_id, lease_token, acquired_at, last_heartbeat_at, expires_at)
      VALUES ($1,'lane',$3,$2,$2,$2)`,
      [runId(id), OLD, `lease-${id}`]
    );
  }
  return wo;
}

async function finish(id: string): Promise<void> {
  const completed = new Date().toISOString();
  await sql(
    `INSERT INTO remote_agent_workflow_events
    (id, workflow_run_id, event_type, created_at) VALUES ($1,$2,'workflow_completed',$3)`,
    [crypto.randomUUID(), id, completed]
  );
  await sql(
    `UPDATE remote_agent_workflow_runs SET status='completed', completed_at=$2 WHERE id=$1`,
    [id, completed]
  );
  await sql(
    `INSERT INTO remote_agent_run_outcomes
    (run_id, execution_state, deliverable_state, validation_state, recovery_state, route_state,
    primary_reason, reason_codes, evidence_refs, updated_at)
    VALUES ($1,'completed','pr_ready','passed','not_needed','current','completed','[]','[]',$2)`,
    [id, completed]
  );
}

const transport: OverseerRecoveryTransport = {
  async fire(binding) {
    fireCalls++;
    if (fireWillThrow) throw new Error('fixture response lost');
    const parent = await getOrCreateConversation('web', binding.platformId);
    const source = (await getRunAuthority(binding.runId))!;
    const id = runId(`successor-${binding.runId}`);
    await sql(
      `INSERT INTO remote_agent_workflow_runs
      (id, workflow_name, conversation_id, parent_conversation_id, codebase_id, user_message, status, working_path)
      VALUES ($1,$2,$3,$3,$4,$5,'pending',$6)`,
      [id, WORKFLOW, parent.id, binding.codebaseId, binding.message, source.worktreePath]
    );
    await createRunAuthority({ ...source, runId: id, dispatchId: `dispatch-${id}` });
    await finish(id);
    return id;
  },
  async resume(run, _workflow, activate) {
    resumeCalls++;
    await activate();
    const activated = await getWorkflowRun(run.id);
    expect(activated?.status).toBe('running');
    expect(activated?.completed_at).toBeNull();
    expect((activated ? new Date(activated.started_at).getTime() : 0) > Date.parse(OLD)).toBe(true);
    if (resumeCompletes) await finish(run.id);
  },
};

const github: RecoveryGitHubReads = {
  listOpenPullRequests: async () => [],
  findClaim: async () => null,
  fireEligibility: async woId => ({
    eligible: true,
    evidence: {
      woId,
      targetRepo: REPO,
      project: 'bdc-harness',
      noOpenOrMergedPr: true,
      specVerifiedAt: OLD,
      expectedSpec: {
        specSource: 'fixture/spec',
        specRevision: 'a'.repeat(40),
        specHash: SPEC_HASH,
      },
    },
  }),
  readSeatUsage: async () => {
    throw new Error('fixture seat data unavailable');
  },
  resolveOwner: async () => ({
    kind: 'owned',
    owner: 'operator',
    assigned_by: 'john',
    assigned_at: OLD,
    quote: 'fixture assignment',
    source_issue: 'thinmansoftware/bdc-xo#6720',
  }),
  readRemoteHead: async (_cwd, branch) => (branch === 'dev' ? base : null),
};

async function tick(reads = github, runtimeTransport = transport): Promise<void> {
  const { recovery } = composeOverseerRecovery(runtimeTransport, reads);
  const deps = {
    listRunsForWatch: () => listRunsForOverseerWatch(true),
    listRunEvents: listRunEventsForOverseer,
    findPullRequest: async () => MISSING_PR,
    insertOverseerAction: async () => undefined,
  };
  for (const record of await watchOnce(deps, { recovery, discoveryEnabled: false })) {
    await handleRecord(record, deps, false, 'test', undefined, undefined, recovery);
  }
}

async function stored(id: string) {
  const stages = await getOverseerRecoveryStages(runId(id));
  const recovery = stages.recovery_case
    ? (JSON.parse(stages.recovery_case) as {
        id: string;
        woId: string;
        repository: string;
        action: string;
        blocker: string | null;
      })
    : null;
  const proposal = recovery ? await getM31ActionProposalV2(recovery.id) : null;
  const claim =
    recovery && proposal
      ? await getRecoveryExecutionClaim({
          repository: recovery.repository,
          wo_id: recovery.woId,
          execution_id: proposal.execution_id,
          target_digest: proposal.target_digest,
        })
      : null;
  return { stages, recovery, proposal, claim };
}

test('WATCH_RECOVERY_01 exact resume and guarded first refire', async () => {
  await seed('resume');
  await tick();
  await tick();
  expect(resumeCalls).toBe(1);
  const resumed = await stored('resume');
  expect(resumed.claim?.completion_evidence).toMatchObject({
    status: 'succeeded',
    successor_run_id: null,
  });
  expect(resumed.stages.recovery_closed).toContain('recovered');

  process.env.OVERSEER_JUDGE_FIRST = '0';
  await sql(`UPDATE remote_agent_workflow_runs SET working_path=NULL WHERE id=$1`, [
    runId('resume'),
  ]);
  const wo = await seed('first', 'failed', false);
  await tick();
  await tick();
  expect(fireCalls).toBe(1);
  const fired = await stored('first');
  expect(fired.claim?.completion_evidence).toMatchObject({
    status: 'succeeded',
    successor_run_id: runId(`successor-${runId('first')}`),
  });
  expect(
    (await listM31ExecutionReceiptEventsV2(fired.proposal!.execution_id)).map(
      row => row.adapter_name
    )
  ).toContain('server-overseer-recovery');

  await sql('UPDATE remote_agent_workflow_runs SET working_path=NULL WHERE id IN ($1,$2)', [
    runId('first'),
    runId(`successor-${runId('first')}`),
  ]);
  await seed('later', 'failed', false, path, wo);
  await tick();
  await tick();
  expect((await stored('later')).recovery?.action).toBe('refire_later');
  expect((await stored('later')).claim?.completion_evidence).toMatchObject({
    status: 'succeeded',
    successor_run_id: runId(`successor-${runId('later')}`),
  });
  expect(fireCalls).toBe(2);

  // The server transport runs the real workflow executor. The fixture has only a
  // local bash node and supplies sinks for the Web adapter's output.
  await sql('UPDATE remote_agent_workflow_runs SET working_path=NULL WHERE id IN ($1,$2)', [
    runId('later'),
    runId(`successor-${runId('later')}`),
  ]);
  await seed('server-resume');
  let drained: () => void = () => undefined;
  const finished = new Promise<void>(resolve => {
    drained = resolve;
  });
  const webOutput = {
    sendMessage: async () => {},
    sendStructuredEvent: async () => {},
    setConversationDbId: () => {},
    setupEventBridge: () => drained,
    getPlatformType: () => 'web',
    getStreamingMode: () => 'batch',
  } as unknown as WebAdapter;
  const startupTransport = registerApiRoutes(
    new OpenAPIHono(),
    webOutput,
    new ConversationLockManager()
  );
  await tick(github, startupTransport);
  await finished;
  expect(
    (await listRunEventsForOverseer(runId('server-resume'))).some(
      row => row.event_type === 'overseer_recovery_resumed'
    )
  ).toBe(true);
  let calls = 0;
  await seed('competing', 'running', false, join(home, 'other'));
  const blocked = await dispatchGuardedWoRun({
    woId: 'WO-RECOVERY-COMPETING-01',
    dispatch: async () => ++calls,
  });
  expect(blocked).toMatchObject({ ok: false, error: 'duplicate_wo_live' });
  const moved = await dispatchGuardedWoRun({
    woId: 'WO-RECOVERY-FIRST-01',
    revalidate: async () => false,
    dispatch: async () => ++calls,
  });
  expect(moved).toMatchObject({ ok: false, error: 'recovery_target_changed' });
  const serverTransport = registerApiRoutes(
    new OpenAPIHono(),
    {} as WebAdapter,
    new ConversationLockManager()
  );
  for (const [woId, targetOk] of [
    ['WO-RECOVERY-COMPETING-01', true],
    ['WO-RECOVERY-FIRST-01', false],
  ] as const) {
    const platformId = `guarded-${woId}`;
    expect(
      await serverTransport.fire({
        runId: runId('different-predecessor'),
        woId,
        codebaseId: 'codebase',
        workflowName: WORKFLOW,
        workflowRevision,
        baseSha: base,
        platformId,
        message: `WO_ID=${woId}`,
        revalidate: async () => targetOk,
      })
    ).toBeNull();
    const { rows } = await getDatabase().query(
      'SELECT id FROM remote_agent_conversations WHERE platform_conversation_id=$1',
      [platformId]
    );
    expect(rows).toHaveLength(0);
  }
  expect(calls).toBe(0);
});

test('POST /run refuses the same WO while Overseer recovery is paused before persistence', async () => {
  const woId = await seed('admission-race');
  const conversationId = 'admission-race-post';
  const conversation = await getOrCreateConversation('web', conversationId);
  await sql(
    "UPDATE remote_agent_conversations SET codebase_id='codebase', title='Fixture' WHERE id=$1",
    [conversation.id]
  );
  const app = new OpenAPIHono();
  const locks = new ConversationLockManager();
  // Keep POST's handler queued if it is incorrectly admitted. The HTTP response
  // itself must refuse the competing request before it reaches the queue.
  const occupied = Promise.withResolvers<void>();
  await locks.acquireLock(conversationId, () => occupied.promise);
  registerApiRoutes(
    app,
    { setConversationDbId: () => {}, emitLockEvent: () => {} } as unknown as WebAdapter,
    locks
  );
  const entered = Promise.withResolvers<void>();
  const persist = Promise.withResolvers<void>();
  resumeCompletes = false;
  const recovery = tick(github, {
    ...transport,
    async resume(run, workflow, activate) {
      entered.resolve();
      await persist.promise;
      await transport.resume(run, workflow, activate);
    },
  });
  const post = async (): Promise<Response> => {
    await Promise.race([
      entered.promise,
      recovery.then(() => {
        throw new Error('recovery did not reach persistence');
      }),
    ]);
    try {
      return await app.request(`/api/workflows/${WORKFLOW}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message: `WO_ID=${woId}` }),
      });
    } finally {
      persist.resolve();
    }
  };
  try {
    const [response] = await Promise.all([post(), recovery]);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      accepted: false,
      error: 'wo_admission_in_progress',
    });
    expect(locks.getStats().queuedTotal).toBe(0);
    const { rows } = await getDatabase().query<{ id: string; status: string }>(
      'SELECT id, status FROM remote_agent_workflow_runs WHERE user_message = $1',
      [`WO_ID=${woId}`]
    );
    expect(rows).toEqual([{ id: runId('admission-race'), status: 'running' }]);
  } finally {
    if (locks.getStats().queuedTotal === 0) occupied.resolve();
  }
});

test('a queued POST /run holds admission against the Overseer refire transport', async () => {
  const workflowName = 'admission-fixture';
  const woId = 'WO-RECOVERY-QUEUED-01';
  const conversationId = 'admission-queued-post';
  const message = `WO_ID=${woId}`;
  writeFileSync(
    join(path, '.archon', 'workflows', `${workflowName}.yaml`),
    `name: ${workflowName}
description: Queued admission fixture
interactive: true
worktree:
  enabled: false
nodes:
  - id: verify
    bash: echo verified
`
  );
  const conversation = await getOrCreateConversation('web', conversationId);
  await sql(
    "UPDATE remote_agent_conversations SET codebase_id='codebase', cwd=$1, title='Fixture' WHERE id=$2",
    [path, conversation.id]
  );
  const app = new OpenAPIHono();
  const locks = new ConversationLockManager();
  const occupied = Promise.withResolvers<void>();
  const handled = Promise.withResolvers<void>();
  await locks.acquireLock(conversationId, () => occupied.promise);
  const recovery = registerApiRoutes(
    app,
    {
      emitLockEvent: (_id: string, locked: boolean) => {
        if (!locked) handled.resolve();
      },
      sendMessage: async () => {},
      setConversationDbId: () => {},
      getPlatformType: () => 'web',
      getStreamingMode: () => 'batch',
    } as unknown as WebAdapter,
    locks
  );
  try {
    const response = await app.request(`/api/workflows/${workflowName}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, message }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, status: 'queued-conversation' });
    const tierResponse = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codebaseId: 'codebase',
        message: `/workflow run ${workflowName} ${message}`,
      }),
    });
    expect(tierResponse.status).toBe(409);
    expect(await tierResponse.json()).toMatchObject({
      dispatched: false,
      error: 'wo_admission_in_progress',
    });
    let revalidationCalls = 0;
    expect(
      await recovery.fire({
        runId: runId('no-predecessor'),
        codebaseId: 'codebase',
        workflowName: WORKFLOW,
        workflowRevision,
        baseSha: base,
        platformId: 'admission-queued-refire',
        woId,
        message,
        revalidate: async () => {
          revalidationCalls++;
          return false;
        },
      })
    ).toBeNull();
    expect(revalidationCalls).toBe(0);
  } finally {
    occupied.resolve();
    if (locks.getStats().queuedTotal > 0) await handled.promise;
  }
  const { rows } = await getDatabase().query(
    "SELECT workflow_name, json_extract(metadata, '$.admitted_wo_id') AS wo_id FROM remote_agent_workflow_runs WHERE user_message = $1",
    [message]
  );
  expect(rows).toEqual([{ workflow_name: workflowName, wo_id: woId }]);
});

test('an expired dispatch cannot persist a run or release its replacement reservation', async () => {
  const woId = 'WO-RECOVERY-EXPIRED-01';
  const conversation = await getOrCreateConversation('web', 'expired-admission');
  const createRun = () =>
    createWorkflowRun({
      workflow_name: WORKFLOW,
      conversation_id: conversation.id,
      user_message: `WO_ID=${woId}`,
    });
  const entered = Promise.withResolvers<void>();
  const continueStaleDispatch = Promise.withResolvers<void>();
  const stale = dispatchGuardedWoRun({
    woId,
    async dispatch() {
      entered.resolve();
      await continueStaleDispatch.promise;
      return createRun();
    },
  });
  const staleOutcome = stale.then(
    () => null,
    (error: unknown) => error
  );
  try {
    await Promise.race([entered.promise, stale]);
    await sql('UPDATE wo_run_admissions SET expires_at_epoch = 0 WHERE wo_id = $1', [woId]);
    const replacement = await dispatchGuardedWoRun({
      woId,
      async dispatch() {
        continueStaleDispatch.resolve();
        const failure = await staleOutcome;
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain('wo_run_admission_expired_or_lost');
        const third = await dispatchGuardedWoRun({ woId, dispatch: createRun });
        expect(third).toMatchObject({ ok: false, error: 'wo_admission_in_progress' });
        return createRun();
      },
    });
    expect(replacement.ok).toBe(true);
    const { rows } = await getDatabase().query(
      'SELECT id FROM remote_agent_workflow_runs WHERE user_message = $1',
      [`WO_ID=${woId}`]
    );
    expect(rows).toHaveLength(1);
  } finally {
    continueStaleDispatch.resolve();
    await staleOutcome;
  }
});

test('WATCH_RECOVERY_02 released stall resumes and final handback stays closed to repair', async () => {
  await seed('stall', 'running');
  await event('stall', 'idle_handoff_overseer', '2020-01-01T00:02:00.000Z');
  await tick();
  expect((await stored('stall')).stages.recovery_observed).toContain(
    'waiting_for_safe_lane_release'
  );
  expect(resumeCalls).toBe(0);
  await sql('UPDATE remote_agent_run_leases SET released_at=$1 WHERE run_id=$2', [
    OLD,
    runId('stall'),
  ]);
  resumeCompletes = false;
  await tick();
  expect(resumeCalls).toBe(1);
  expect(
    (await listRunEventsForOverseer(runId('stall'))).filter(
      row => row.event_type === 'overseer_recovery_resumed'
    )
  ).toHaveLength(1);
  expect((await stored('stall')).claim?.reconciliation_status).toBe('required');
  await tick();
  await finish(runId('stall'));
  await tick();
  expect((await stored('stall')).stages.recovery_closed).toContain('recovered');
  await sql('UPDATE remote_agent_workflow_runs SET working_path=NULL WHERE id=$1', [
    runId('stall'),
  ]);

  await seed('returned', 'running', true, path);
  await event('returned', 'idle_handoff_overseer', '2020-01-01T00:02:00.000Z');
  await event(
    'returned',
    'run_outcome',
    '2020-01-01T00:03:00.000Z',
    {
      event_type: 'run_outcome',
      outcome: 'returned_to_author',
      run_id: runId('returned'),
    },
    'blocked-terminal-gate'
  );
  await sql('UPDATE remote_agent_run_leases SET released_at=$1 WHERE run_id=$2', [
    OLD,
    runId('returned'),
  ]);
  await tick();
  await tick();
  expect(resumeCalls).toBe(1);
  expect(fireCalls).toBe(0);
  const returned = await stored('returned');
  expect(returned.recovery?.blocker).toBe('returned_to_author');
  expect(returned.proposal).toBeNull();
});

test('held repair branch in a node_failed error refuses refire with no open PR', async () => {
  const id = 'held-branch';
  await seed(id, 'failed', false);
  await event(
    id,
    'node_failed',
    '2020-01-01T00:02:00.000Z',
    { error: 'repair_target_branch_held: feat/recovery-fixture is checked out' },
    'checkout-repair-target'
  );

  await tick();
  await tick();

  const blocked = await stored(id);
  expect(blocked.recovery?.action).toBeNull();
  expect(blocked.proposal).toBeNull();
  expect(blocked.stages.recovery_handoff).toBeDefined();
  expect(fireCalls).toBe(0);
  expect(resumeCalls).toBe(0);
});

test('WATCH_RECOVERY_03 healthy waits and fresh progress stay out of recovery', async () => {
  for (const status of ['pending', 'paused', 'waiting_provider'])
    await seed(status.replace('_', '-'), status);
  await seed('fresh', 'running', true, path);
  await tick(); // Old silence is seen while the lane still holds custody.
  await event('fresh', 'node_started', new Date(Date.now() - 30 * 60_000).toISOString());
  await sql('UPDATE remote_agent_run_leases SET released_at=$1 WHERE run_id=$2', [
    OLD,
    runId('fresh'),
  ]);
  await tick();
  expect(resumeCalls + fireCalls).toBe(0);
  for (const id of ['pending', 'paused', 'waiting-provider', 'fresh']) {
    expect((await stored(id)).recovery).toBeNull();
  }
});

test('WATCH_RECOVERY_04 a named handoff waits for the exact recipient to address it', async () => {
  await seed('handoff', 'failed', true, join(home, 'unavailable'));
  await tick();
  const pending = await stored('handoff');
  expect(pending.stages.recovery_handoff).toBeDefined();
  const correlationId = pending.recovery!.id;
  const [original] = await listMessagesByCorrelationId({ correlationId });
  expect(original?.recipient).toBe('operator');
  const observer = await createAuthenticatedMessage(
    { kind: 'system', sender: 'overseer' },
    {
      recipient: 'xo',
      task_type: 'agent_message',
      correlation_id: correlationId,
      idempotency_key: 'observer-copy',
      body: 'Observer',
    }
  );
  await acknowledgeMessage({ id: observer.id, principal_id: 'xo' });
  await addressMessage({ id: observer.id, principal_id: 'xo' });
  await acknowledgeMessage({ id: original!.id, principal_id: 'operator' });
  await tick();
  expect((await stored('handoff')).stages.recovery_closed).toBeUndefined();
  await addressMessage({ id: original!.id, principal_id: 'operator' });
  await tick();
  await tick();
  expect((await stored('handoff')).stages.recovery_closed).toContain('owner_accepted');
  expect((await listMessagesByCorrelationId({ correlationId })).map(row => row.id).sort()).toEqual(
    [observer.id, original!.id].sort()
  );
  expect(resumeCalls + fireCalls).toBe(0);
});

test('WATCH_RECOVERY_05 an armed response loss stays fenced after restart and expiry', async () => {
  await seed('throw', 'failed', false);
  fireWillThrow = true;
  await tick();
  const uncertain = await stored('throw');
  expect(fireCalls).toBe(1);
  expect(uncertain.claim).toMatchObject({
    effect_attempt_state: 'armed',
    reconciliation_status: 'required',
  });
  expect(
    (await listM31ExecutionReceiptEventsV2(uncertain.proposal!.execution_id)).map(
      row => row.event_type
    )
  ).toEqual(['permit_issued', 'effect_reserved', 'effect_indeterminate']);
  await sql('UPDATE board_execution_claims SET expires_at=$1 WHERE claim_id=$2', [
    OLD,
    uncertain.claim!.claim_id,
  ]);
  await event('throw', 'node_failed', new Date().toISOString());
  await Promise.all([tick(), tick()]);
  const replay = await stored('throw');
  expect(replay.proposal?.execution_id).toBe(uncertain.proposal?.execution_id);
  expect(replay.claim?.reconciliation_status).toBe('required');
  expect(replay.stages.recovery_closed).toBeUndefined();
  expect(fireCalls).toBe(1);
});
