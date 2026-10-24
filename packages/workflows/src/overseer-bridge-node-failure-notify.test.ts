import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  buildNodeFailureNoticeBody,
  isNodeFailureBlocker,
  NODE_FAILURE_BLOCKER_CLASSES,
  notifyNodeFailure,
} from '@archon/overseer';

import * as connection from '@archon/core/db/connection';
import { SqliteAdapter } from '@archon/core/db/adapters/sqlite';
import * as taskmaster from '@archon/core/db/taskmaster';
import * as ownerRouting from '@archon/core/utils/owner-recipient';
import { handleNodeFailure } from './overseer-bridge';

let db: SqliteAdapter;
beforeEach(() => {
  db = new SqliteAdapter(':memory:');
  spyOn(connection, 'getDatabase').mockReturnValue(db);
});
afterEach(async () => {
  mock.restore();
  await db.close();
});

async function caller(nodeId: string, errorMsg: string, errors?: string[]): Promise<void> {
  const noop = (): void => {};
  const log = {
    info: noop,
    error: (_fields: unknown, message: string): void => {
      errors?.push(message);
    },
    warn: noop,
    debug: noop,
  };
  await handleNodeFailure(
    {
      store: { createWorkflowEvent: async () => {} },
      emitter: { emit: noop },
      log,
      logNodeError: async () => {},
    } as unknown as Parameters<typeof handleNodeFailure>[0],
    {
      id: 'caller-run',
      workflow_name: 'bdc-feature-development-codex',
      metadata: { wo_issue_number: 3239 },
      user_message: '',
    } as Parameters<typeof handleNodeFailure>[1],
    {
      id: nodeId,
      bash: 'exit 1',
      load_bearing: true,
    } as Parameters<typeof handleNodeFailure>[2],
    {
      errorMsg,
      logDir: 'unused',
      nodeType: 'bash',
    }
  );
}

const base = {
  runId: 'run-1',
  workflowName: 'bdc-feature-development-codex',
  nodeId: 'commit-and-push',
  errorClass: 'commit_hook_lint_failure' as const,
  decision: 'escalate' as const,
  attempt: 1,
  error: 'Missing return type',
};

describe('node failure dispatch notification', () => {
  test('escalate_writes_duty_officer_message', async () => {
    const sent: unknown[] = [];
    await notifyNodeFailure(base, { error: () => undefined }, (async (_context, data) => {
      sent.push(data);
      return {} as never;
    }) as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ recipient: 'duty-officer', priority: 'normal' });
  });
  test('unknown_class_without_escalation_context_still_notifies', async () => {
    const sent: unknown[] = [];
    await notifyNodeFailure({ ...base, errorClass: 'unknown' }, { error: () => undefined }, (async (
      _c,
      d
    ) => {
      sent.push(d);
      return {} as never;
    }) as never);
    expect(sent).toHaveLength(1);
  });
  test('notification_is_idempotent', async () => {
    await notifyNodeFailure(base, { error: () => {} });
    await notifyNodeFailure(base, { error: () => {} });
    const rows = await db.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM agent_dispatch_messages WHERE correlation_id='run-1'"
    );
    expect(rows.rows).toEqual([{ idempotency_key: 'overseer-node-failure:run-1:commit-and-push' }]);
  });
  for (const [id, expectedAttempt, expectedRecipients] of [
    ['commit-and-push', 1, ['duty-officer']],
    ['commit-and-push-retry', 2, ['duty-officer', 'xo']],
  ] as const) {
    test(`real bridge reports hook attempt ${expectedAttempt} with bounded escalation`, async () => {
      await caller(id, 'lint-staged [FAILED] eslint\nhusky - pre-commit script failed');
      const rows = await db.query<{ recipient: string; body: string; subject_key: string }>(
        'SELECT recipient,body,subject_key FROM agent_dispatch_messages ORDER BY recipient'
      );
      expect(rows.rows.map(row => row.recipient)).toEqual([...expectedRecipients]);
      for (const row of rows.rows) {
        expect(row.body).toContain(`Attempt: ${expectedAttempt}`);
        expect(row.body).toContain('Class: commit_hook_lint_failure');
        expect(row.subject_key).toBe('gh:thinmansoftware/bdc-xo#3239');
      }
    });
  }
  test('real bridge notifies unknown failures even without escalation context', async () => {
    await caller('patch-pr-body', 'novel failure');
    const rows = await db.query<{ body: string }>(
      "SELECT body FROM agent_dispatch_messages WHERE recipient='duty-officer'"
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].body).toContain('Class: unknown');
  });
  test('later node escalation survives addressed WO traffic and remains idempotent', async () => {
    await caller(
      'commit-and-push',
      'lint-staged [FAILED] eslint\nhusky - pre-commit script failed'
    );
    await db.query(
      "UPDATE agent_dispatch_messages SET addressed_at='2026-10-24T00:00:00Z', addressed_by='fixture'"
    );
    await caller(
      'commit-and-push-retry',
      'lint-staged [FAILED] eslint\nhusky - pre-commit script failed'
    );
    await caller(
      'commit-and-push-retry',
      'lint-staged [FAILED] eslint\nhusky - pre-commit script failed'
    );
    const rows = await db.query<{ recipient: string; repeat_reason: string }>(
      "SELECT recipient,repeat_reason FROM agent_dispatch_messages WHERE idempotency_key LIKE '%:commit-and-push-retry' ORDER BY recipient"
    );
    expect(rows.rows).toEqual([
      { recipient: 'duty-officer', repeat_reason: 'node_failure_escalation' },
      { recipient: 'xo', repeat_reason: 'node_failure_escalation' },
    ]);
  });
  test('blocker_also_goes_to_xo', () =>
    expect(isNodeFailureBlocker({ ...base, attempt: 2 })).toBe(true));
  test('blocker_also_goes_to_owner_or_xo', async () => {
    const snapshot = await taskmaster.beginAdoptionSnapshot();
    await taskmaster.upsertAdoptionRow(snapshot, {
      thread_ref: 'gh:thinmansoftware/bdc-xo#3239',
      repo: 'thinmansoftware/bdc-xo',
      issue_number: 3239,
      title: 'fixture',
      priority: 'P1',
      labels_json: '[]',
      owner_login: 'major-build',
      is_blocked: 0,
      blocked_reason: null,
      next_action: null,
      latest_marker_kind: null,
      latest_marker_at: null,
      state: 'open',
      last_movement_at: null,
      last_movement_kind: null,
      attempts_24h: 0,
      attempts_total: 0,
      evidence_observed_at: null,
      source_updated_at: '2026-10-24T00:00:00Z',
    });
    await taskmaster.commitAdoptionSnapshot(snapshot);
    const lookup = spyOn(taskmaster, 'getAdoption');
    const resolver = spyOn(ownerRouting, 'resolveRecipient');
    await caller(
      'commit-and-push-retry',
      'lint-staged [FAILED] eslint\nhusky - pre-commit script failed'
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith('major-build');
    await notifyNodeFailure(
      {
        ...base,
        runId: 'credits-run',
        errorClass: 'out_of_credits',
        metadata: { wo_issue_number: 3239 },
      },
      { error: () => {} }
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    const rows = await db.query<{ recipient: string; priority: string }>(
      "SELECT recipient,priority FROM agent_dispatch_messages WHERE priority='blocker'"
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every(row => row.recipient === 'xo')).toBe(true);
  });
  for (const failure of [false, true]) {
    test(`owner routing retains DO delivery with ${failure ? 'failed lookup' : 'missing WO'}`, async () => {
      const lookup = spyOn(taskmaster, 'getAdoption');
      if (failure) lookup.mockRejectedValue(new Error('fixture lookup unavailable'));
      const resolver = spyOn(ownerRouting, 'resolveRecipient');
      const errors: string[] = [];
      await notifyNodeFailure(
        { ...base, attempt: 2, ...(failure ? { metadata: { wo_issue_number: 3239 } } : {}) },
        {
          error: (_fields, message) => {
            errors.push(message);
          },
        }
      );
      expect(resolver).toHaveBeenCalledWith(null);
      expect(lookup).toHaveBeenCalledTimes(failure ? 1 : 0);
      const rows = await db.query<{ recipient: string }>(
        'SELECT recipient FROM agent_dispatch_messages ORDER BY recipient'
      );
      expect(rows.rows.map(row => row.recipient)).toEqual(['duty-officer', 'xo']);
      if (failure) expect(errors).toContain('overseer.node_failure_owner_lookup_failed');
    });
  }
  test('blocker_table_is_exported_and_complete', async () => {
    expect(NODE_FAILURE_BLOCKER_CLASSES).toEqual(['out_of_credits', 'auth_failed']);
    for (const errorClass of NODE_FAILURE_BLOCKER_CLASSES) {
      const sent: { recipient: string; priority: string }[] = [];
      await notifyNodeFailure({ ...base, errorClass }, { error: () => {} }, (async (
        _context,
        data
      ) => {
        sent.push(data);
        return {} as never;
      }) as never);
      expect(sent).toEqual([
        expect.objectContaining({ recipient: 'duty-officer', priority: 'normal' }),
        expect.objectContaining({ recipient: 'xo', priority: 'blocker' }),
      ]);
    }
    expect(isNodeFailureBlocker({ ...base, errorClass: 'unknown' })).toBe(false);
  });
  test('error_line_is_redacted_and_truncated', () => {
    const body = buildNodeFailureNoticeBody({
      ...base,
      error: `Authorization: Bearer secret${'x'.repeat(600)}`,
    });
    expect(body).not.toContain('secret');
    expect(body.split('Error: ')[1].length).toBeLessThanOrEqual(300);
  });
  test('failed_notify_does_not_recurse_or_throw', async () => {
    await expect(
      notifyNodeFailure(base, { error: () => undefined }, (async () => {
        throw new Error('closed');
      }) as never)
    ).resolves.toBeUndefined();
  });
  test('real closed database notification failure returns through handleNodeFailure', async () => {
    const errors: string[] = [];
    await db.close();
    await caller('patch-pr-body', 'novel failure', errors);
    expect(errors).toContain('overseer.node_failure_notify_failed');
    expect(errors.length).toBeLessThanOrEqual(3);
  });
  test('clean_run_creates_no_message', async () => {
    let count = 0;
    await notifyNodeFailure(
      { ...base, decision: 'skip' },
      { error: () => undefined },
      (async () => {
        count += 1;
        return {} as never;
      }) as never
    );
    expect(count).toBe(0);
  });
});
