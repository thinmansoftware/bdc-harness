import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, unlinkSync } from 'fs';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BASE_TOOL_NAMES } from '../../../companion-mcp/src/constants';
import { loadCompanionRegistry } from '../../../companion-mcp/src/registry';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import { setBoardPrincipalResolverForTests } from '@archon/core/db/board-authority';
import {
  createAuthenticatedMessage,
  registerWorker,
  type CreateAuthenticatedMessageData,
  type DispatchMessage,
} from '@archon/core/db/dispatch';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';
import { DispatchNonSystemCapability } from '../auth/dispatch-principal';

function setSenderAuthMode(mode: 'enforce'): void {
  process.env.DISPATCH_SENDER_AUTH_MODE = mode;
}

/** Test-local fixture constructor -- production path is createAuthenticatedMessage. */
async function createMessage(
  data: CreateAuthenticatedMessageData & { sender: string; sender_principal_id?: string | null }
): Promise<DispatchMessage> {
  if (data.sender_principal_id) {
    return createAuthenticatedMessage(
      testAuthenticatedCapability(data.sender_principal_id, data.sender),
      data
    );
  }
  return createAuthenticatedMessage(testLegacyCapability(data.sender), data);
}

function testAuthenticatedCapability(principalId: string, sender: string) {
  const token = `test-token-${principalId}-${sender}`;
  const priorRegistry = process.env.DISPATCH_PRINCIPALS_JSON;
  const priorMode = process.env.DISPATCH_SENDER_AUTH_MODE;
  try {
    setSenderAuthMode('enforce');
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: `test-${principalId}-${sender}`,
        principal_id: principalId,
        token_sha256: createHash('sha256').update(token).digest('hex'),
        status: 'active',
        send_as: [sender],
        receive_as: [sender],
        roles: ['send', 'receive'],
      },
    ]);
    return DispatchNonSystemCapability.fromAuthenticatedRequest({
      principal_id: principalId,
      token,
      requested_sender: sender,
    });
  } finally {
    if (priorRegistry === undefined) delete process.env.DISPATCH_PRINCIPALS_JSON;
    else process.env.DISPATCH_PRINCIPALS_JSON = priorRegistry;
    if (priorMode === undefined) delete process.env.DISPATCH_SENDER_AUTH_MODE;
    else process.env.DISPATCH_SENDER_AUTH_MODE = priorMode;
  }
}

function testLegacyCapability(sender: string) {
  const priorRegistry = process.env.DISPATCH_PRINCIPALS_JSON;
  const priorMode = process.env.DISPATCH_SENDER_AUTH_MODE;
  try {
    process.env.DISPATCH_SENDER_AUTH_MODE = 'off';
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'test-legacy-registry',
        principal_id: 'test-legacy-principal',
        token_sha256: '0'.repeat(64),
        status: 'active',
        send_as: ['claude'],
        receive_as: [],
        roles: ['send'],
      },
    ]);
    return DispatchNonSystemCapability.fromHttpRequest({ requested_sender: sender }).capability;
  } finally {
    if (priorRegistry === undefined) delete process.env.DISPATCH_PRINCIPALS_JSON;
    else process.env.DISPATCH_PRINCIPALS_JSON = priorRegistry;
    if (priorMode === undefined) delete process.env.DISPATCH_SENDER_AUTH_MODE;
    else process.env.DISPATCH_SENDER_AUTH_MODE = priorMode;
  }
}

let db: SqliteAdapter;
let currentDbPath = '';
let principal = {
  principal_id: 'claude',
  seat_id: 'xo' as const,
  roles: ['motion_notifier', 'petition_eligible'],
};

mock.module('@archon/core/db/connection', () => ({
  getDatabase: () => db,
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  toSafeConfig: mock(() => ({})),
  updateGlobalConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
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

for (const moduleName of [
  '@archon/core/db/conversations',
  '@archon/core/db/codebases',
  '@archon/core/db/env-vars',
  '@archon/core/db/isolation-environments',
  '@archon/core/db/workflows',
  '@archon/core/db/workflow-events',
  '@archon/core/db/messages',
  '@archon/core/utils/commands',
]) {
  mock.module(moduleName, () => ({
    listConversations: mock(async () => []),
    findConversationByPlatformId: mock(async () => null),
    getOrCreateConversation: mock(async () => null),
    softDeleteConversation: mock(async () => {}),
    updateConversationTitle: mock(async () => {}),
    getConversationById: mock(async () => null),
    listCodebases: mock(async () => []),
    getCodebase: mock(async () => null),
    deleteCodebase: mock(async () => {}),
    listEnvVars: mock(async () => []),
    setEnvVar: mock(async () => null),
    deleteEnvVar: mock(async () => false),
    listByCodebase: mock(async () => []),
    updateStatus: mock(async () => {}),
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
    listWorkflowEvents: mock(async () => []),
    addMessage: mock(async () => null),
    listMessages: mock(async () => []),
    findMarkdownFilesRecursive: mock(async () => []),
  }));
}

import { registerApiRoutes } from './api';

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function seedXoHolderLease(
  holderPrincipalId: string,
  options?: { expiresAt?: string; releasedAt?: string | null }
): Promise<{ holderToken: string; leaseId: string; fencingToken: number }> {
  const holderToken = `holder-${holderPrincipalId}`;
  const leaseId = `lease-${holderPrincipalId}`;
  const fencingToken = 44;
  await db.query('DELETE FROM board_xo_leases');
  await db.query(
    `INSERT INTO board_xo_leases
     (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
      acquired_at, renewed_at, expires_at, released_at)
     VALUES (1, $1, $2, 'xo', $2, $3, $4, $5, NULL, $6, $7)`,
    [
      leaseId,
      holderPrincipalId,
      sha(holderToken),
      fencingToken,
      new Date().toISOString(),
      options?.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
      options?.releasedAt ?? null,
    ]
  );
  return { holderToken, leaseId, fencingToken };
}

function xoSeatHeaders(proof: {
  holderToken: string;
  leaseId: string;
  fencingToken: number;
}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-archon-operator-token': 'secret-token',
    'x-board-principal-token': 'board-proof',
    'x-xo-holder-token': proof.holderToken,
    'x-xo-lease-id': proof.leaseId,
    'x-xo-fencing-token': String(proof.fencingToken),
  };
}

async function storedReceipt(id: string): Promise<{
  status: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  addressed_by: string | null;
  addressed_at: string | null;
}> {
  const stored = await db.query<{
    status: string;
    acknowledged_by: string | null;
    acknowledged_at: string | null;
    addressed_by: string | null;
    addressed_at: string | null;
  }>(
    `SELECT status, acknowledged_by, acknowledged_at, addressed_by, addressed_at
     FROM agent_dispatch_messages WHERE id = $1`,
    [id]
  );
  const row = stored.rows[0];
  if (!row) throw new Error(`missing dispatch message ${id}`);
  return row;
}

function cleanupDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      /* file may not exist */
    }
  }
}

async function insertSyntheticDispatch(input: {
  id: string;
  recipient: string;
  correlationId: string;
  seq: number;
  body: string;
  acknowledged: boolean;
  notBefore?: string | null;
}): Promise<void> {
  const createdAt = new Date(Date.UTC(2020, 0, 1) + input.seq * 1000).toISOString();
  await db.query(
    `INSERT INTO agent_dispatch_messages (
       id, correlation_id, idempotency_key, task_type, sender, recipient, body, status,
       created_at, priority, fencing_token, acknowledged_at, acknowledged_by, not_before, seq
     ) VALUES (
       $1, $2, $3, 'agent_message', 'xo', $4, $5, 'queued', $6, 'normal', 0, $7, $8, $9, $10
     )`,
    [
      input.id,
      input.correlationId,
      `idem-${input.id}`,
      input.recipient,
      input.body,
      createdAt,
      input.acknowledged ? createdAt : null,
      input.acknowledged ? input.recipient : null,
      input.notBefore ?? null,
      input.seq,
    ]
  );
}

function makeApp(
  token?: string,
  dispatchMailboxActorResolvedHook?: () => Promise<void>
): OpenAPIHono {
  if (token) process.env.ARCHON_OPERATOR_TOKEN = token;
  else delete process.env.ARCHON_OPERATOR_TOKEN;
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  registerApiRoutes(
    app,
    {
      setConversationDbId: mock(() => {}),
      emitSSE: mock(async () => {}),
      emitLockEvent: mock(async () => {}),
      registerStream: mock(() => {}),
      removeStream: mock(() => {}),
    } as unknown as WebAdapter,
    {
      acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
        await fn();
        return { status: 'started' };
      }),
      getStats: mock(() => ({ active: 0, queued: 0 })),
    } as unknown as ConversationLockManager,
    undefined,
    undefined,
    dispatchMailboxActorResolvedHook
  );
  return app;
}

const VALID_BODY = {
  correlation_id: 'corr-1',
  idempotency_key: 'idem-1',
  task_type: 'agent_message',
  sender: 'claude',
  recipient: 'codex',
  body: 'Please summarize this.',
};

const HISTORICAL_DISPATCH_REVISION = '2ee95173f5127b0566561b48c8ca8790c8f04b4f';
const LEGACY_DUPLICATE_AB_PROBE_NAME = 'api.dispatch.legacy-dup-ab.generated.test.ts';
const LEGACY_DUPLICATE_AB_IDS = [
  'control_recipient',
  'control_status',
  'control_limit',
  'control_subject_key',
  'control_route_disposition',
  'dup_recipient',
  'dup_status',
  'dup_limit',
  'dup_subject_key',
  'dup_route_disposition',
  'dup_unknown',
] as const;

type LegacyDuplicateAbBody =
  | { kind: 'array'; length: number }
  | { kind: 'non_array_200' }
  | { kind: 'error'; status: number; body: { error: string } }
  | { kind: 'unparsed'; status: number };

type LegacyDuplicateAbRow = {
  id: string;
  status: number;
  body: LegacyDuplicateAbBody;
};

type LegacyDuplicateAbEvidence = {
  revision: string;
  results: LegacyDuplicateAbRow[];
};

const LEGACY_DUP_AB_PROBE =
  "import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';\nimport { createHash } from 'crypto';\nimport { unlinkSync } from 'fs';\nimport { mkdtemp, rm, writeFile } from 'fs/promises';\nimport { tmpdir } from 'os';\nimport { join } from 'path';\nimport { OpenAPIHono } from '@hono/zod-openapi';\nimport type { ConversationLockManager } from '@archon/core';\nimport type { WebAdapter } from '../adapters/web';\nimport { SqliteAdapter } from '@archon/core/db/adapters/sqlite';\nimport { setBoardPrincipalResolverForTests } from '@archon/core/db/board-authority';\nimport {\n  createAuthenticatedMessage,\n  type CreateAuthenticatedMessageData,\n  type DispatchMessage,\n} from '@archon/core/db/dispatch';\nimport { validationErrorHook } from './openapi-defaults';\nimport { mockAllWorkflowModules } from '../test/workflow-mock-factories';\nimport { DispatchNonSystemCapability } from '../auth/dispatch-principal';\n\nfunction setSenderAuthMode(mode: 'enforce'): void {\n  process.env.DISPATCH_SENDER_AUTH_MODE = mode;\n}\n\n/** Test-local fixture constructor -- production path is createAuthenticatedMessage. */\nasync function createMessage(\n  data: CreateAuthenticatedMessageData & { sender: string; sender_principal_id?: string | null }\n): Promise<DispatchMessage> {\n  if (data.sender_principal_id) {\n    return createAuthenticatedMessage(\n      testAuthenticatedCapability(data.sender_principal_id, data.sender),\n      data\n    );\n  }\n  return createAuthenticatedMessage(testLegacyCapability(data.sender), data);\n}\n\nfunction testAuthenticatedCapability(principalId: string, sender: string) {\n  const token = `test-token-${principalId}-${sender}`;\n  const priorRegistry = process.env.DISPATCH_PRINCIPALS_JSON;\n  const priorMode = process.env.DISPATCH_SENDER_AUTH_MODE;\n  try {\n    setSenderAuthMode('enforce');\n    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([\n      {\n        credential_id: `test-${principalId}-${sender}`,\n        principal_id: principalId,\n        token_sha256: createHash('sha256').update(token).digest('hex'),\n        status: 'active',\n        send_as: [sender],\n        receive_as: [sender],\n        roles: ['send', 'receive'],\n      },\n    ]);\n    return DispatchNonSystemCapability.fromAuthenticatedRequest({\n      principal_id: principalId,\n      token,\n      requested_sender: sender,\n    });\n  } finally {\n    if (priorRegistry === undefined) delete process.env.DISPATCH_PRINCIPALS_JSON;\n    else process.env.DISPATCH_PRINCIPALS_JSON = priorRegistry;\n    if (priorMode === undefined) delete process.env.DISPATCH_SENDER_AUTH_MODE;\n    else process.env.DISPATCH_SENDER_AUTH_MODE = priorMode;\n  }\n}\n\nfunction testLegacyCapability(sender: string) {\n  const priorRegistry = process.env.DISPATCH_PRINCIPALS_JSON;\n  const priorMode = process.env.DISPATCH_SENDER_AUTH_MODE;\n  try {\n    process.env.DISPATCH_SENDER_AUTH_MODE = 'off';\n    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([\n      {\n        credential_id: 'test-legacy-registry',\n        principal_id: 'test-legacy-principal',\n        token_sha256: '0'.repeat(64),\n        status: 'active',\n        send_as: ['claude'],\n        receive_as: [],\n        roles: ['send'],\n      },\n    ]);\n    return DispatchNonSystemCapability.fromHttpRequest({ requested_sender: sender }).capability;\n  } finally {\n    if (priorRegistry === undefined) delete process.env.DISPATCH_PRINCIPALS_JSON;\n    else process.env.DISPATCH_PRINCIPALS_JSON = priorRegistry;\n    if (priorMode === undefined) delete process.env.DISPATCH_SENDER_AUTH_MODE;\n    else process.env.DISPATCH_SENDER_AUTH_MODE = priorMode;\n  }\n}\n\nlet db: SqliteAdapter;\nlet currentDbPath = '';\nlet dbDir = '';\n\nmock.module('@archon/core/db/connection', () => ({\n  getDatabase: () => db,\n}));\n\nmock.module('@archon/core', () => ({\n  handleMessage: mock(async () => {}),\n  getDatabaseType: () => 'sqlite',\n  loadConfig: mock(async () => ({})),\n  toSafeConfig: mock(() => ({})),\n  updateGlobalConfig: mock(async () => ({})),\n  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),\n  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),\n  ConversationNotFoundError: class ConversationNotFoundError extends Error {},\n  generateAndSetTitle: mock(async () => {}),\n}));\n\nmock.module('@archon/paths', () => ({\n  createLogger: () => ({\n    fatal: mock(() => undefined),\n    error: mock(() => undefined),\n    warn: mock(() => undefined),\n    info: mock(() => undefined),\n    debug: mock(() => undefined),\n    trace: mock(() => undefined),\n    child: mock(function (this: unknown) {\n      return this;\n    }),\n    bindings: mock(() => ({ module: 'test' })),\n    isLevelEnabled: mock(() => true),\n    level: 'info',\n  }),\n  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),\n  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),\n  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),\n  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),\n  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',\n  getArchonHome: () => '/tmp/.archon',\n  getRunArtifactsPath: () => '/tmp/.archon/artifacts',\n  isDocker: () => false,\n  checkForUpdate: mock(async () => null),\n  BUNDLED_IS_BINARY: false,\n  BUNDLED_VERSION: 'test',\n}));\n\nmockAllWorkflowModules();\n\nmock.module('@archon/git', () => ({\n  removeWorktree: mock(async () => {}),\n  toRepoPath: (p: string) => p,\n  toWorktreePath: (p: string) => p,\n}));\n\nfor (const moduleName of [\n  '@archon/core/db/conversations',\n  '@archon/core/db/codebases',\n  '@archon/core/db/env-vars',\n  '@archon/core/db/isolation-environments',\n  '@archon/core/db/workflows',\n  '@archon/core/db/workflow-events',\n  '@archon/core/db/messages',\n  '@archon/core/utils/commands',\n]) {\n  mock.module(moduleName, () => ({\n    listConversations: mock(async () => []),\n    findConversationByPlatformId: mock(async () => null),\n    getOrCreateConversation: mock(async () => null),\n    softDeleteConversation: mock(async () => {}),\n    updateConversationTitle: mock(async () => {}),\n    getConversationById: mock(async () => null),\n    listCodebases: mock(async () => []),\n    getCodebase: mock(async () => null),\n    deleteCodebase: mock(async () => {}),\n    listEnvVars: mock(async () => []),\n    setEnvVar: mock(async () => null),\n    deleteEnvVar: mock(async () => false),\n    listByCodebase: mock(async () => []),\n    updateStatus: mock(async () => {}),\n    listWorkflowRuns: mock(async () => []),\n    listDashboardRuns: mock(async () => ({\n      runs: [],\n      total: 0,\n      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },\n    })),\n    getWorkflowRun: mock(async () => null),\n    cancelWorkflowRun: mock(async () => {}),\n    getWorkflowRunByWorkerPlatformId: mock(async () => null),\n    getCauldronDrainState: mock(async () => ({\n      mode: 'normal',\n      activeLeaseCount: 0,\n      activeRunCount: 0,\n      activeRunIds: [],\n      drained: false,\n      updatedAt: null,\n    })),\n    listWorkflowEvents: mock(async () => []),\n    addMessage: mock(async () => null),\n    listMessages: mock(async () => []),\n    findMarkdownFilesRecursive: mock(async () => []),\n  }));\n}\n\nimport { registerApiRoutes } from './api';\n\nfunction sha(value: string): string {\n  return createHash('sha256').update(value).digest('hex');\n}\n\nfunction cleanupDb(path: string): void {\n  for (const suffix of ['', '-wal', '-shm']) {\n    try {\n      unlinkSync(path + suffix);\n    } catch {\n      /* file may not exist */\n    }\n  }\n}\n\nfunction makeApp(token?: string): OpenAPIHono {\n  if (token) process.env.ARCHON_OPERATOR_TOKEN = token;\n  else delete process.env.ARCHON_OPERATOR_TOKEN;\n  const app = new OpenAPIHono({ defaultHook: validationErrorHook });\n  registerApiRoutes(\n    app,\n    {\n      setConversationDbId: mock(() => {}),\n      emitSSE: mock(async () => {}),\n      emitLockEvent: mock(async () => {}),\n      registerStream: mock(() => {}),\n      removeStream: mock(() => {}),\n    } as unknown as WebAdapter,\n    {\n      acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {\n        await fn();\n        return { status: 'started' };\n      }),\n      getStats: mock(() => ({ active: 0, queued: 0 })),\n    } as unknown as ConversationLockManager\n  );\n  return app;\n}\n\nconst VALID_BODY = {\n  correlation_id: 'corr-legacy-dup',\n  idempotency_key: 'idem-legacy-dup',\n  task_type: 'agent_message' as const,\n  sender: 'claude',\n  recipient: 'codex',\n  body: 'synthetic legacy list fixture',\n};\n\nconst OPERATOR_TOKEN = 'synthetic-operator-token';\n\nconst CASES: Array<{ id: string; url: string; expectArray: boolean }> = [\n  {\n    id: 'control_recipient',\n    url: '/api/dispatch/messages?recipient=codex',\n    expectArray: true,\n  },\n  {\n    id: 'control_status',\n    url: '/api/dispatch/messages?recipient=codex&status=queued',\n    expectArray: true,\n  },\n  {\n    id: 'control_limit',\n    url: '/api/dispatch/messages?recipient=codex&limit=10',\n    expectArray: true,\n  },\n  {\n    id: 'control_subject_key',\n    url: '/api/dispatch/messages?recipient=codex&subject_key=wo:WO-MAILBOX',\n    expectArray: true,\n  },\n  {\n    id: 'control_route_disposition',\n    url: '/api/dispatch/messages?recipient=codex&route_disposition=auto_surfaced',\n    expectArray: true,\n  },\n  {\n    id: 'dup_recipient',\n    url: '/api/dispatch/messages?recipient=codex&recipient=xo',\n    expectArray: false,\n  },\n  {\n    id: 'dup_status',\n    url: '/api/dispatch/messages?recipient=codex&status=queued&status=done',\n    expectArray: false,\n  },\n  {\n    id: 'dup_limit',\n    url: '/api/dispatch/messages?recipient=codex&limit=10&limit=20',\n    expectArray: false,\n  },\n  {\n    id: 'dup_subject_key',\n    url: '/api/dispatch/messages?recipient=codex&subject_key=wo:WO-MAILBOX&subject_key=other',\n    expectArray: false,\n  },\n  {\n    id: 'dup_route_disposition',\n    url: '/api/dispatch/messages?recipient=codex&route_disposition=auto_surfaced&route_disposition=expired',\n    expectArray: false,\n  },\n  {\n    id: 'dup_unknown',\n    url: '/api/dispatch/messages?recipient=codex&not_a_selector=1&not_a_selector=2',\n    expectArray: true,\n  },\n];\n\ntype Sanitized =\n  | { kind: 'array'; length: number }\n  | { kind: 'non_array_200' }\n  | { kind: 'error'; status: number; body: unknown }\n  | { kind: 'unparsed'; status: number };\n\nasync function sanitize(response: Response): Promise<{ status: number; body: Sanitized }> {\n  const status = response.status;\n  const text = await response.text();\n  let parsed: unknown;\n  try {\n    parsed = JSON.parse(text) as unknown;\n  } catch {\n    return { status, body: { kind: 'unparsed', status } };\n  }\n  if (status === 200 && Array.isArray(parsed)) {\n    return { status, body: { kind: 'array', length: parsed.length } };\n  }\n  if (status === 200) {\n    return { status, body: { kind: 'non_array_200' } };\n  }\n  return { status, body: { kind: 'error', status, body: parsed } };\n}\n\ndescribe('legacy duplicate query product-route A/B', () => {\n  beforeEach(async () => {\n    delete process.env.DATABASE_URL;\n    process.env.BUN_ENV = 'test';\n    process.env.GITHUB_TOKEN = 'test-token';\n    process.env.DISPATCH_WORKER_CREDENTIALS_JSON = JSON.stringify([\n      {\n        credential_id: 'board-worker-1',\n        worker_id: 'worker-a',\n        role: 'board_delivery_worker',\n        allowed_principals: ['claude'],\n        token_sha256: sha('worker-secret'),\n        status: 'active',\n      },\n    ]);\n    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([\n      {\n        credential_id: 'default-claude',\n        principal_id: 'claude-principal',\n        token_sha256: sha('claude-secret'),\n        status: 'active',\n        send_as: ['claude'],\n        receive_as: ['claude'],\n        roles: ['send', 'receive'],\n      },\n    ]);\n    setBoardPrincipalResolverForTests(async () => ({\n      principal_id: 'claude',\n      seat_id: 'xo' as const,\n      roles: ['motion_notifier', 'petition_eligible'],\n    }));\n    dbDir = await mkdtemp(join(tmpdir(), 'legacy-dup-ab-'));\n    currentDbPath = join(dbDir, 'dispatch.db');\n    db = new SqliteAdapter(currentDbPath);\n    globalThis.fetch = (async () =>\n      new Response(JSON.stringify({ ok: true }), {\n        status: 200,\n        headers: { 'content-type': 'application/json' },\n      })) as typeof fetch;\n  });\n\n  afterEach(async () => {\n    setBoardPrincipalResolverForTests(undefined);\n    delete process.env.ARCHON_OPERATOR_TOKEN;\n    delete process.env.GITHUB_TOKEN;\n    delete process.env.DISPATCH_WORKER_CREDENTIALS_JSON;\n    delete process.env.DISPATCH_PRINCIPALS_JSON;\n    delete process.env.DISPATCH_SENDER_AUTH_MODE;\n    await db.close();\n    cleanupDb(currentDbPath);\n    await rm(dbDir, { recursive: true, force: true });\n  });\n\n  test('records legacy duplicate query statuses', async () => {\n    await createMessage(VALID_BODY);\n    const app = makeApp(OPERATOR_TOKEN);\n    const revision = process.env.WO_AB_REVISION ?? 'unknown';\n    const results: Array<{ id: string; status: number; body: Sanitized }> = [];\n\n    for (const item of CASES) {\n      const response = await app.request(item.url, {\n        headers: { 'x-archon-operator-token': OPERATOR_TOKEN },\n      });\n      const sanitized = await sanitize(response);\n      results.push({ id: item.id, status: sanitized.status, body: sanitized.body });\n    }\n\n    const resultPath = process.env.WO_AB_RESULT_PATH;\n    if (resultPath === undefined || resultPath === '') throw new Error('missing_ab_result_path');\n    await writeFile(resultPath, JSON.stringify({ revision, results }));\n\n    for (const item of CASES) {\n      const found = results.find(row => row.id === item.id);\n      expect(found?.status).not.toBe(401);\n      if (item.expectArray) {\n        expect(found?.status).toBe(200);\n        expect(found?.body).toMatchObject({ kind: 'array' });\n      }\n    }\n\n    const seeded = results.find(row => row.id === 'control_recipient');\n    expect(seeded?.body).toEqual({ kind: 'array', length: 1 });\n  });\n});\n";

function gitOutput(cwd: string, args: readonly string[]): string {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

function objectField(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function parseLegacyDuplicateAbBody(value: unknown): LegacyDuplicateAbBody {
  if (typeof value !== 'object' || value === null) throw new Error('ab_evidence_body_invalid');
  const kind = objectField(value, 'kind');
  const length = objectField(value, 'length');
  const status = objectField(value, 'status');
  if (kind === 'array' && typeof length === 'number') {
    return { kind: 'array', length };
  }
  if (kind === 'non_array_200') return { kind: 'non_array_200' };
  if (kind === 'unparsed' && typeof status === 'number') {
    return { kind: 'unparsed', status };
  }
  if (kind === 'error' && typeof status === 'number') {
    const nested = objectField(value, 'body');
    if (typeof nested !== 'object' || nested === null) throw new Error('ab_evidence_error_invalid');
    const error = objectField(nested, 'error');
    if (typeof error !== 'string') throw new Error('ab_evidence_error_invalid');
    return { kind: 'error', status, body: { error } };
  }
  throw new Error('ab_evidence_body_invalid');
}

function parseLegacyDuplicateAbEvidence(text: string, revision: string): LegacyDuplicateAbEvidence {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('ab_evidence_invalid');
  if (objectField(parsed, 'revision') !== revision)
    throw new Error('ab_evidence_revision_mismatch');
  const results = objectField(parsed, 'results');
  if (!Array.isArray(results)) throw new Error('ab_evidence_results_invalid');
  return {
    revision,
    results: results.map(item => {
      if (typeof item !== 'object' || item === null) throw new Error('ab_evidence_row_invalid');
      const id = objectField(item, 'id');
      const status = objectField(item, 'status');
      if (typeof id !== 'string' || typeof status !== 'number') {
        throw new Error('ab_evidence_row_invalid');
      }
      return { id, status, body: parseLegacyDuplicateAbBody(objectField(item, 'body')) };
    }),
  };
}

function abRow(evidence: LegacyDuplicateAbEvidence, id: string): LegacyDuplicateAbRow {
  const row = evidence.results.find(item => item.id === id);
  if (!row) throw new Error(`missing_ab_row:${id}`);
  return row;
}

// Symlinks only the already-installed dependency trees. The probe imports ./api
// from whichever checkout it is written into, so each revision loads its own route.
async function linkInstalledModules(currentRoot: string, historicalRoot: string): Promise<void> {
  await symlink(join(currentRoot, 'node_modules'), join(historicalRoot, 'node_modules'));
  const packageNames = await readdir(join(currentRoot, 'packages'));
  for (const name of packageNames) {
    const source = join(currentRoot, 'packages', name, 'node_modules');
    const historicalPackage = join(historicalRoot, 'packages', name);
    if (!existsSync(source) || !existsSync(historicalPackage)) continue;
    await symlink(source, join(historicalPackage, 'node_modules'));
  }
}

function childProbeEnv(revision: string, resultPath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  delete env.DATABASE_URL;
  env.WO_AB_REVISION = revision;
  env.WO_AB_RESULT_PATH = resultPath;
  return env;
}

async function runLegacyDuplicateProbe(
  checkoutRoot: string,
  revision: string,
  resultPath: string
): Promise<LegacyDuplicateAbEvidence> {
  const probePath = join(
    checkoutRoot,
    'packages/server/src/routes',
    LEGACY_DUPLICATE_AB_PROBE_NAME
  );
  await writeFile(probePath, LEGACY_DUP_AB_PROBE);
  try {
    const proc = Bun.spawnSync(
      [
        process.execPath,
        'test',
        '--timeout',
        '20000',
        `./packages/server/src/routes/${LEGACY_DUPLICATE_AB_PROBE_NAME}`,
      ],
      {
        cwd: checkoutRoot,
        env: childProbeEnv(revision, resultPath),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 20_000,
      }
    );
    if (proc.exitCode !== 0) {
      throw new Error(
        `ab_probe_failed:${revision}:${proc.exitCode}:${proc.stderr.toString()}\n${proc.stdout.toString()}`
      );
    }
    return parseLegacyDuplicateAbEvidence(await readFile(resultPath, 'utf8'), revision);
  } finally {
    try {
      unlinkSync(probePath);
    } catch {
      /* probe file is removed when the process still owns the checkout */
    }
  }
}

async function recordLegacyDuplicateProductRouteAb(): Promise<{
  historical: LegacyDuplicateAbEvidence;
  current: LegacyDuplicateAbEvidence;
}> {
  const currentRoot = gitOutput(import.meta.dir, ['rev-parse', '--show-toplevel']);
  const parent = await mkdtemp(join(tmpdir(), 'legacy-dup-ab-'));
  const historicalRoot = join(parent, 'historical');
  let added = false;
  try {
    gitOutput(currentRoot, [
      'worktree',
      'add',
      '--detach',
      historicalRoot,
      HISTORICAL_DISPATCH_REVISION,
    ]);
    added = true;
    await linkInstalledModules(currentRoot, historicalRoot);
    const historicalSha = gitOutput(historicalRoot, ['rev-parse', 'HEAD']);
    if (historicalSha !== HISTORICAL_DISPATCH_REVISION) {
      throw new Error(`historical_revision_mismatch:${historicalSha}`);
    }
    const currentSha = gitOutput(currentRoot, ['rev-parse', 'HEAD']);
    const historicalSchema = await readFile(
      join(historicalRoot, 'packages/server/src/routes/schemas/dispatch.schemas.ts'),
      'utf8'
    );
    const currentSchema = await readFile(
      join(currentRoot, 'packages/server/src/routes/schemas/dispatch.schemas.ts'),
      'utf8'
    );
    if (
      historicalSchema === currentSchema ||
      historicalSchema.includes('legacyDuplicateQueryMessage') ||
      !currentSchema.includes('legacyDuplicateQueryMessage')
    ) {
      throw new Error('ab_schema_sources_not_distinct');
    }
    const historical = await runLegacyDuplicateProbe(
      historicalRoot,
      historicalSha,
      join(parent, 'historical.json')
    );
    const current = await runLegacyDuplicateProbe(
      currentRoot,
      currentSha,
      join(parent, 'current.json')
    );
    return { historical, current };
  } finally {
    if (added) {
      Bun.spawnSync(['git', 'worktree', 'remove', '--force', historicalRoot], {
        cwd: currentRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }
    await rm(parent, { recursive: true, force: true });
    if (added) {
      Bun.spawnSync(['git', 'worktree', 'prune'], {
        cwd: currentRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });
    }
  }
}

describe('dispatch API', () => {
  beforeEach(() => {
    process.env.BUN_ENV = 'test';
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.DISPATCH_WORKER_CREDENTIALS_JSON = JSON.stringify([
      {
        credential_id: 'board-worker-1',
        worker_id: 'worker-a',
        role: 'board_delivery_worker',
        allowed_principals: ['claude'],
        token_sha256: sha('worker-secret'),
        status: 'active',
      },
    ]);
    // Headerless off/warn create paths still require a parseable registry.
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'default-claude',
        principal_id: 'claude-principal',
        token_sha256: sha('claude-secret'),
        status: 'active',
        send_as: ['claude'],
        receive_as: ['claude'],
        roles: ['send', 'receive'],
      },
      {
        credential_id: 'default-xo',
        principal_id: 'xo-principal',
        token_sha256: sha('xo-secret'),
        status: 'active',
        send_as: ['xo'],
        receive_as: ['xo'],
        roles: ['send'],
      },
    ]);
    principal = {
      principal_id: 'claude',
      seat_id: 'xo',
      roles: ['motion_notifier', 'petition_eligible'],
    };
    setBoardPrincipalResolverForTests(async () => principal);
    currentDbPath = join(
      import.meta.dir,
      `.test-api-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/git/ref/heads/main')) {
        return Response.json({ object: { sha: 'b'.repeat(40) } });
      }
      return Response.json({
        type: 'file',
        sha: 'a'.repeat(40),
        content: Buffer.from('# M-27: Board Motion Dispatch\n', 'utf8').toString('base64'),
      });
    }) as typeof fetch;
  });

  afterEach(async () => {
    setBoardPrincipalResolverForTests(undefined);
    delete process.env.ARCHON_OPERATOR_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.DISPATCH_WORKER_CREDENTIALS_JSON;
    delete process.env.DISPATCH_PRINCIPALS_JSON;
    delete process.env.DISPATCH_SENDER_AUTH_MODE;
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('rejects unsupported task_type with named validation error', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, task_type: 'run_bash' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('task_type');
  });

  test('rejects repo-mutating agent_message body before insert', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...VALID_BODY,
        body: 'Commit the patch, push the branch, merge it to dev, and deploy production.',
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'repo_mutating_agent_message_rejected'
    );
  });

  test('requires operator token when configured', async () => {
    const response = await makeApp('secret-token').request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(response.status).toBe(401);
  });

  test('creates and deduplicates dispatch messages with operator token', async () => {
    const app = makeApp('secret-token');
    const first = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify(VALID_BODY),
    });
    const second = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ ...VALID_BODY, body: 'second body' }),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { body: string }).body).toBe('Please summarize this.');
  });

  test('passes route_disposition through the HTTP list route', async () => {
    const surfaced = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'list-surfaced',
      recipient: 'operator',
    });
    await createMessage({
      ...VALID_BODY,
      idempotency_key: 'list-undisposed',
      recipient: 'operator',
    });
    await db.query(
      "UPDATE agent_dispatch_messages SET route_disposition = 'auto_surfaced', route_disposed_at = $2 WHERE id = $1",
      [surfaced.id, new Date().toISOString()]
    );

    const response = await makeApp().request(
      '/api/dispatch/messages?recipient=operator&route_disposition=auto_surfaced'
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as Array<{ id: string }>).map(row => row.id)).toEqual([
      surfaced.id,
    ]);
  });

  // WO-HARNESS-DISPATCH-ASTRA-MAILBOX-01: a message to astra is accepted,
  // never claimed by any worker, and only its own actor may ack/address it.
  test('routes astra as an unclaimable mailbox recipient over HTTP', async () => {
    const app = makeApp('secret-token');
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host',
      capabilities: { providers: ['claude', 'codex', 'grok', 'cursor'] },
      max_concurrency: 1,
    });

    // (a) posting to astra succeeds and queues the row.
    const created = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        idempotency_key: 'idem-astra-http',
        recipient: 'astra',
        body: 'Arc D ruling for Astra.',
      }),
    });
    expect(created.status).toBe(200);
    const message = (await created.json()) as { id: string; recipient: string; status: string };
    expect(message.recipient).toBe('astra');
    expect(message.status).toBe('queued');

    // (b) a worker with every agent configured cannot claim the astra row --
    // claimMessage refuses any non-worker_poll principal, so the drop-box
    // desktop worker's generic codex leg never takes it. It stays queued/unleased.
    const claim = await app.request(`/api/dispatch/messages/${message.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ worker_id: 'worker-a' }),
    });
    expect(claim.status).toBe(404);
    const stored = await db.query<{ status: string; lease_owner: string | null }>(
      'SELECT status, lease_owner FROM agent_dispatch_messages WHERE id = $1',
      [message.id]
    );
    expect(stored.rows[0]).toEqual({ status: 'queued', lease_owner: null });

    // A body principal is only a cross-check against the authenticated operator actor.
    const wrongAck = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ principal_id: 'codex' }),
    });
    expect(wrongAck.status).toBe(409);
    expect(((await wrongAck.json()) as { error: string }).error).toBe('actor_mismatch');

    // No credential binding exists for astra, so the operator token cannot sign for it.
    const ack = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ principal_id: ' Astra ' }),
    });
    expect(ack.status).toBe(409);
    expect(((await ack.json()) as { error: string }).error).toBe('actor_mismatch');
  });

  test('returns an existing HTTP idempotency row after its recipient becomes inactive', async () => {
    const app = makeApp('secret-token');
    const first = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ ...VALID_BODY, recipient: ' Operator ' }),
    });
    expect(first.status).toBe(200);
    const original = (await first.json()) as { id: string; body: string };
    await db.query("UPDATE dispatch_principals SET active = 0 WHERE principal_id = 'operator'");

    const retry = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        correlation_id: 'retry-correlation',
        recipient: 'operator',
        body: 'This retry must return the original row.',
      }),
    });

    expect(retry.status).toBe(200);
    expect((await retry.json()) as { id: string; body: string }).toMatchObject(original);
    expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(1);
  });

  test('publishes Phase 0 dispatch priority and mailbox fields in OpenAPI schemas', async () => {
    const response = await makeApp().request('/api/openapi.json');
    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      components: { schemas: Record<string, { properties: Record<string, unknown> }> };
    };
    const messageProperties = spec.components.schemas.DispatchMessage?.properties;
    const createProperties = spec.components.schemas.CreateDispatchMessageBody?.properties;
    expect(messageProperties).toMatchObject({
      priority: { enum: ['blocker', 'normal', 'heartbeat'] },
      task_outcome: { nullable: true },
      acknowledged_at: { nullable: true },
      acknowledged_by: { nullable: true },
      addressed_at: { nullable: true },
      addressed_by: { nullable: true },
      escalated_tg_at: { nullable: true },
      escalated_sms_at: { nullable: true },
      subject_key: { nullable: true },
      route_disposition: { nullable: true },
      supersedes_id: { nullable: true },
    });
    expect(createProperties).toMatchObject({
      priority: { enum: ['blocker', 'normal', 'heartbeat'] },
    });
  });

  test('rejects an absent recipient with a named error before insert', async () => {
    const response = await makeApp('secret-token').request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ ...VALID_BODY, recipient: ' Missing ' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'dispatch_recipient_rejected:missing_principal'
    );
    expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(0);
  });

  test('rejects an inactive recipient with a named error before insert', async () => {
    const response = await makeApp('secret-token').request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ ...VALID_BODY, recipient: ' John ' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'dispatch_recipient_rejected:inactive_principal'
    );
    expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(0);
  });

  test('requires seated motion_notifier for board_motion before insert', async () => {
    principal = { principal_id: 'john-ranson', seat_id: 'john', roles: [] };
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        task_type: 'board_motion',
        sender: 'spoof',
        recipient: 'board',
        body: JSON.stringify({
          motion_id: 'M-27',
          title: 'Board Motion Dispatch',
          file_path: 'docs/board/motions/M-27.md',
        }),
      }),
    });
    expect(response.status).toBe(403);
    expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(0);
  });

  test('creates board_motion with server-derived sender and idempotency key', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        idempotency_key: 'caller-spoof',
        task_type: 'board_motion',
        sender: 'spoof',
        recipient: 'board',
        body: JSON.stringify({
          motion_id: 'M-27',
          title: 'Board Motion Dispatch',
          file_path: 'docs/board/motions/M-27.md',
        }),
      }),
    });
    expect(response.status).toBe(200);
    const message = (await response.json()) as {
      sender: string;
      idempotency_key: string;
      recipient_alias: string;
    };
    expect(message.sender).toBe('claude');
    expect(message.recipient_alias).toBe('board');
    expect(message.idempotency_key).toBe(`board-motion:M-27:${'a'.repeat(40)}:board`);
  });

  test('authorizes a canonicalized board petition recipient', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        task_type: 'agent_message',
        recipient: ' BOARD ',
        body: JSON.stringify({
          motion_id: 'M-27',
          file_path: 'docs/board/motions/M-27.md',
          requested_action: 'open discussion',
        }),
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { recipient: string }).toMatchObject({ recipient: 'board' });
  });

  test('does not let a canonicalized board idempotency retry bypass board authorization', async () => {
    const app = makeApp();
    const body = {
      ...VALID_BODY,
      recipient: ' BOARD ',
      body: JSON.stringify({
        motion_id: 'M-27',
        file_path: 'docs/board/motions/M-27.md',
        requested_action: 'open discussion',
      }),
    };
    const first = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);

    principal = { principal_id: 'john-ranson', seat_id: 'john', roles: [] };
    const retry = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify(body),
    });

    expect(retry.status).toBe(403);
    expect(((await retry.json()) as { error: string }).error).toBe(
      'board_petition_principal_required'
    );
    expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(1);
  });

  test('records board petition evidence without approval side effects', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        recipient: 'board',
        body: JSON.stringify({
          motion_id: 'M-27',
          file_path: 'docs/board/motions/M-27.md',
          requested_action: 'open discussion',
        }),
      }),
    });
    expect(response.status).toBe(200);
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM board_audit_events'
    );
    expect(events.rows.map(row => row.event_type)).toContain('board_petition_delivered');
  });

  test('uses dedicated worker credential for alias list and concrete-principal claim', async () => {
    const app = makeApp();
    await registerWorker({
      worker_id: 'worker-a',
      host: 'host',
      capabilities: { providers: ['claude'] },
      max_concurrency: 1,
    });
    const now = new Date();
    await db.query(
      `INSERT INTO board_xo_leases (
         id, lease_id, principal_id, seat_id, holder_id, holder_token_hash,
         fencing_token, acquired_at, renewed_at, expires_at, released_at
       )
       VALUES (1, 'lease-1', 'claude', 'xo', 'holder', $1, 3, $2, NULL, $3, NULL)`,
      ['c'.repeat(64), now.toISOString(), new Date(now.getTime() + 60_000).toISOString()]
    );
    const created = await app.request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
      body: JSON.stringify({
        ...VALID_BODY,
        task_type: 'board_motion',
        recipient: 'board',
        body: JSON.stringify({
          motion_id: 'M-27',
          title: 'Board Motion Dispatch',
          file_path: 'docs/board/motions/M-27.md',
        }),
      }),
    });
    const message = (await created.json()) as { id: string };

    const list = await app.request('/api/dispatch/messages?recipient=claude&status=queued', {
      headers: {
        'x-dispatch-worker-id': 'worker-a',
        'x-dispatch-worker-credential-id': 'board-worker-1',
        'x-dispatch-worker-token': 'worker-secret',
      },
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { id: string }[]).map(item => item.id)).toContain(message.id);

    const claim = await app.request(`/api/dispatch/messages/${message.id}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dispatch-worker-credential-id': 'board-worker-1',
        'x-dispatch-worker-token': 'worker-secret',
      },
      body: JSON.stringify({ worker_id: 'worker-a', delivery_principal: 'claude' }),
    });
    expect(claim.status).toBe(200);
    expect(((await claim.json()) as { resolved_recipient: string }).resolved_recipient).toBe(
      'claude'
    );
  });

  test('dispatch status expires stale workers and surfaces queued operator reports', async () => {
    const app = makeApp('secret-token');
    await registerWorker({
      worker_id: 'worker-stale',
      host: 'host',
      capabilities: { providers: ['claude', 'codex'] },
      max_concurrency: 2,
    });
    await db.query(
      `UPDATE agent_dispatch_workers
       SET last_heartbeat_at = $2
       WHERE worker_id = $1`,
      ['worker-stale', new Date(Date.now() - 10 * 60_000).toISOString()]
    );
    await createMessage({
      correlation_id: 'report-correlation',
      idempotency_key: 'report-idempotency',
      task_type: 'run_report',
      sender: 'claude',
      recipient: 'xo',
      body: 'Overnight report is ready for John.',
    });

    const response = await app.request('/api/dispatch/status?worker_stale_after_ms=1000', {
      headers: { 'x-archon-operator-token': 'secret-token' },
    });

    expect(response.status).toBe(200);
    const status = (await response.json()) as {
      queue: Record<string, number>;
      worker_lifecycle: Record<string, number>;
      mailbox: Record<string, unknown>;
      workers: { worker_id: string; status: string }[];
      operator_reports: { recipient: string; body_preview: string }[];
    };
    expect(status.queue.queued).toBe(1);
    expect(status.worker_lifecycle).toEqual(status.queue);
    expect(status.mailbox.xo).toEqual(
      expect.objectContaining({
        unread: 1,
        legacy_unverified: expect.any(Number),
        acked_open: expect.any(Number),
        addressed_by_mind: expect.any(Number),
        disposed_by_machine: expect.any(Number),
        surfaced_unacked: expect.any(Number),
        surfaced_acked: expect.any(Number),
      })
    );
    expect(status.workers[0]?.status).toBe('unavailable');
    expect(status.operator_reports).toEqual([
      expect.objectContaining({
        recipient: 'xo',
        body_preview: 'Overnight report is ready for John.',
      }),
    ]);
  });

  test('acknowledges a mailbox message without changing its queue status', async () => {
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'ack-success',
      recipient: 'operator',
      priority: 'blocker',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({ principal_id: ' Operator ' }),
      }
    );
    expect(response.status).toBe(200);
    expect(
      (await response.json()) as { status: string; priority: string; acknowledged_by: string }
    ).toMatchObject({
      status: 'queued',
      priority: 'blocker',
      acknowledged_by: 'operator',
    });
    const stored = await db.query<{ status: string; acknowledged_by: string | null }>(
      'SELECT status, acknowledged_by FROM agent_dispatch_messages WHERE id = $1',
      [message.id]
    );
    expect(stored.rows[0]).toEqual({ status: 'queued', acknowledged_by: 'operator' });
  });

  test('maps acknowledgement lifecycle outcomes without cancellation side effects', async () => {
    const wrongMode = await createMessage({ ...VALID_BODY, idempotency_key: 'ack-wrong-mode' });
    const wrongRecipient = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'ack-wrong-recipient',
      recipient: 'xo',
    });
    const notQueued = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'ack-not-queued',
      recipient: 'operator',
    });
    const actorMismatch = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'ack-actor-mismatch',
      recipient: 'operator',
    });
    await db.query("UPDATE agent_dispatch_messages SET status = 'cancelled' WHERE id = $1", [
      notQueued.id,
    ]);
    await db.query(
      'UPDATE agent_dispatch_messages SET acknowledged_by = $2, acknowledged_at = $3 WHERE id = $1',
      [actorMismatch.id, 'xo', new Date().toISOString()]
    );
    const app = makeApp('secret-token');
    const cases = [
      { id: 'missing', principal_id: 'operator', status: 404, error: 'not_found' },
      { id: wrongMode.id, principal_id: 'operator', status: 409, error: 'wrong_recipient' },
      { id: wrongRecipient.id, principal_id: 'operator', status: 409, error: 'wrong_recipient' },
      { id: notQueued.id, principal_id: 'operator', status: 409, error: 'not_queued' },
      { id: actorMismatch.id, principal_id: 'operator', status: 409, error: 'actor_mismatch' },
    ];
    for (const expected of cases) {
      const response = await app.request(`/api/dispatch/messages/${expected.id}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({ principal_id: expected.principal_id }),
      });
      expect(response.status).toBe(expected.status);
      expect(((await response.json()) as { error: string }).error).toBe(expected.error);
    }
    const preserved = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM agent_dispatch_messages WHERE id IN ($1, $2, $3, $4) ORDER BY id',
      [wrongMode.id, wrongRecipient.id, notQueued.id, actorMismatch.id]
    );
    expect(preserved.rows.map(row => row.status).sort()).toEqual([
      'cancelled',
      'queued',
      'queued',
      'queued',
    ]);
  });

  test('addresses an acknowledged mailbox message without changing its queue status', async () => {
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'address-success',
      recipient: 'operator',
    });
    const app = makeApp('secret-token');
    const ack = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ principal_id: 'operator' }),
    });
    expect(ack.status).toBe(200);
    const response = await app.request(`/api/dispatch/messages/${message.id}/address`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
      body: JSON.stringify({ principal_id: 'operator' }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string; addressed_by: string }).toMatchObject({
      status: 'queued',
      addressed_by: 'operator',
    });
  });

  test('rejects disposition_terminal but permits acknowledgement after auto_surfaced', async () => {
    const expired = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'expired-ack',
      recipient: 'operator',
    });
    const surfaced = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'surfaced-ack',
      recipient: 'operator',
    });
    const stamp = new Date().toISOString();
    await db.query(
      "UPDATE agent_dispatch_messages SET route_disposition = 'expired', route_disposed_at = $2 WHERE id = $1",
      [expired.id, stamp]
    );
    await db.query(
      "UPDATE agent_dispatch_messages SET route_disposition = 'auto_surfaced', route_disposed_at = $2 WHERE id = $1",
      [surfaced.id, stamp]
    );
    const app = makeApp('secret-token');
    const requestAck = (id: string) =>
      app.request(`/api/dispatch/messages/${id}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: '{}',
      });
    const refused = await requestAck(expired.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('disposition_terminal');
    const accepted = await requestAck(surfaced.id);
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { route_disposition: string }).route_disposition).toBe(
      'auto_surfaced'
    );
  });

  test('maps address lifecycle outcomes without cancellation side effects', async () => {
    const wrongMode = await createMessage({ ...VALID_BODY, idempotency_key: 'address-wrong-mode' });
    const wrongRecipient = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'address-wrong-recipient',
      recipient: 'xo',
    });
    const notQueued = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'address-not-queued',
      recipient: 'operator',
    });
    const beforeAck = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'address-before-ack',
      recipient: 'operator',
    });
    const actorMismatch = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'address-actor-mismatch',
      recipient: 'operator',
    });
    await db.query("UPDATE agent_dispatch_messages SET status = 'cancelled' WHERE id = $1", [
      notQueued.id,
    ]);
    await db.query(
      'UPDATE agent_dispatch_messages SET acknowledged_by = $2, acknowledged_at = $3 WHERE id = $1',
      [actorMismatch.id, 'xo', new Date().toISOString()]
    );
    const app = makeApp('secret-token');
    const cases = [
      { id: 'missing', principal_id: 'operator', status: 404, error: 'not_found' },
      { id: wrongMode.id, principal_id: 'operator', status: 409, error: 'wrong_recipient' },
      { id: wrongRecipient.id, principal_id: 'operator', status: 409, error: 'wrong_recipient' },
      { id: notQueued.id, principal_id: 'operator', status: 409, error: 'not_queued' },
      { id: beforeAck.id, principal_id: 'operator', status: 409, error: 'address_before_ack' },
      { id: actorMismatch.id, principal_id: 'operator', status: 409, error: 'actor_mismatch' },
    ];
    for (const expected of cases) {
      const response = await app.request(`/api/dispatch/messages/${expected.id}/address`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({ principal_id: expected.principal_id }),
      });
      expect(response.status).toBe(expected.status);
      expect(((await response.json()) as { error: string }).error).toBe(expected.error);
    }
    const preserved = await db.query<{ status: string }>(
      'SELECT status FROM agent_dispatch_messages WHERE id IN ($1, $2, $3, $4, $5)',
      [wrongMode.id, wrongRecipient.id, notQueued.id, beforeAck.id, actorMismatch.id]
    );
    expect(preserved.rows.map(row => row.status).sort()).toEqual([
      'cancelled',
      'queued',
      'queued',
      'queued',
      'queued',
    ]);
  });

  test('requires operator authentication before a mailbox lifecycle action', async () => {
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'ack-auth',
      recipient: 'operator',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ principal_id: 'operator' }),
      }
    );
    expect(response.status).toBe(401);
    const stored = await db.query<{ acknowledged_by: string | null }>(
      'SELECT acknowledged_by FROM agent_dispatch_messages WHERE id = $1',
      [message.id]
    );
    expect(stored.rows[0]?.acknowledged_by).toBeNull();
  });

  test('binds XO receipts to all four live lease proofs and rejects stale fences', async () => {
    principal = { principal_id: 'xo', seat_id: 'xo', roles: [] };
    const holderToken = 'xo-holder-secret';
    const leaseId = 'xo-lease-current';
    const fencingToken = 17;
    await db.query(
      `INSERT INTO board_xo_leases
       (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
        acquired_at, renewed_at, expires_at, released_at)
       VALUES (1, $1, 'xo', 'xo', 'holder', $2, $3, $4, NULL, $5, NULL)`,
      [
        leaseId,
        sha(holderToken),
        fencingToken,
        new Date().toISOString(),
        new Date(Date.now() + 60_000).toISOString(),
      ]
    );
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-bound-ack',
      recipient: 'xo',
    });
    const app = makeApp('secret-token');
    const baseHeaders = {
      'Content-Type': 'application/json',
      'x-archon-operator-token': 'secret-token',
      'x-board-principal-token': 'board-proof',
      'x-xo-holder-token': holderToken,
      'x-xo-lease-id': leaseId,
      'x-xo-fencing-token': String(fencingToken),
    };
    const missingProof = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: { ...baseHeaders, 'x-xo-lease-id': '' },
      body: '{}',
    });
    expect(missingProof.status).toBe(401);
    expect(((await missingProof.json()) as { error: string }).error).toBe('dispatch_actor_unbound');

    const staleHolder = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: { ...baseHeaders, 'x-xo-holder-token': 'turned-over-holder' },
      body: '{}',
    });
    expect(staleHolder.status).toBe(409);
    expect(((await staleHolder.json()) as { error: string }).error).toBe('lease_fence_stale');

    const acknowledged = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: baseHeaders,
      body: '{}',
    });
    expect(acknowledged.status).toBe(200);
    expect(((await acknowledged.json()) as { acknowledged_by: string }).acknowledged_by).toBe('xo');
  });

  test('rejects expired and released XO leases before mailbox mutation', async () => {
    principal = { principal_id: 'xo', seat_id: 'xo', roles: [] };
    const holderToken = 'xo-expiry-holder';
    const leaseId = 'xo-expiry-lease';
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-expiry',
      recipient: 'xo',
    });
    const headers = {
      'Content-Type': 'application/json',
      'x-board-principal-token': 'board-proof',
      'x-xo-holder-token': holderToken,
      'x-xo-lease-id': leaseId,
      'x-xo-fencing-token': '21',
    };
    const insertLease = async (expiresAt: string, releasedAt: string | null) => {
      await db.query('DELETE FROM board_xo_leases');
      await db.query(
        `INSERT INTO board_xo_leases
         (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
          acquired_at, renewed_at, expires_at, released_at)
         VALUES (1, $1, 'xo', 'xo', 'holder', $2, 21, $3, NULL, $4, $5)`,
        [leaseId, sha(holderToken), new Date().toISOString(), expiresAt, releasedAt]
      );
    };
    await insertLease(new Date(Date.now() - 1_000).toISOString(), null);
    expect(
      (
        await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status
    ).toBe(401);
    await insertLease(new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    expect(
      (
        await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status
    ).toBe(401);
    expect(
      (
        await db.query<{ acknowledged_at: string | null }>(
          'SELECT acknowledged_at FROM agent_dispatch_messages WHERE id = $1',
          [message.id]
        )
      ).rows[0]?.acknowledged_at
    ).toBeNull();
  });

  test('rejects an unregistered fable identity and leaves its mailbox row untouched', async () => {
    await db.query(
      "INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active) VALUES ('fable', 'Fable', 'drain_on_start', 1)"
    );
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'fable-unbound',
      recipient: 'fable',
    });
    const response = await makeApp().request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dispatch-principal-id': 'fable',
        'x-dispatch-principal-token': 'no-registry-entry',
      },
      body: JSON.stringify({ principal_id: 'fable' }),
    });
    expect(response.status).toBe(401);
    expect(
      (
        await db.query<{ acknowledged_at: string | null }>(
          'SELECT acknowledged_at FROM agent_dispatch_messages WHERE id = $1',
          [message.id]
        )
      ).rows[0]?.acknowledged_at
    ).toBeNull();
  });

  test('transactional lease re-read rejects a fencing-token turnover after actor resolution', async () => {
    principal = { principal_id: 'xo', seat_id: 'xo', roles: [] };
    const holderToken = 'xo-race-holder';
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-race',
      recipient: 'xo',
    });
    await db.query(
      `INSERT INTO board_xo_leases
       (id, lease_id, principal_id, seat_id, holder_id, holder_token_hash, fencing_token,
        acquired_at, renewed_at, expires_at, released_at)
       VALUES (1, 'lease-old', 'xo', 'xo', 'holder', $1, 30, $2, NULL, $3, NULL)`,
      [sha(holderToken), new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()]
    );
    const app = makeApp(undefined, async () => {
      await db.query(
        `UPDATE board_xo_leases SET lease_id = 'lease-new', fencing_token = 31,
         acquired_at = $1, expires_at = $2, released_at = NULL WHERE id = 1`,
        [new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()]
      );
    });
    const response = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-board-principal-token': 'board-proof',
        'x-xo-holder-token': holderToken,
        'x-xo-lease-id': 'lease-old',
        'x-xo-fencing-token': '30',
      },
      body: '{}',
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('lease_fence_stale');
    expect(
      (
        await db.query<{ acknowledged_at: string | null }>(
          'SELECT acknowledged_at FROM agent_dispatch_messages WHERE id = $1',
          [message.id]
        )
      ).rows[0]?.acknowledged_at
    ).toBeNull();
  });

  test('xo seat ack: claude holder acks an xo row', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-claude',
      recipient: 'xo',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(proof), body: '{}' }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      acknowledged_by: string;
      acknowledged_at: string | null;
      status: string;
    };
    expect(body.acknowledged_by).toBe('xo');
    expect(body.acknowledged_at).not.toBeNull();
    expect(body.status).toBe('queued');
    const stored = await storedReceipt(message.id);
    expect(stored.acknowledged_by).toBe('xo');
    expect(stored.acknowledged_at).not.toBeNull();
    expect(stored.status).toBe('queued');
  });

  test('xo seat ack: codex holder acks an xo row', async () => {
    const holder = 'xo-codex-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-codex',
      recipient: 'xo',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(proof), body: '{}' }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      acknowledged_by: string;
      acknowledged_at: string | null;
    };
    expect(body.acknowledged_by).toBe('xo');
    expect(body.acknowledged_at).not.toBeNull();
    const stored = await storedReceipt(message.id);
    expect(stored.acknowledged_by).toBe('xo');
    expect(stored.acknowledged_at).not.toBeNull();
  });

  test('xo seat ack: a non-holder xo-seat principal is rejected', async () => {
    principal = { principal_id: 'xo-codex-board-work', seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease('xo-claude-board-work');
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-non-holder',
      recipient: 'xo',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(proof), body: '{}' }
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('dispatch_actor_unbound');
    expect((await storedReceipt(message.id)).acknowledged_at).toBeNull();
  });

  test('xo seat ack: a principal whose seat is not xo is rejected even when its id equals the holder', async () => {
    principal = { principal_id: 'xo-claude-board-work', seat_id: 'general', roles: [] };
    const proof = await seedXoHolderLease('xo-claude-board-work');
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-wrong-seat',
      recipient: 'xo',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(proof), body: '{}' }
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('dispatch_actor_unbound');
    expect((await storedReceipt(message.id)).acknowledged_at).toBeNull();
  });

  test('xo seat ack: expired and released leases held by a real holder are rejected', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-expired',
      recipient: 'xo',
    });
    const expired = await seedXoHolderLease(holder, {
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const expiredResponse = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(expired), body: '{}' }
    );
    expect(expiredResponse.status).toBe(401);
    const released = await seedXoHolderLease(holder, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      releasedAt: new Date().toISOString(),
    });
    const releasedResponse = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(released), body: '{}' }
    );
    expect(releasedResponse.status).toBe(401);
    expect((await storedReceipt(message.id)).acknowledged_at).toBeNull();
  });

  test('xo seat ack: a holder-bound ack on a non-xo row is wrong_recipient', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-wrong-recipient',
      recipient: 'operator',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      { method: 'POST', headers: xoSeatHeaders(proof), body: '{}' }
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('wrong_recipient');
    expect((await storedReceipt(message.id)).acknowledged_at).toBeNull();
  });

  test('xo seat ack: acking twice is idempotent', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-twice',
      recipient: 'xo',
    });
    const app = makeApp('secret-token');
    const first = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: xoSeatHeaders(proof),
      body: '{}',
    });
    expect(first.status).toBe(200);
    const firstStored = await storedReceipt(message.id);
    const second = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers: xoSeatHeaders(proof),
      body: '{}',
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { acknowledged_by: string };
    expect(secondBody.acknowledged_by).toBe('xo');
    const secondStored = await storedReceipt(message.id);
    expect(secondStored.acknowledged_at).toBe(firstStored.acknowledged_at);
    expect(secondStored.acknowledged_by).toBe('xo');
    expect(firstStored.acknowledged_by).toBe('xo');
  });

  test('xo seat ack: address lifecycle queued to acked_open to addressed', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-lifecycle',
      recipient: 'xo',
    });
    const app = makeApp('secret-token');
    const headers = xoSeatHeaders(proof);
    const earlyAddress = await app.request(`/api/dispatch/messages/${message.id}/address`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(earlyAddress.status).toBe(409);
    expect(((await earlyAddress.json()) as { error: string }).error).toBe('address_before_ack');
    expect((await storedReceipt(message.id)).status).toBe('queued');

    const ack = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(ack.status).toBe(200);
    expect((await storedReceipt(message.id)).status).toBe('queued');

    const address = await app.request(`/api/dispatch/messages/${message.id}/address`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(address.status).toBe(200);
    const addressed = (await address.json()) as {
      addressed_by: string;
      addressed_at: string | null;
      status: string;
    };
    expect(addressed.addressed_by).toBe('xo');
    expect(addressed.addressed_at).not.toBeNull();
    expect(addressed.status).toBe('queued');
    const afterAddress = await storedReceipt(message.id);

    const repeat = await app.request(`/api/dispatch/messages/${message.id}/address`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(repeat.status).toBe(200);
    const repeated = await storedReceipt(message.id);
    expect(repeated.addressed_at).toBe(afterAddress.addressed_at);
    expect(repeated.addressed_by).toBe('xo');
    expect(repeated.status).toBe('queued');
  });

  test('xo seat ack: the body may name the holder but no other principal', async () => {
    const holder = 'xo-claude-board-work';
    principal = { principal_id: holder, seat_id: 'xo', roles: [] };
    const proof = await seedXoHolderLease(holder);
    const accepted = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-body-holder',
      recipient: 'xo',
    });
    const rejected = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-body-other',
      recipient: 'xo',
    });
    const app = makeApp('secret-token');
    const headers = xoSeatHeaders(proof);
    const ok = await app.request(`/api/dispatch/messages/${accepted.id}/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ principal_id: holder }),
    });
    expect(ok.status).toBe(200);
    const mismatch = await app.request(`/api/dispatch/messages/${rejected.id}/ack`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ principal_id: 'someone-else' }),
    });
    expect(mismatch.status).toBe(409);
    expect(((await mismatch.json()) as { error: string }).error).toBe('actor_mismatch');
    expect((await storedReceipt(rejected.id)).acknowledged_at).toBeNull();
  });

  test('xo seat ack: a bare operator token naming the holder in the body stays actor_mismatch', async () => {
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-seat-ack-operator-body',
      recipient: 'xo',
    });
    const app = makeApp('secret-token');
    const headers = {
      'Content-Type': 'application/json',
      'x-archon-operator-token': 'secret-token',
    };
    for (const principalId of ['xo-claude-board-work', 'xo']) {
      const response = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ principal_id: principalId }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe('actor_mismatch');
    }
    expect((await storedReceipt(message.id)).acknowledged_at).toBeNull();
  });

  test('never falls back from an invalid identity request to the operator token', async () => {
    // Both credential-only XO and invalid-credential-plus-operator paths are dispatch_actor_unbound.
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'credential-xo',
        principal_id: 'xo',
        token_sha256: sha('xo-token'),
        status: 'active',
        send_as: ['xo'],
        receive_as: ['xo'],
        roles: ['receive'],
      },
    ]);
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'identity-no-fallback',
      recipient: 'operator',
    });
    const app = makeApp('secret-token');
    for (const token of ['xo-token', 'invalid-token']) {
      const response = await app.request(`/api/dispatch/messages/${message.id}/ack`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'xo',
          'x-dispatch-principal-token': token,
        },
        body: '{}',
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: string }).error).toBe('dispatch_actor_unbound');
    }
  });

  test('accepts only approved structured non-production execution handoffs', async () => {
    const digest = (token: string) => createHash('sha256').update(token).digest('hex');
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'xo-active',
        principal_id: 'xo-principal',
        token_sha256: digest('xo-secret'),
        status: 'active',
        send_as: ['xo'],
        receive_as: ['xo'],
        roles: ['send'],
      },
    ]);
    const app = makeApp('secret-token');
    const valid = {
      correlation_id: 'handoff-correlation',
      idempotency_key: 'handoff-idempotency',
      target: 'cauldron',
      work_order_id: 'WO-HARNESS-DISPATCH-RESTORE-01',
      environment: 'staging',
      target_repo: 'thinmansoftware/bdc-harness',
      target_ref: 'c8ee059de5a5aecf550e5298db8a24aba46809cd',
      approved: true,
      approved_by: 'john-ranson',
      approval_ref: 'M-48',
      objective: 'Run the approved staging-only verification workflow.',
      constraints: ['no production deploy', 'no customer sends'],
    };
    const principalHeaders = {
      'Content-Type': 'application/json',
      'x-archon-operator-token': 'secret-token',
      'x-dispatch-principal-id': 'xo-principal',
      'x-dispatch-principal-token': 'xo-secret',
    } as const;
    const accepted = await app.request('/api/dispatch/execution-handoffs', {
      method: 'POST',
      headers: { ...principalHeaders },
      body: JSON.stringify(valid),
    });
    expect(accepted.status).toBe(200);
    const message = (await accepted.json()) as {
      task_type: string;
      recipient: string;
      body: string;
      sender: string;
      sender_principal_id: string | null;
    };
    expect(message.task_type).toBe('run_report');
    expect(message.recipient).toBe('cauldron');
    expect(message.sender).toBe('xo');
    expect(message.sender_principal_id).toBe('xo-principal');
    expect(JSON.parse(message.body)).toEqual(
      expect.objectContaining({
        kind: 'approved_execution_handoff',
        approved: true,
        environment: 'staging',
      })
    );

    const overseer = await app.request('/api/dispatch/execution-handoffs', {
      method: 'POST',
      headers: { ...principalHeaders },
      body: JSON.stringify({
        ...valid,
        correlation_id: 'handoff-overseer-correlation',
        idempotency_key: 'handoff-overseer-idempotency',
        target: 'overseer',
      }),
    });
    expect(overseer.status).toBe(200);

    const status = await app.request('/api/dispatch/status', {
      headers: { 'x-archon-operator-token': 'secret-token' },
    });
    expect(status.status).toBe(200);
    expect(
      (
        (await status.json()) as { execution_handoffs: { recipient: string }[] }
      ).execution_handoffs.map(handoff => handoff.recipient)
    ).toEqual(expect.arrayContaining(['cauldron', 'overseer']));

    const rejected = await app.request('/api/dispatch/execution-handoffs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-archon-operator-token': 'secret-token',
      },
      body: JSON.stringify({ ...valid, environment: 'production' }),
    });
    expect(rejected.status).toBe(400);
  });

  test('rejects repo mutation hidden in a free-form run_report', async () => {
    const response = await makeApp().request('/api/dispatch/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...VALID_BODY,
        task_type: 'run_report',
        body: 'Commit the patch and push the branch.',
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'repo_mutating_dispatch_body_rejected'
    );
  });

  describe('Phase 1.5 sender authentication HTTP modes', () => {
    const digest = (token: string) => createHash('sha256').update(token).digest('hex');
    const principalsJson = () =>
      JSON.stringify([
        {
          credential_id: 'claude-active',
          principal_id: 'claude-principal',
          token_sha256: digest('claude-secret'),
          status: 'active',
          send_as: ['claude'],
          receive_as: ['claude'],
          roles: ['send', 'receive'],
        },
        {
          credential_id: 'xo-active',
          principal_id: 'xo-principal',
          token_sha256: digest('xo-secret'),
          status: 'active',
          send_as: ['xo'],
          receive_as: ['xo'],
          roles: ['send'],
        },
        {
          credential_id: 'disabled',
          principal_id: 'disabled-principal',
          token_sha256: digest('disabled-secret'),
          status: 'disabled',
          send_as: ['claude'],
          receive_as: [],
          roles: ['send'],
        },
      ]);

    function applySenderAuthMode(mode: string): void {
      process.env.DISPATCH_SENDER_AUTH_MODE = mode;
    }

    beforeEach(() => {
      process.env.DISPATCH_PRINCIPALS_JSON = principalsJson();
      delete process.env.DISPATCH_SENDER_AUTH_MODE;
    });

    afterEach(() => {
      delete process.env.DISPATCH_PRINCIPALS_JSON;
      delete process.env.DISPATCH_SENDER_AUTH_MODE;
    });

    test('off admits legacy silence; warn admits with null principal; enforce rejects missing', async () => {
      applySenderAuthMode('off');
      let response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({
          ...VALID_BODY,
          sender: 'Legacy.Agent',
          idempotency_key: 'legacy-off',
        }),
      });
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { sender_principal_id: string | null }).sender_principal_id
      ).toBeNull();

      applySenderAuthMode('warn');
      response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({
          ...VALID_BODY,
          sender: 'Legacy.Agent',
          idempotency_key: 'legacy-warn',
        }),
      });
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { sender_principal_id: string | null }).sender_principal_id
      ).toBeNull();

      applySenderAuthMode('enforce');
      response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({ ...VALID_BODY, idempotency_key: 'legacy-enforce' }),
      });
      expect(response.status).toBe(401);
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'legacy-enforce',
          ])
        ).rowCount
      ).toBe(0);
    });

    test('execution handoff rejects an invalid sender auth mode without mutation', async () => {
      applySenderAuthMode('invalid-mode');
      const response = await makeApp('secret-token').request('/api/dispatch/execution-handoffs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'xo-principal',
          'x-dispatch-principal-token': 'xo-secret',
        },
        body: JSON.stringify({
          correlation_id: 'invalid-mode-handoff-correlation',
          idempotency_key: 'invalid-mode-handoff',
          target: 'overseer',
          work_order_id: 'WO-TEST-INVALID-MODE',
          environment: 'local',
          target_repo: 'thinmansoftware/bdc-harness',
          target_ref: 'a'.repeat(40),
          approved: true,
          approved_by: 'xo',
          approval_ref: 'test-invalid-mode',
          objective: 'prove invalid sender auth mode fails closed',
          constraints: [],
        }),
      });
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: string }).error).toBe(
        'dispatch_sender_auth_mode_invalid'
      );
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'invalid-mode-handoff',
          ])
        ).rowCount
      ).toBe(0);
    });

    test('partial and invalid credentials fail closed in every mode without mutation', async () => {
      for (const mode of ['off', 'warn', 'enforce'] as const) {
        applySenderAuthMode(mode);
        const before = (await db.query('SELECT id FROM agent_dispatch_messages')).rowCount;
        let response = await makeApp('secret-token').request('/api/dispatch/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-archon-operator-token': 'secret-token',
            'x-dispatch-principal-id': 'claude-principal',
          },
          body: JSON.stringify({ ...VALID_BODY, idempotency_key: `partial-${mode}` }),
        });
        expect(response.status).toBe(401);

        response = await makeApp('secret-token').request('/api/dispatch/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-archon-operator-token': 'secret-token',
            'x-dispatch-principal-id': 'claude-principal',
            'x-dispatch-principal-token': 'wrong',
          },
          body: JSON.stringify({ ...VALID_BODY, idempotency_key: `invalid-${mode}` }),
        });
        expect(response.status).toBe(401);

        response = await makeApp('secret-token').request('/api/dispatch/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-archon-operator-token': 'secret-token',
            'x-dispatch-principal-id': 'disabled-principal',
            'x-dispatch-principal-token': 'disabled-secret',
          },
          body: JSON.stringify({ ...VALID_BODY, idempotency_key: `disabled-${mode}` }),
        });
        expect(response.status).toBe(401);
        expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(before);
      }
    });

    test('valid principal binds sender and rejects forged selector', async () => {
      applySenderAuthMode('enforce');
      let response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'claude-principal',
          'x-dispatch-principal-token': 'claude-secret',
        },
        body: JSON.stringify({ ...VALID_BODY, idempotency_key: 'auth-ok', sender: 'claude' }),
      });
      expect(response.status).toBe(200);
      const message = (await response.json()) as {
        sender: string;
        sender_principal_id: string;
      };
      expect(message.sender).toBe('claude');
      expect(message.sender_principal_id).toBe('claude-principal');

      response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'claude-principal',
          'x-dispatch-principal-token': 'claude-secret',
        },
        body: JSON.stringify({ ...VALID_BODY, idempotency_key: 'auth-forge', sender: 'xo' }),
      });
      expect(response.status).toBe(403);
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'auth-forge',
          ])
        ).rowCount
      ).toBe(0);
    });

    test('board path namespaces principal and execution handoff requires xo send_as', async () => {
      applySenderAuthMode('enforce');
      let response = await makeApp().request('/api/dispatch/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-board-principal-token': 'board-token' },
        body: JSON.stringify({
          ...VALID_BODY,
          task_type: 'board_motion',
          sender: 'spoof',
          recipient: 'board',
          body: JSON.stringify({
            motion_id: 'M-27',
            title: 'Board Motion Dispatch',
            file_path: 'docs/board/motions/M-27.md',
          }),
        }),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { sender_principal_id: string }).sender_principal_id).toBe(
        'board:claude'
      );

      response = await makeApp('secret-token').request('/api/dispatch/execution-handoffs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'xo-principal',
          'x-dispatch-principal-token': 'xo-secret',
        },
        body: JSON.stringify({
          correlation_id: 'corr-handoff',
          idempotency_key: 'handoff-1',
          target: 'overseer',
          work_order_id: 'WO-TEST-1',
          environment: 'local',
          target_repo: 'thinmansoftware/bdc-harness',
          target_ref: 'a'.repeat(40),
          approved: true,
          approved_by: 'xo',
          approval_ref: 'ref-1',
          objective: 'ship phase15',
          constraints: [],
        }),
      });
      expect(response.status).toBe(200);
      const handoff = (await response.json()) as { sender: string; sender_principal_id: string };
      expect(handoff.sender).toBe('xo');
      expect(handoff.sender_principal_id).toBe('xo-principal');
    });

    test('malformed registry fails closed and never becomes legacy traffic', async () => {
      applySenderAuthMode('warn');
      process.env.DISPATCH_PRINCIPALS_JSON = '{';
      let response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
          'x-dispatch-principal-id': 'claude-principal',
          'x-dispatch-principal-token': 'claude-secret',
        },
        body: JSON.stringify({ ...VALID_BODY, idempotency_key: 'bad-registry' }),
      });
      expect(response.status).toBe(500);
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'bad-registry',
          ])
        ).rowCount
      ).toBe(0);

      // Headerless off/warn must also parse the registry; never silently downgrade.
      for (const mode of ['off', 'warn'] as const) {
        applySenderAuthMode(mode);
        process.env.DISPATCH_PRINCIPALS_JSON = '{';
        response = await makeApp('secret-token').request('/api/dispatch/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-archon-operator-token': 'secret-token',
          },
          body: JSON.stringify({
            ...VALID_BODY,
            idempotency_key: `bad-registry-headerless-${mode}`,
          }),
        });
        expect(response.status).toBe(500);
        expect(
          (
            await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
              `bad-registry-headerless-${mode}`,
            ])
          ).rowCount
        ).toBe(0);
      }

      applySenderAuthMode('off');
      delete process.env.DISPATCH_PRINCIPALS_JSON;
      response = await makeApp('secret-token').request('/api/dispatch/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
        },
        body: JSON.stringify({ ...VALID_BODY, idempotency_key: 'missing-registry-headerless' }),
      });
      expect(response.status).toBe(500);
      expect(
        (
          await db.query('SELECT id FROM agent_dispatch_messages WHERE idempotency_key = $1', [
            'missing-registry-headerless',
          ])
        ).rowCount
      ).toBe(0);
    });
  });

  test('lists every dispatch principal with its ack path and no token material', async () => {
    await db.query('DELETE FROM dispatch_principals');
    await db.query(
      `INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
       VALUES
         ('codex', 'Codex', 'worker_poll', 1),
         ('john', 'John', 'notify_only', 0),
         ('operator', 'Operator', 'drain_on_start', 1),
         ('xo', 'XO', 'drain_on_start', 1),
         ('xo-fable', 'XO Fable', 'drain_on_start', 1)`
    );
    const secret = 'tok-TESTSECRET-3';
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'codex-mcp-receive',
        principal_id: 'codex-mcp',
        token_sha256: sha(secret),
        status: 'active',
        send_as: ['codex-mcp'],
        receive_as: [],
        roles: ['receive'],
      },
    ]);
    const response = await makeApp('secret-token').request('/api/dispatch/principals', {
      headers: { 'x-archon-operator-token': 'secret-token' },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    const body = JSON.parse(text) as {
      principals: Array<{
        principal_id: string;
        display_name: string;
        delivery_mode: string;
        active: boolean;
        credential_configured: boolean;
        ack_path: string;
      }>;
    };
    expect(body.principals.map(entry => entry.principal_id)).toEqual([
      'codex',
      'john',
      'operator',
      'xo',
      'xo-fable',
    ]);
    expect(body.principals.map(entry => entry.ack_path)).toEqual([
      'worker_claim',
      'none',
      'operator_token',
      'xo_lease',
      'none',
    ]);
    expect(body.principals.map(entry => entry.credential_configured)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(body.principals.map(entry => entry.active)).toEqual([true, false, true, true, true]);
    for (const entry of body.principals) {
      expect(Object.keys(entry).sort()).toEqual([
        'ack_path',
        'active',
        'credential_configured',
        'delivery_mode',
        'display_name',
        'principal_id',
      ]);
    }
    expect(text).not.toContain(secret);
    expect(text).not.toContain(sha(secret));
    expect(text).not.toContain('token_sha256');
  });

  test('credential_configured is true via principal_id or receive_as and selects principal_credential', async () => {
    await db.query('DELETE FROM dispatch_principals');
    await db.query(
      `INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
       VALUES
         ('codex', 'Codex', 'worker_poll', 1),
         ('john', 'John', 'notify_only', 1),
         ('operator', 'Operator', 'drain_on_start', 1),
         ('xo', 'XO', 'drain_on_start', 1),
         ('xo-fable', 'XO Fable', 'drain_on_start', 1)`
    );
    const principalSecret = 'tok-TESTSECRET-4';
    const receiveSecret = 'tok-TESTSECRET-5';
    process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
      {
        credential_id: 'xo-fable-receive',
        principal_id: 'xo-fable',
        token_sha256: sha(principalSecret),
        status: 'active',
        send_as: ['xo-fable'],
        receive_as: [],
        roles: ['receive'],
      },
      {
        credential_id: 'desk-alias-receive',
        principal_id: 'desk-alias',
        token_sha256: sha(receiveSecret),
        status: 'active',
        send_as: ['desk-alias'],
        receive_as: ['john'],
        roles: ['receive'],
      },
    ]);
    const response = await makeApp('secret-token').request('/api/dispatch/principals', {
      headers: { 'x-archon-operator-token': 'secret-token' },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    const body = JSON.parse(text) as {
      principals: Array<{
        principal_id: string;
        display_name: string;
        delivery_mode: string;
        active: boolean;
        credential_configured: boolean;
        ack_path: string;
      }>;
    };
    expect(body.principals.map(entry => entry.principal_id)).toEqual([
      'codex',
      'john',
      'operator',
      'xo',
      'xo-fable',
    ]);
    const byId = new Map(body.principals.map(entry => [entry.principal_id, entry]));
    expect(byId.get('xo-fable')).toMatchObject({
      credential_configured: true,
      ack_path: 'principal_credential',
      delivery_mode: 'drain_on_start',
    });
    expect(byId.get('john')).toMatchObject({
      credential_configured: true,
      ack_path: 'principal_credential',
      delivery_mode: 'notify_only',
    });
    expect(byId.get('codex')).toMatchObject({
      credential_configured: false,
      ack_path: 'worker_claim',
    });
    expect(byId.get('operator')).toMatchObject({
      credential_configured: false,
      ack_path: 'operator_token',
    });
    expect(byId.get('xo')).toMatchObject({
      credential_configured: false,
      ack_path: 'xo_lease',
    });
    expect(text).not.toContain('desk-alias');
    expect(text).not.toContain(principalSecret);
    expect(text).not.toContain(receiveSecret);
    expect(text).not.toContain(sha(principalSecret));
    expect(text).not.toContain(sha(receiveSecret));
    expect(text).not.toContain('token_sha256');
    expect(text).not.toContain('credential_id');
  });

  test('principals listing requires the operator token', async () => {
    const response = await makeApp('secret-token').request('/api/dispatch/principals');
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('principals');
  });

  test('principals listing fails closed when the registry is malformed', async () => {
    process.env.DISPATCH_PRINCIPALS_JSON = '{not json';
    const response = await makeApp('secret-token').request('/api/dispatch/principals', {
      headers: { 'x-archon-operator-token': 'secret-token' },
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe('dispatch_principal_config_invalid');
    expect(body).not.toHaveProperty('principals');
  });

  test('operator token cannot acknowledge an xo mailbox row', async () => {
    const message = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'xo-operator-cannot-ack',
      recipient: 'xo',
    });
    const response = await makeApp('secret-token').request(
      `/api/dispatch/messages/${message.id}/ack`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
        },
        body: JSON.stringify({ principal_id: 'xo' }),
      }
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('actor_mismatch');
    const stored = await storedReceipt(message.id);
    expect(stored.acknowledged_at).toBeNull();
    expect(stored.acknowledged_by).toBeNull();
  });

  test('test119 reads an own message behind an acknowledged 500-row backlog', async () => {
    for (let index = 0; index < 501; index += 1) {
      await insertSyntheticDispatch({
        id: `old-${index}`,
        recipient: 'grokbot',
        correlationId: `old-corr-${index}`,
        seq: index + 1,
        body: `OLD-BODY-${index}`,
        acknowledged: true,
      });
    }
    await insertSyntheticDispatch({
      id: 'newer-own',
      recipient: 'grokbot',
      correlationId: 'newer-corr',
      seq: 600,
      body: 'NEWER-OWN-BODY',
      acknowledged: false,
    });
    await insertSyntheticDispatch({
      id: 'foreign-own-id',
      recipient: 'xo',
      correlationId: 'foreign-corr',
      seq: 601,
      body: 'FOREIGN-SECRET-BODY',
      acknowledged: false,
    });

    const app = makeApp();
    const legacy = await app.request('/api/dispatch/messages?recipient=grokbot&limit=500');
    expect(legacy.status).toBe(200);
    const legacyRows = (await legacy.json()) as Array<{ id: string }>;
    expect(Array.isArray(legacyRows)).toBe(true);
    expect(legacyRows).toHaveLength(500);
    expect(legacyRows.map(row => row.id)).not.toContain('newer-own');

    const own = await app.request(
      '/api/dispatch/messages?recipient=%20GrokBot%20&message_id=newer-own'
    );
    expect(own.status).toBe(200);
    const ownRows = (await own.json()) as Array<{ id: string; body: string; recipient: string }>;
    expect(ownRows.map(row => row.id)).toEqual(['newer-own']);
    expect(ownRows[0]?.recipient).toBe('grokbot');
    expect(ownRows[0]?.body).toBe('NEWER-OWN-BODY');
    expect(ownRows[0]).not.toHaveProperty('cursor_seq');

    const foreign = await app.request(
      '/api/dispatch/messages?recipient=grokbot&message_id=foreign-own-id'
    );
    const unknown = await app.request(
      '/api/dispatch/messages?recipient=grokbot&message_id=missing-message'
    );
    expect(foreign.status).toBe(200);
    expect(unknown.status).toBe(200);
    const foreignBody = await foreign.json();
    const unknownBody = await unknown.json();
    expect(foreignBody).toEqual([]);
    expect(unknownBody).toEqual(foreignBody);
    expect(JSON.stringify(foreignBody)).not.toContain('FOREIGN-SECRET-BODY');

    process.env.ARCHON_OPERATOR_TOKEN = 'operator-secret-must-not-gate-reads';
    const blocked = await app.request(
      '/api/dispatch/messages?recipient=grokbot&message_id=newer-own'
    );
    expect(blocked.status).toBe(401);
    expect(JSON.stringify(await blocked.json())).not.toContain('NEWER-OWN-BODY');
    const gated = await app.request(
      '/api/dispatch/messages?recipient=grokbot&message_id=newer-own',
      { headers: { 'x-archon-operator-token': 'operator-secret-must-not-gate-reads' } }
    );
    expect(gated.status).toBe(200);
    expect((await gated.json()) as Array<{ id: string }>).toEqual([
      expect.objectContaining({ id: 'newer-own' }),
    ]);
    const stillHidden = await app.request(
      '/api/dispatch/messages?recipient=grokbot&message_id=foreign-own-id',
      { headers: { 'x-archon-operator-token': 'operator-secret-must-not-gate-reads' } }
    );
    expect(await stillHidden.json()).toEqual([]);
  });

  test('test120 pages an own inbox past interleaved foreign rows', async () => {
    for (let index = 0; index < 501; index += 1) {
      await insertSyntheticDispatch({
        id: `own-${index}`,
        recipient: 'grokbot',
        correlationId: `own-corr-${index}`,
        seq: index * 2 + 1,
        body: `OWN-BODY-${index}`,
        acknowledged: false,
      });
      await insertSyntheticDispatch({
        id: `other-${index}`,
        recipient: 'xo',
        correlationId: `other-corr-${index}`,
        seq: index * 2 + 2,
        body: `OTHER-SECRET-${index}`,
        acknowledged: false,
      });
    }
    const app = makeApp();
    const firstResponse = await app.request(
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&limit=500'
    );
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      messages: Array<{ id: string; recipient: string; cursor_seq?: number }>;
      next_after_seq: number;
      page_full: boolean;
    };
    expect(Array.isArray(first)).toBe(false);
    expect(first.page_full).toBe(true);
    expect(first.messages).toHaveLength(500);
    expect(first.messages.every(message => message.recipient === 'grokbot')).toBe(true);
    expect(first.messages.some(message => message.cursor_seq !== undefined)).toBe(false);
    expect(first.messages.map(message => message.id)).toEqual(
      Array.from({ length: 500 }, (_unused, index) => `own-${index}`)
    );
    const seen = new Set(first.messages.map(message => message.id));

    const secondResponse = await app.request(
      `/api/dispatch/messages?recipient=grokbot&after_seq=${first.next_after_seq}&limit=500`
    );
    const second = (await secondResponse.json()) as {
      messages: Array<{ id: string; recipient: string }>;
      next_after_seq: number;
      page_full: boolean;
    };
    expect(second.messages.map(message => message.id)).toEqual(['own-500']);
    expect(second.page_full).toBe(false);
    expect(seen.has('own-500')).toBe(false);
    expect(second.next_after_seq).toBeGreaterThan(first.next_after_seq);

    const emptyResponse = await app.request(
      `/api/dispatch/messages?recipient=grokbot&after_seq=${second.next_after_seq}&limit=500`
    );
    expect(await emptyResponse.json()).toEqual({
      messages: [],
      next_after_seq: second.next_after_seq,
      page_full: false,
    });
    const text = JSON.stringify({ first, second });
    expect(text).not.toContain('OTHER-SECRET');
  });

  test('test121 returns own correlation replies behind unrelated history', async () => {
    for (let index = 0; index < 501; index += 1) {
      await insertSyntheticDispatch({
        id: `unrelated-${index}`,
        recipient: 'grokbot',
        correlationId: `unrelated-${index}`,
        seq: index + 1,
        body: `UNRELATED-${index}`,
        acknowledged: true,
      });
    }
    await insertSyntheticDispatch({
      id: 'own-reply-1',
      recipient: 'grokbot',
      correlationId: 'board-brief-target',
      seq: 700,
      body: 'OWN-REPLY-1',
      acknowledged: false,
    });
    await insertSyntheticDispatch({
      id: 'own-reply-2',
      recipient: 'grokbot',
      correlationId: 'board-brief-target',
      seq: 701,
      body: 'OWN-REPLY-2',
      acknowledged: false,
    });
    await insertSyntheticDispatch({
      id: 'foreign-reply',
      recipient: 'xo',
      correlationId: 'board-brief-target',
      seq: 702,
      body: 'FOREIGN-REPLY-SECRET',
      acknowledged: false,
    });
    for (let index = 0; index < 501; index += 1) {
      await insertSyntheticDispatch({
        id: `capped-${index}`,
        recipient: 'grokbot',
        correlationId: 'capped-correlation',
        seq: 1000 + index,
        body: `CAPPED-${index}`,
        acknowledged: false,
      });
    }

    const app = makeApp();
    const own = await app.request(
      '/api/dispatch/messages?recipient=grokbot&correlation_id=board-brief-target&limit=500'
    );
    expect(own.status).toBe(200);
    const ownRows = (await own.json()) as Array<{ id: string; body: string }>;
    expect(ownRows.map(row => row.id).sort()).toEqual(['own-reply-1', 'own-reply-2']);
    expect(JSON.stringify(ownRows)).not.toContain('FOREIGN-REPLY-SECRET');
    expect(JSON.stringify(ownRows)).not.toContain('UNRELATED-0');

    const foreign = await app.request(
      '/api/dispatch/messages?recipient=xo&correlation_id=board-brief-target&limit=500'
    );
    const foreignRows = (await foreign.json()) as Array<{ id: string }>;
    expect(foreignRows.map(row => row.id)).toEqual(['foreign-reply']);

    const capped = await app.request(
      '/api/dispatch/messages?recipient=grokbot&correlation_id=capped-correlation&limit=500'
    );
    expect(capped.status).toBe(200);
    const cappedRows = (await capped.json()) as Array<{ id: string }>;
    expect(Array.isArray(cappedRows)).toBe(true);
    expect(cappedRows).toHaveLength(500);
    expect(cappedRows.map(row => row.id)).not.toContain('capped-0');
  });

  test('test122 keeps legacy list arrays and rejects bad selectors', async () => {
    const visible = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'legacy-visible',
      recipient: 'codex',
      body: 'LEGACY-VISIBLE',
    });
    await createMessage({
      ...VALID_BODY,
      idempotency_key: 'legacy-other',
      correlation_id: 'other-corr',
      recipient: 'operator',
      body: 'LEGACY-OTHER',
    });
    const deferred = await createMessage({
      ...VALID_BODY,
      idempotency_key: 'legacy-deferred',
      recipient: 'grokbot',
      body: 'DEFERRED-BODY',
      not_before: '2999-01-01T00:00:00.000Z',
    });
    const app = makeApp();

    const legacy = await app.request(
      '/api/dispatch/messages?recipient=codex&status=queued&limit=10'
    );
    expect(legacy.status).toBe(200);
    const legacyRows = (await legacy.json()) as Array<{ id: string }>;
    expect(legacyRows.map(row => row.id)).toEqual([visible.id]);

    const unknownKey = await app.request('/api/dispatch/messages?recipient=codex&not_a_selector=1');
    expect(unknownKey.status).toBe(200);
    expect(Array.isArray(await unknownKey.json())).toBe(true);

    const clamped = await app.request('/api/dispatch/messages?recipient=codex&limit=9999');
    expect(clamped.status).toBe(200);
    expect(Array.isArray(await clamped.json())).toBe(true);

    const queued = await app.request(
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&status=queued&limit=50'
    );
    expect(await queued.json()).toEqual({ messages: [], next_after_seq: 0, page_full: false });
    const anyStatus = await app.request(
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&limit=50'
    );
    const anyPage = (await anyStatus.json()) as { messages: Array<{ id: string }> };
    expect(anyPage.messages.map(message => message.id)).toContain(deferred.id);

    const invalidUrls = [
      '/api/dispatch/messages?recipient=grokbot&message_id=&after_seq=0',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&correlation_id=def',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&after_seq=0',
      '/api/dispatch/messages?message_id=abc',
      '/api/dispatch/messages?recipient=%20%20&message_id=abc',
      '/api/dispatch/messages?recipient=grokbot&recipient=xo&message_id=abc',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&message_id=def',
      '/api/dispatch/messages?recipient=grokbot&message_id=',
      '/api/dispatch/messages?recipient=grokbot&correlation_id=',
      '/api/dispatch/messages?recipient=grokbot&after_seq=',
      '/api/dispatch/messages?recipient=grokbot&after_seq=-1',
      '/api/dispatch/messages?recipient=grokbot&after_seq=1.5',
      '/api/dispatch/messages?recipient=grokbot&after_seq=00',
      '/api/dispatch/messages?recipient=grokbot&after_seq=1e2',
      '/api/dispatch/messages?recipient=grokbot&after_seq=%2B1',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&limit=1',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&status=queued',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&subject_key=wo:WO-MAILBOX',
      '/api/dispatch/messages?recipient=grokbot&message_id=abc&route_disposition=auto_surfaced',
      '/api/dispatch/messages?recipient=grokbot&correlation_id=abc&status=queued',
      '/api/dispatch/messages?recipient=grokbot&correlation_id=abc&subject_key=wo:WO-MAILBOX',
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&subject_key=wo:WO-MAILBOX',
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&route_disposition=auto_surfaced',
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&extra=1',
      '/api/dispatch/messages?recipient=grokbot&correlation_id=abc&limit=0',
      '/api/dispatch/messages?recipient=grokbot&correlation_id=abc&limit=501',
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&limit=1.2',
    ];
    for (const url of invalidUrls) {
      const response = await app.request(url);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(
        'dispatch_list_selector_invalid'
      );
    }

    const badStatus = await app.request(
      '/api/dispatch/messages?recipient=grokbot&after_seq=0&status=not-a-status'
    );
    expect(badStatus.status).toBe(400);
    const badStatusBody = (await badStatus.json()) as { error?: string; body?: string };
    expect(badStatusBody.body).toBeUndefined();
    expect(JSON.stringify(badStatusBody)).not.toContain('DEFERRED-BODY');

    const specResponse = await app.request('/api/openapi.json');
    const spec = (await specResponse.json()) as {
      paths: Record<string, { get?: { responses?: Record<string, unknown> } }>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    expect(spec.paths['/api/dispatch/messages']?.get?.responses?.['400']).toBeDefined();
    expect(spec.components.schemas.DispatchMessage?.properties?.cursor_seq).toBeUndefined();
    expect(spec.components.schemas.DispatchMessageCursorPage?.properties).toMatchObject({
      messages: expect.anything(),
      next_after_seq: expect.anything(),
      page_full: expect.anything(),
    });
  });

  test('test129 compares duplicated legacy list filters on the historical and current product routes', async () => {
    const evidence = await recordLegacyDuplicateProductRouteAb();
    expect(evidence.historical.revision).toBe(HISTORICAL_DISPATCH_REVISION);
    expect(evidence.current.revision).not.toBe(evidence.historical.revision);
    expect(evidence.current.results.map(row => row.id)).toEqual(LEGACY_DUPLICATE_AB_IDS);
    expect(evidence.current.results).toEqual(evidence.historical.results);

    for (const id of [
      'control_recipient',
      'control_status',
      'control_limit',
      'dup_unknown',
    ] as const) {
      expect(abRow(evidence.historical, id)).toEqual({
        id,
        status: 200,
        body: { kind: 'array', length: 1 },
      });
    }
    for (const id of ['control_subject_key', 'control_route_disposition'] as const) {
      expect(abRow(evidence.historical, id)).toEqual({
        id,
        status: 200,
        body: { kind: 'array', length: 0 },
      });
    }
    for (const [id, field] of [
      ['dup_recipient', 'recipient'],
      ['dup_status', 'status'],
      ['dup_limit', 'limit'],
      ['dup_subject_key', 'subject_key'],
      ['dup_route_disposition', 'route_disposition'],
    ] as const) {
      const row = abRow(evidence.historical, id);
      expect(row.status).toBe(400);
      expect(row.body.kind).toBe('error');
      if (row.body.kind !== 'error') continue;
      expect(row.body.status).toBe(400);
      expect(row.body.body.error.startsWith(`${field}:`)).toBe(true);
    }
    expect(existsSync(join(import.meta.dir, LEGACY_DUPLICATE_AB_PROBE_NAME))).toBe(false);
  });

  test('test124 config does not activate inactive companion principals', async () => {
    const seeded = await db.query<{
      principal_id: string;
      active: number;
      delivery_mode: string;
    }>(
      `SELECT principal_id, active, delivery_mode
       FROM dispatch_principals
       WHERE principal_id IN ('dot', 'duet', 'grokbot', 'muse')
       ORDER BY principal_id`
    );
    expect(seeded.rows).toEqual([
      { principal_id: 'dot', active: 0, delivery_mode: 'drain_on_start' },
      { principal_id: 'duet', active: 0, delivery_mode: 'drain_on_start' },
      { principal_id: 'grokbot', active: 1, delivery_mode: 'drain_on_start' },
      { principal_id: 'muse', active: 0, delivery_mode: 'drain_on_start' },
    ]);

    const app = makeApp('secret-token');
    for (const recipient of ['dot', 'muse', 'duet']) {
      const rejected = await app.request('/api/dispatch/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-archon-operator-token': 'secret-token' },
        body: JSON.stringify({
          ...VALID_BODY,
          idempotency_key: `inactive-${recipient}`,
          recipient,
          body: `delivery to inactive ${recipient}`,
        }),
      });
      expect(rejected.status).toBe(400);
      expect(((await rejected.json()) as { error: string }).error).toBe(
        'dispatch_recipient_rejected:inactive_principal'
      );
    }

    const slotDir = await mkdtemp(join(tmpdir(), 'companion-configured-slot-'));
    try {
      const slotIds = ['dot', 'muse', 'duet', 'synth-active-slot'] as const;
      const slotTokens = Object.fromEntries(slotIds.map(id => [id, `token-for-${id}`])) as Record<
        (typeof slotIds)[number],
        string
      >;
      const slots = [];
      for (const id of slotIds) {
        const credentialFile = join(slotDir, `${id}.dispatch`);
        const digestFile = join(slotDir, `${id}.sha256`);
        await writeFile(credentialFile, `${slotTokens[id]}\n`);
        await writeFile(digestFile, `${sha(`bearer-for-${id}`)}\n`);
        slots.push({
          companion_id: id,
          enabled: true,
          dispatch_principal_id: id,
          token_sha256_file: digestFile,
          token_expires_at: '2099-01-01T00:00:00.000Z',
          dispatch_credential_file: credentialFile,
          tools: [...BASE_TOOL_NAMES],
          allowed_recipients: ['astra'],
          board_secretary: false,
          board_seat_recipients: ['astra'],
        });
      }
      const configPath = join(slotDir, 'companions.json');
      await writeFile(configPath, JSON.stringify({ slots }));
      const loaded = loadCompanionRegistry(configPath);
      expect(loaded.slots.map(slot => [slot.companion_id, slot.enabled])).toEqual(
        slotIds.map(id => [id, true])
      );
      for (const id of slotIds) {
        const slot = loaded.byPrincipal.get(id);
        expect(slot?.enabled).toBe(true);
        expect((await readFile(slot?.dispatch_credential_file ?? '', 'utf8')).trim()).toBe(
          slotTokens[id]
        );
      }

      const afterConfig = await db.query<{ principal_id: string; active: number }>(
        `SELECT principal_id, active FROM dispatch_principals
         WHERE principal_id IN ('dot', 'muse', 'duet')
         ORDER BY principal_id`
      );
      expect(afterConfig.rows).toEqual([
        { principal_id: 'dot', active: 0 },
        { principal_id: 'duet', active: 0 },
        { principal_id: 'muse', active: 0 },
      ]);

      const priorRegistry = JSON.parse(process.env.DISPATCH_PRINCIPALS_JSON ?? '[]') as unknown[];
      process.env.DISPATCH_SENDER_AUTH_MODE = 'enforce';
      process.env.DISPATCH_PRINCIPALS_JSON = JSON.stringify([
        ...priorRegistry,
        ...slotIds.map(id => ({
          credential_id: `configured-${id}`,
          principal_id: id,
          token_sha256: sha(slotTokens[id]),
          status: 'active',
          send_as: [id],
          receive_as: [id],
          roles: ['send', 'receive'],
        })),
      ]);

      async function postSlot(
        principalId: string,
        token: string | undefined,
        idempotencyKey: string
      ): Promise<Response> {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'x-archon-operator-token': 'secret-token',
        };
        if (token !== undefined) {
          headers['x-dispatch-principal-id'] = principalId;
          headers['x-dispatch-principal-token'] = token;
        }
        return app.request('/api/dispatch/messages', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ...VALID_BODY,
            sender: principalId,
            recipient: principalId,
            idempotency_key: idempotencyKey,
            body: `synthetic delivery for ${principalId}`,
          }),
        });
      }

      for (const recipient of ['dot', 'muse', 'duet'] as const) {
        const rejected = await postSlot(
          recipient,
          slotTokens[recipient],
          `configured-${recipient}`
        );
        expect(rejected.status).toBe(400);
        expect(((await rejected.json()) as { error: string }).error).toBe(
          'dispatch_recipient_rejected:inactive_principal'
        );
      }

      await db.query(
        `INSERT INTO dispatch_principals (principal_id, display_name, delivery_mode, active)
         VALUES ('synth-active-slot', 'Synthetic active slot', 'drain_on_start', 0)`
      );
      const inactiveSynth = await postSlot(
        'synth-active-slot',
        slotTokens['synth-active-slot'],
        'synth-inactive-configured'
      );
      expect(inactiveSynth.status).toBe(400);
      expect(((await inactiveSynth.json()) as { error: string }).error).toBe(
        'dispatch_recipient_rejected:inactive_principal'
      );

      await db.query(
        `UPDATE dispatch_principals SET active = 1 WHERE principal_id = 'synth-active-slot'`
      );
      const operatorOnly = await postSlot(
        'synth-active-slot',
        undefined,
        'synth-operator-token-only'
      );
      expect(operatorOnly.status).toBe(401);
      expect(((await operatorOnly.json()) as { error: string }).error).toBe(
        'dispatch_principal_missing'
      );
      const wrongCredential = await postSlot(
        'synth-active-slot',
        'not-the-slot-credential',
        'synth-wrong-credential'
      );
      expect(wrongCredential.status).toBe(401);
      expect(((await wrongCredential.json()) as { error: string }).error).toBe(
        'dispatch_principal_unauthorized'
      );

      const accepted = await postSlot(
        'synth-active-slot',
        (await readFile(join(slotDir, 'synth-active-slot.dispatch'), 'utf8')).trim(),
        'synth-active-create'
      );
      expect(accepted.status).toBe(200);
      expect((await accepted.json()) as { recipient: string; sender_principal_id: string }).toEqual(
        expect.objectContaining({
          recipient: 'synth-active-slot',
          sender: 'synth-active-slot',
          sender_principal_id: 'synth-active-slot',
        })
      );

      const stillInactive = await db.query<{ principal_id: string; active: number }>(
        `SELECT principal_id, active FROM dispatch_principals
         WHERE principal_id IN ('dot', 'muse', 'duet')
         ORDER BY principal_id`
      );
      expect(stillInactive.rows).toEqual([
        { principal_id: 'dot', active: 0 },
        { principal_id: 'duet', active: 0 },
        { principal_id: 'muse', active: 0 },
      ]);
      expect((await db.query('SELECT id FROM agent_dispatch_messages')).rowCount).toBe(1);
    } finally {
      await rm(slotDir, { recursive: true, force: true });
    }
  });
});
