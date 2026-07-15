import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

delete process.env.ARCHON_OPERATOR_ACCESS_HOSTS;
delete process.env.ARCHON_OPERATOR_EMAILS;

function hex(len: number, seed: string): string {
  const base = '0123456789abcdef';
  let out = '';
  let x = 0;
  for (let i = 0; i < seed.length; i += 1) x = (x * 31 + seed.charCodeAt(i)) & 0xffff;
  for (let i = 0; i < len; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out += base[x & 0xf];
  }
  return out;
}

const HEAD = hex(40, 'head-101');
const BASE = hex(40, 'base');
const POLICY = hex(64, 'policy');
const VERIFIER = hex(64, 'verifier');
const EVIDENCE = hex(40, 'evidence-101');

const sampleSnapshot = {
  snapshot_id: 'snapshot-1',
  schema_version: 'm31-substrate-v1',
  repository: 'bluedevilcollectibles/bdc-harness',
  capture_started_at: '2026-07-14T00:00:00.000Z',
  capture_completed_at: '2026-07-14T00:00:00.000Z',
  operator_actor: 'xo-model',
  operator_model: 'claude',
  read_only_query_method: 'gh api (read-only)',
  base_branch: 'dev',
  base_sha: BASE,
  predecessor_snapshot_id: null,
  predecessor_evidence_git_blob: null,
  artifact_path: 'artifacts/snapshot.json',
  git_object_format: 'sha1',
  evidence_git_blob: hex(40, 'snap'),
  mutation_attempted: false,
  mutation_succeeded: false,
  fusion_calls_attempted: 0,
  fusion_calls_succeeded: 0,
  created_at: '2026-07-14T00:00:00.000Z',
  members: [
    {
      snapshot_id: 'snapshot-1',
      ordinal: 0,
      pr_number: 101,
      head_sha: HEAD,
      base_branch: 'dev',
      base_sha: BASE,
      state: 'open',
      checks: { conclusion: 'success' },
      check_source_sha: HEAD,
      checks_observed_at: '2026-07-14T00:00:00.000Z',
      review_state: 'approved',
      mergeability: 'mergeable',
      merge_state_status: 'clean',
      linked_work_evidence: { wo: 'WO-1' },
      evidence_artifact_path: 'artifacts/pr-101.json',
      git_object_format: 'sha1',
      evidence_git_blob: EVIDENCE,
      observed_at: '2026-07-14T00:00:00.000Z',
    },
  ],
};

const sampleProposal = {
  proposal_id: 'proposal-1',
  repository: 'bluedevilcollectibles/bdc-harness',
  pr_number: 101,
  head_sha: HEAD,
  base_branch: 'dev',
  base_sha: BASE,
  snapshot_id: 'snapshot-1',
  evidence_path: 'artifacts/proposal.json',
  evidence_git_blob: EVIDENCE,
  action_kind: 'MERGE',
  action_parameters: {},
  actor: 'xo-model',
  created_at: '2026-07-14T00:00:00.000Z',
  expires_at: '2026-07-14T00:15:00.000Z',
  execution_id: 'exec-1',
  capability: 'overseer.m31.merge',
  policy_digest: POLICY,
  verifier_registry_digest: VERIFIER,
};

const samplePermit = {
  permit_id: 'receipt-1',
  proposal_id: 'proposal-1',
  execution_id: 'exec-1',
  repository: 'bluedevilcollectibles/bdc-harness',
  pr_number: 101,
  head_sha: HEAD,
  base_branch: 'dev',
  base_sha: BASE,
  snapshot_id: 'snapshot-1',
  action_kind: 'MERGE',
  capability: 'overseer.m31.merge',
  issued_at: '2026-07-14T00:00:31.000Z',
  valid_until: '2026-07-14T00:01:30.000Z',
};

const sampleReceipt = {
  receipt_id: 'receipt-1',
  proposal_id: 'proposal-1',
  execution_id: 'exec-1',
  snapshot_id: 'snapshot-1',
  live_observation: {},
  live_observation_digest: hex(64, 'obs'),
  revalidated_at: '2026-07-14T00:00:30.000Z',
  valid_until: '2026-07-14T00:01:30.000Z',
  compare_result: 'permit_issued',
  provider_atomic_operation: null,
  created_at: '2026-07-14T00:00:31.000Z',
};

type Spy = ReturnType<typeof spyOn>;
let registerSpy: Spy;
let getSnapshotSpy: Spy;
let createProposalSpy: Spy;
let getProposalSpy: Spy;
let permitSpy: Spy;
const installedSpies: Spy[] = [];

function installSpies(): void {
  registerSpy = spyOn(mergeStewardDb, 'registerM31Snapshot').mockImplementation(
    (async () => sampleSnapshot) as never
  );
  getSnapshotSpy = spyOn(mergeStewardDb, 'getM31Snapshot').mockImplementation(
    (async () => sampleSnapshot as Record<string, unknown> | null) as never
  );
  const discrepancySpy = spyOn(mergeStewardDb, 'appendM31Discrepancy').mockImplementation(
    (async () => ({
      discrepancy_id: 'disc-1',
      snapshot_id: 'snapshot-1',
      evidence_git_blob: hex(40, 'disc'),
      affected_rows: [],
      observed_conflict: 'x',
      recorder: 'xo-model',
      recorded_at: '2026-07-14T00:00:00.000Z',
      resolution: null,
      predecessor_discrepancy_id: null,
    })) as never
  );
  createProposalSpy = spyOn(mergeStewardDb, 'createM31ActionProposal').mockImplementation(
    (async () => ({ ok: true, value: sampleProposal })) as never
  );
  getProposalSpy = spyOn(mergeStewardDb, 'getM31ActionProposal').mockImplementation(
    (async () => sampleProposal as Record<string, unknown> | null) as never
  );
  permitSpy = spyOn(m31Substrate, 'prepareM31ActionPermit').mockImplementation((async () => ({
    ok: true,
    permit: samplePermit,
    receipt: sampleReceipt,
  })) as never);
  installedSpies.push(
    registerSpy,
    getSnapshotSpy,
    discrepancySpy,
    createProposalSpy,
    getProposalSpy,
    permitSpy
  );
}

function restoreSpies(): void {
  for (const spy of installedSpies) spy.mockRestore();
  installedSpies.length = 0;
}

mock.module('@archon/core/db/dispatch', () => ({
  createMessage: mock(async () => ({})),
  listMessages: mock(async () => []),
  claimMessage: mock(async () => null),
  postResult: mock(async () => null),
  cancelMessage: mock(async () => null),
  registerWorker: mock(async () => ({})),
  heartbeatWorker: mock(async () => null),
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  toSafeConfig: mock(() => ({})),
  updateGlobalConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x' })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateAndSetTitle: mock(async () => {}),
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getArchonHome: () => '/tmp/.archon',
  getRunArtifactsPath: () => '/tmp/.archon/artifacts',
  isDocker: () => false,
  checkForUpdate: mock(async () => null),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test',
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  listConversations: mock(async () => []),
  findConversationByPlatformId: mock(async () => null),
  getOrCreateConversation: mock(async () => null),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/env-vars', () => ({
  listEnvVars: mock(async () => []),
  setEnvVar: mock(async () => null),
  deleteEnvVar: mock(async () => false),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  getCauldronDrainState: mock(async () => ({
    mode: 'normal',
    activeLeaseCount: 0,
    activeRunCount: 0,
    activeRunIds: [],
    drained: false,
    updatedAt: null,
  })),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => null),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';
import { setBoardPrincipalResolverForTests } from '@archon/core/db/board-authority';
import * as mergeStewardDb from '@archon/core/db/merge-steward';
import * as m31Substrate from '@archon/overseer/m31-substrate';

function makeApp(token?: string): OpenAPIHono {
  if (token) {
    process.env.ARCHON_OPERATOR_TOKEN = token;
  } else {
    delete process.env.ARCHON_OPERATOR_TOKEN;
  }
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const webAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
    registerStream: mock(() => {}),
    removeStream: mock(() => {}),
  } as unknown as WebAdapter;
  const lockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, webAdapter, lockManager);
  return app;
}

const TOKEN = 'secret-token';
const authHeaders = {
  'Content-Type': 'application/json',
  'x-archon-operator-token': TOKEN,
  'x-board-principal-token': 'board-token',
};

function snapshotBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    repository: 'bluedevilcollectibles/bdc-harness',
    capture_started_at: '2026-07-14T00:00:00.000Z',
    capture_completed_at: '2026-07-14T00:00:00.000Z',
    operator_actor: 'xo-model',
    operator_model: 'claude',
    read_only_query_method: 'gh api (read-only)',
    base_branch: 'dev',
    base_sha: BASE,
    artifact_path: 'artifacts/snapshot.json',
    git_object_format: 'sha1',
    evidence_git_blob: hex(40, 'snap'),
    members: [
      {
        pr_number: 101,
        head_sha: HEAD,
        base_branch: 'dev',
        base_sha: BASE,
        state: 'open',
        checks: { conclusion: 'success' },
        check_source_sha: HEAD,
        checks_observed_at: '2026-07-14T00:00:00.000Z',
        review_state: 'approved',
        mergeability: 'mergeable',
        merge_state_status: 'clean',
        linked_work_evidence: { wo: 'WO-1' },
        evidence_artifact_path: 'artifacts/pr-101.json',
        git_object_format: 'sha1',
        evidence_git_blob: EVIDENCE,
        observed_at: '2026-07-14T00:00:00.000Z',
      },
    ],
    ...over,
  });
}

function proposalBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    repository: 'bluedevilcollectibles/bdc-harness',
    pr_number: 101,
    head_sha: HEAD,
    base_branch: 'dev',
    base_sha: BASE,
    snapshot_id: 'snapshot-1',
    evidence_path: 'artifacts/proposal.json',
    action_kind: 'MERGE',
    action_parameters: {},
    actor: 'xo-model',
    policy_digest: POLICY,
    verifier_registry_digest: VERIFIER,
    ...over,
  });
}

function observationBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    observation: {
      known: true,
      repository: 'bluedevilcollectibles/bdc-harness',
      pr_number: 101,
      head_sha: HEAD,
      base_branch: 'dev',
      base_sha: BASE,
      policy_digest: POLICY,
      verifier_registry_digest: VERIFIER,
      observed_at: '2026-07-14T00:00:30.000Z',
    },
    ...over,
  });
}

describe('m31 merge-steward API', () => {
  beforeEach(() => {
    installSpies();
    setBoardPrincipalResolverForTests(async () => ({
      principal_id: 'xo-model',
      seat_id: 'xo',
      roles: ['acting_xo'],
    }));
  });

  afterEach(() => {
    setBoardPrincipalResolverForTests(undefined);
    restoreSpies();
  });

  test('requires operator token for snapshot registration when configured', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/overseer/m31/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: snapshotBody(),
    });
    expect(response.status).toBe(401);
    expect(registerSpy).not.toHaveBeenCalled();
  });

  test('rejects unknown snapshot body fields with a strict schema failure', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/overseer/m31/snapshots', {
      method: 'POST',
      headers: authHeaders,
      body: snapshotBody({ surprise: 'field' }),
    });
    expect(response.status).toBe(400);
    expect(registerSpy).not.toHaveBeenCalled();
  });

  test('rejects a non-hex evidence blob', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/overseer/m31/snapshots', {
      method: 'POST',
      headers: authHeaders,
      body: snapshotBody({ evidence_git_blob: 'nothex' }),
    });
    expect(response.status).toBe(400);
  });

  test('registers a snapshot (201) and forwards sorted members to the store', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/overseer/m31/snapshots', {
      method: 'POST',
      headers: authHeaders,
      body: snapshotBody(),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { snapshot: { snapshot_id: string } };
    expect(body.snapshot.snapshot_id).toBe('snapshot-1');
    expect(registerSpy).toHaveBeenCalledTimes(1);
    const arg = registerSpy.mock.calls[0]?.[0] as { members: unknown[] };
    expect(arg.members).toHaveLength(1);
  });

  test('reads a snapshot (200) or 404 when absent', async () => {
    const app = makeApp(TOKEN);
    const found = await app.request('/api/overseer/m31/snapshots/snapshot-1', {
      method: 'GET',
      headers: authHeaders,
    });
    expect(found.status).toBe(200);

    getSnapshotSpy.mockImplementation(async () => null);
    const missing = await app.request('/api/overseer/m31/snapshots/missing', {
      method: 'GET',
      headers: authHeaders,
    });
    expect(missing.status).toBe(404);
  });

  test('appends a discrepancy (201)', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/overseer/m31/snapshots/snapshot-1/discrepancies', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        evidence_git_blob: hex(40, 'disc'),
        affected_rows: [{ pr_number: 101 }],
        observed_conflict: 'checks changed',
        recorder: 'xo-model',
      }),
    });
    expect(response.status).toBe(201);
  });

  test('creates a proposal (201) and maps a typed failure to 409', async () => {
    const app = makeApp(TOKEN);
    const ok = await app.request('/api/overseer/m31/proposals', {
      method: 'POST',
      headers: authHeaders,
      body: proposalBody(),
    });
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as { proposal: { proposal_id: string } };
    expect(okBody.proposal.proposal_id).toBe('proposal-1');

    createProposalSpy.mockImplementation(async () => ({
      ok: false,
      failure: 'snapshot_not_chain_tip',
    }));
    const fail = await app.request('/api/overseer/m31/proposals', {
      method: 'POST',
      headers: authHeaders,
      body: proposalBody(),
    });
    expect(fail.status).toBe(409);
    const failBody = (await fail.json()) as { error: { failure: string } };
    expect(failBody.error.failure).toBe('snapshot_not_chain_tip');
  });

  test('rejects an unknown action kind at the schema layer (400)', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request('/api/overseer/m31/proposals', {
      method: 'POST',
      headers: authHeaders,
      body: proposalBody({ action_kind: 'READY' }),
    });
    expect(response.status).toBe(400);
    expect(createProposalSpy).not.toHaveBeenCalled();
  });

  test('reads a proposal (200) or 404 when absent', async () => {
    const app = makeApp(TOKEN);
    const found = await app.request('/api/overseer/m31/proposals/proposal-1', {
      method: 'GET',
      headers: authHeaders,
    });
    expect(found.status).toBe(200);

    getProposalSpy.mockImplementation(async () => null);
    const missing = await app.request('/api/overseer/m31/proposals/missing', {
      method: 'GET',
      headers: authHeaders,
    });
    expect(missing.status).toBe(404);
  });

  test('compare-and-consume issues a permit (200)', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request(
      '/api/overseer/m31/proposals/proposal-1/compare-and-consume',
      { method: 'POST', headers: authHeaders, body: observationBody() }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      permit: { execution_id: string };
      receipt: { provider_atomic_operation: null };
    };
    expect(body.permit.execution_id).toBe('exec-1');
    expect(body.receipt.provider_atomic_operation).toBeNull();
    expect(permitSpy).toHaveBeenCalledTimes(1);
  });

  test('compare-and-consume maps typed failure to 409, gate denial to 403, not_found to 404', async () => {
    const app = makeApp(TOKEN);

    permitSpy.mockImplementation(async () => ({ ok: false, failure: 'observation_stale' }));
    const stale = await app.request('/api/overseer/m31/proposals/proposal-1/compare-and-consume', {
      method: 'POST',
      headers: authHeaders,
      body: observationBody(),
    });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { error: { failure: string } };
    expect(staleBody.error.failure).toBe('observation_stale');

    permitSpy.mockImplementation(async () => ({
      ok: false,
      denied: { capability: 'overseer.m31.merge', reason: 'capability_mismatch' },
    }));
    const denied = await app.request('/api/overseer/m31/proposals/proposal-1/compare-and-consume', {
      method: 'POST',
      headers: authHeaders,
      body: observationBody(),
    });
    expect(denied.status).toBe(403);

    permitSpy.mockImplementation(async () => ({ ok: false, not_found: true }));
    const missing = await app.request(
      '/api/overseer/m31/proposals/proposal-1/compare-and-consume',
      { method: 'POST', headers: authHeaders, body: observationBody() }
    );
    expect(missing.status).toBe(404);
  });

  test('rejects unknown observation fields with a strict schema failure', async () => {
    const app = makeApp(TOKEN);
    const response = await app.request(
      '/api/overseer/m31/proposals/proposal-1/compare-and-consume',
      {
        method: 'POST',
        headers: authHeaders,
        body: observationBody({ extra: 'nope' }),
      }
    );
    expect(response.status).toBe(400);
    expect(permitSpy).not.toHaveBeenCalled();
  });

  test('rejects when the board principal is not authenticated (401)', async () => {
    setBoardPrincipalResolverForTests(async () => null);
    const app = makeApp(TOKEN);
    const response = await app.request('/api/overseer/m31/snapshots', {
      method: 'POST',
      headers: authHeaders,
      body: snapshotBody(),
    });
    expect(response.status).toBe(401);
    expect(registerSpy).not.toHaveBeenCalled();
  });
});
