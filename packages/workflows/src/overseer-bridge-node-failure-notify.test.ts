/**
 * WO-HARNESS-OVERSEER-NODE-FAILURE-REPAIR-AND-ESCALATION-01
 *
 * Every Overseer `escalate` decision on a node failure writes a duty-officer
 * Dispatch message (and, for a blocker, an xo message) instead of the run dying
 * silently. These tests run against the REAL dispatch DAL on a per-test
 * SqliteAdapter -- the same harness pattern pr-review-wiring-integration.test.ts
 * uses -- NOT a mock of createAuthenticatedMessage.
 *
 * Anchor: run 3993fe05 (2026-10-14) escalated a commit-hook lint failure with
 * ZERO rows in agent_dispatch_messages; nobody was told.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import type { WorkflowRun, NodeOutput } from './schemas/workflow-run.ts';
import type { DagNode } from './schemas/dag-node.ts';
import type { IWorkflowStore } from './store.ts';
import type { Logger } from '@archon/paths';

let db: import('@archon/core/db/adapters/sqlite').SqliteAdapter;
let currentDbPath = '';

// Spread the real connection module (see pr-review-wiring-integration.test.ts):
// replacing it with an object carrying only getDatabase would drop every other
// export for later-loaded files.
import * as realConnection from '@archon/core/db/connection';

mock.module('@archon/core/db/connection', () => ({
  ...realConnection,
  getDatabase: () => db,
}));

afterAll(() => {
  mock.restore();
});

const { SqliteAdapter } = await import('@archon/core/db/adapters/sqlite');
// Imported AFTER mock.module so the dispatch DAL binds the mocked connection.
const { handleNodeFailure } = await import('./overseer-bridge.ts');
const { buildNodeFailureNotifyBody, firstRedactedErrorLine, BLOCKER_ERROR_CLASSES } =
  await import('@archon/overseer');

interface DispatchRow {
  recipient: string;
  sender: string;
  correlation_id: string;
  idempotency_key: string;
  subject_key: string | null;
  priority: string;
  task_type: string;
  body: string;
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

interface RecordedLog {
  errors: { obj: unknown; msg: string }[];
}

function makeLog(recorded: RecordedLog): Logger {
  const noop = (): undefined => undefined;
  const error = (obj: unknown, msg?: string): undefined => {
    recorded.errors.push({ obj, msg: typeof msg === 'string' ? msg : '' });
    return undefined;
  };
  const self = {
    info: noop,
    warn: noop,
    error,
    debug: noop,
    fatal: noop,
    trace: noop,
    silent: noop,
    child: () => self,
    bindings: () => ({}),
    level: 'info',
    levels: { values: {}, labels: {} },
  };
  return self as unknown as Logger;
}

function makeStore(): IWorkflowStore {
  return {
    listWorkflowRuns: mock(() => Promise.resolve([])),
    createWorkflowRun: mock(() => Promise.resolve(undefined as never)),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    updateWorkflowRunStatus: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve()),
    failWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve()),
    createWorkflowEvent: mock(() => Promise.resolve()),
    listWorkflowEvents: mock(() => Promise.resolve([])),
    getCompletedDagNodeOutputs: mock(() => Promise.resolve(new Map<string, string>())),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
  } as unknown as IWorkflowStore;
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-node-failure-1',
    workflow_name: 'bdc-feature-development-codex',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'Implement WO',
    metadata: {},
    started_at: new Date('2026-10-14T00:00:00Z'),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    archived_at: null,
    archived_by: null,
    archive_reason: null,
    ...overrides,
  } as unknown as WorkflowRun;
}

function node(id: string): DagNode {
  return { id, command: id } as DagNode;
}

// Real lint-staged ordering: eslint prints the finding first, husky prints the
// summary line last. The notify body carries the FIRST non-empty error line, so
// the finding (with "Missing return type") is what reaches the digest.
const HOOK_ERROR = [
  'packages/server/src/taskmaster/loop.ts:1419:19  error  Missing return type on function  @typescript-eslint/explicit-function-return-type',
  '[FAILED] eslint --fix --max-warnings 0 --no-warn-ignored',
  'husky - pre-commit script failed (code 1)',
].join('\n');

async function dispatchRows(prefix: string): Promise<DispatchRow[]> {
  const rows = await db.query<DispatchRow>(
    `SELECT recipient, sender, correlation_id, idempotency_key, subject_key, priority, task_type, body
       FROM agent_dispatch_messages
      WHERE idempotency_key LIKE $1
      ORDER BY idempotency_key ASC`,
    [`${prefix}%`]
  );
  return rows.rows;
}

const baseCtx = { logDir: '/tmp/test-logs', outputSoFar: '' };

describe('handleNodeFailure node-failure Dispatch notification', () => {
  beforeEach(() => {
    currentDbPath = join(
      import.meta.dir,
      `.test-node-failure-notify-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new SqliteAdapter(currentDbPath);
  });

  afterEach(async () => {
    await db.close();
    cleanupDb(currentDbPath);
  });

  test('8 escalate writes a duty-officer message with full context + subject_key', async () => {
    const recorded: RecordedLog = { errors: [] };
    const run = makeRun({ id: 'run-8', metadata: { woIssueNumber: 3201 } });
    await handleNodeFailure(
      {
        store: makeStore(),
        emitter: { emit: () => undefined },
        log: makeLog(recorded),
        logNodeError: () => Promise.resolve(),
      },
      run,
      node('commit-and-push'),
      { ...baseCtx, errorMsg: HOOK_ERROR }
    );
    const rows = await dispatchRows('overseer-node-failure:run-8:');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.recipient).toBe('duty-officer');
    expect(row.sender).toBe('overseer');
    expect(row.correlation_id).toBe('run-8');
    expect(row.idempotency_key).toBe('overseer-node-failure:run-8:commit-and-push');
    expect(row.subject_key).toBe('gh:thinmansoftware/bdc-xo#3201');
    expect(row.priority).toBe('normal');
    expect(row.task_type).toBe('agent_message');
    expect(typeof row.body).toBe('string');
    for (const fragment of [
      'run-8',
      'bdc-feature-development-codex',
      'commit-and-push',
      'commit_hook_lint_failure',
      'Missing return type',
    ]) {
      expect(row.body).toContain(fragment);
    }
  });

  test('9 unknown class with no escalationContext still notifies duty-officer', async () => {
    const run = makeRun({ id: 'run-9' });
    await handleNodeFailure(
      {
        store: makeStore(),
        emitter: { emit: () => undefined },
        log: makeLog({ errors: [] }),
        logNodeError: () => Promise.resolve(),
      },
      run,
      node('patch-pr-body'),
      { ...baseCtx, errorMsg: 'could not resolve PR URL from open-pr-if-needed output' }
    );
    const rows = await dispatchRows('overseer-node-failure:run-9:');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient).toBe('duty-officer');
    expect(rows[0]!.body).toContain('unknown');
  });

  test('10 notification is idempotent across repeated calls', async () => {
    const run = makeRun({ id: 'run-10' });
    const deps = {
      store: makeStore(),
      emitter: { emit: () => undefined },
      log: makeLog({ errors: [] }),
      logNodeError: () => Promise.resolve(),
    };
    await handleNodeFailure(deps, run, node('commit-and-push'), {
      ...baseCtx,
      errorMsg: HOOK_ERROR,
    });
    await handleNodeFailure(deps, run, node('commit-and-push'), {
      ...baseCtx,
      errorMsg: HOOK_ERROR,
    });
    const rows = await dispatchRows('overseer-node-failure:run-10:commit-and-push');
    expect(rows).toHaveLength(1);
  });

  test('11 blocker also messages xo; first-attempt hook failure does not', async () => {
    // out_of_credits is an always-blocker class.
    const runCredits = makeRun({ id: 'run-11c' });
    await handleNodeFailure(
      {
        store: makeStore(),
        emitter: { emit: () => undefined },
        log: makeLog({ errors: [] }),
        logNodeError: () => Promise.resolve(),
      },
      runCredits,
      node('implement'),
      { ...baseCtx, errorMsg: 'credit balance is too low' }
    );
    const duty = await dispatchRows('overseer-node-failure:run-11c:implement');
    const xo = await dispatchRows('overseer-node-failure-blocker:run-11c:implement');
    expect(duty).toHaveLength(1);
    expect(duty[0]!.priority).toBe('normal');
    expect(xo).toHaveLength(1);
    expect(xo[0]!.recipient).toBe('xo');
    expect(xo[0]!.priority).toBe('blocker');

    // commit_hook_lint_failure at attempt 2 is a blocker.
    const runHook2 = makeRun({ id: 'run-11h' });
    await handleNodeFailure(
      {
        store: makeStore(),
        emitter: { emit: () => undefined },
        log: makeLog({ errors: [] }),
        logNodeError: () => Promise.resolve(),
      },
      runHook2,
      node('commit-and-push'),
      { ...baseCtx, errorMsg: HOOK_ERROR, attempt: 2 }
    );
    expect(
      await dispatchRows('overseer-node-failure-blocker:run-11h:commit-and-push')
    ).toHaveLength(1);

    // commit_hook_lint_failure at attempt 1 is NOT a blocker -> no xo message.
    const runHook1 = makeRun({ id: 'run-11h1' });
    await handleNodeFailure(
      {
        store: makeStore(),
        emitter: { emit: () => undefined },
        log: makeLog({ errors: [] }),
        logNodeError: () => Promise.resolve(),
      },
      runHook1,
      node('commit-and-push'),
      { ...baseCtx, errorMsg: HOOK_ERROR, attempt: 1 }
    );
    expect(await dispatchRows('overseer-node-failure:run-11h1:commit-and-push')).toHaveLength(1);
    expect(
      await dispatchRows('overseer-node-failure-blocker:run-11h1:commit-and-push')
    ).toHaveLength(0);
  });

  test('12 every blocker-table class triggers the xo path; a non-member does not', async () => {
    const errorForClass: Record<string, string> = {
      out_of_credits: 'credit balance is too low',
      auth_failed: 'authentication_failed',
    };
    for (const cls of BLOCKER_ERROR_CLASSES) {
      const runId = `run-12-${cls}`;
      await handleNodeFailure(
        {
          store: makeStore(),
          emitter: { emit: () => undefined },
          log: makeLog({ errors: [] }),
          logNodeError: () => Promise.resolve(),
        },
        makeRun({ id: runId }),
        node('implement'),
        { ...baseCtx, errorMsg: errorForClass[cls] ?? cls }
      );
      expect(await dispatchRows(`overseer-node-failure-blocker:${runId}:implement`)).toHaveLength(
        1
      );
    }
    // A non-member (unknown) escalates but is NOT a blocker -> no xo message.
    await handleNodeFailure(
      {
        store: makeStore(),
        emitter: { emit: () => undefined },
        log: makeLog({ errors: [] }),
        logNodeError: () => Promise.resolve(),
      },
      makeRun({ id: 'run-12-unknown' }),
      node('patch-pr-body'),
      { ...baseCtx, errorMsg: 'totally unrecognised failure text' }
    );
    expect(await dispatchRows('overseer-node-failure:run-12-unknown:patch-pr-body')).toHaveLength(
      1
    );
    expect(
      await dispatchRows('overseer-node-failure-blocker:run-12-unknown:patch-pr-body')
    ).toHaveLength(0);
  });

  test('13 error line is redacted and truncated to 300 chars', () => {
    const secret = 'abc123secret';
    const longLine = `Authorization: Bearer ${secret} ` + 'x'.repeat(600);
    const line = firstRedactedErrorLine(longLine);
    expect(line).not.toContain(secret);
    expect(line.length).toBeLessThanOrEqual(300);
    const body = buildNodeFailureNotifyBody({
      runId: 'r',
      workflowName: 'w',
      nodeId: 'n',
      errorClass: 'unknown',
      decision: 'escalate',
      attempt: 1,
      errorMsg: longLine,
      blocker: false,
      subjectKey: null,
    });
    expect(body).not.toContain(secret);
    const errorPortion = body.split('error: ')[1] ?? '';
    expect(errorPortion.length).toBeLessThanOrEqual(300);
  });

  test('14 a failed dispatch write does not throw or recurse; logs once', async () => {
    const recorded: RecordedLog = { errors: [] };
    const run = makeRun({ id: 'run-14' });
    await db.close(); // force every dispatch write to fail
    const result = await handleNodeFailure(
      {
        store: makeStore(),
        emitter: { emit: () => undefined },
        log: makeLog(recorded),
        logNodeError: () => Promise.resolve(),
      },
      run,
      node('commit-and-push'),
      { ...baseCtx, errorMsg: HOOK_ERROR, attempt: 2 }
    );
    const output: NodeOutput = result.output;
    expect(output.state).toBe('failed');
    const notifyFailures = recorded.errors.filter(
      e => e.msg === 'overseer.node_failure_notify_failed'
    );
    expect(notifyFailures).toHaveLength(1);
    // Re-open so afterEach close() does not throw on an already-closed db.
    db = new SqliteAdapter(currentDbPath);
  });

  test('15 a skip decision creates no node-failure Dispatch message', async () => {
    const run = makeRun({ id: 'run-15' });
    const result = await handleNodeFailure(
      {
        store: makeStore(),
        emitter: { emit: () => undefined },
        log: makeLog({ errors: [] }),
        logNodeError: () => Promise.resolve(),
      },
      run,
      node('verify-build'),
      // npm_not_found -> decide returns 'skip'
      { ...baseCtx, errorMsg: 'command not found: npm', exitCode: 127 }
    );
    expect(result.decision).toBe('skip');
    expect(await dispatchRows('overseer-node-failure')).toHaveLength(0);
  });
});
