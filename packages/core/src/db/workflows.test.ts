import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { unlinkSync } from 'fs';
import { join } from 'path';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import { SqliteAdapter } from './adapters/sqlite';
import type { IDatabase } from './adapters/types';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type {
  ProviderAttemptRecord,
  RunAuthorityRecord,
  RunLeaseRecord,
  RunOutcome,
  ScheduledProviderWaitRecord,
  SupervisorIncidentRecord,
  TerminalWorkflowPersistence,
} from '@archon/workflows/reliability/types';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
const mockTransactionQuery = mock(() => Promise.resolve(createQueryResult([])));
const mockWithTransaction = mock((fn: (query: typeof mockTransactionQuery) => Promise<unknown>) =>
  fn(mockTransactionQuery)
);
const defaultMockDatabase = {
  dialect: 'postgres' as const,
  sql: mockPostgresDialect,
  withTransaction: mockWithTransaction,
};
let activeDatabase: Pick<IDatabase, 'dialect' | 'sql' | 'withTransaction'> = defaultMockDatabase;

// Mock the connection module before importing the module under test
mock.module('./connection', () => ({
  pool: {
    query: mockQuery,
  },
  getDialect: () => mockPostgresDialect,
  getDatabaseType: () => 'postgresql' as const,
  getDatabase: () => activeDatabase,
}));

import {
  createWorkflowRun,
  getWorkflowRun,
  getWorkflowRunByDispatchToken,
  getWorkflowRunStatus,
  getActiveWorkflowRun,
  getActiveWorkflowRunByPath,
  updateWorkflowRun,
  completeWorkflowRun,
  failWorkflowRun,
  cancelWorkflowRun,
  updateWorkflowActivity,
  findResumableRun,
  resumeWorkflowRun,
  failOrphanedRuns,
  listWorkflowRuns,
  listWorkflowRunsWithWorkingPath,
  sumWorkflowTokensInWindow,
  deleteOldWorkflowRuns,
  deleteWorkflowRun,
  createRunAuthority,
  getRunAuthority,
  claimRunLease,
  heartbeatRunLease,
  releaseRunLease,
  listExpiredRunLeases,
  interruptExpiredRunLease,
  listPendingWorkflowRunsBefore,
  orphanPendingWorkflowRun,
  listStaleRunningWorkflowRunsBefore,
  failStaleRunningWorkflowRun,
  createProviderAttempt,
  completeProviderAttempt,
  listProviderAttempts,
  listProviderAttemptsFeed,
  upsertRunOutcome,
  getRunOutcome,
  scheduleProviderWait,
  listDueProviderWaits,
  claimProviderWait,
  releaseProviderWaitClaim,
  cancelProviderWaits,
  completeProviderWait,
  createSupervisorIncident,
  appendSupervisorObservation,
  listSupervisorObservations,
  claimSupervisorRepairLease,
  heartbeatSupervisorRepairLease,
  authorizeSupervisorMutation,
  reserveSupervisorAction,
  finalizeSupervisorAction,
  appendSupervisorAction,
  releaseSupervisorRepairLease,
  reconcileTerminalWorkflowRuns,
  getCauldronDrainState,
  setCauldronDrainMode,
} from './workflows';

describe('workflows database', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
    mockTransactionQuery.mockReset();
    mockTransactionQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
    mockWithTransaction.mockClear();
    activeDatabase = defaultMockDatabase;
  });

  const mockWorkflowRun: WorkflowRun = {
    id: 'workflow-run-123',
    workflow_name: 'feature-development',
    conversation_id: 'conv-456',
    parent_conversation_id: null,
    codebase_id: 'codebase-789',
    status: 'running',
    user_message: 'Add dark mode support',
    metadata: {},
    started_at: new Date('2025-01-01T00:00:00Z'),
    completed_at: null,
    last_activity_at: new Date('2025-01-01T00:00:00Z'),
    working_path: null,
  };

  describe('createWorkflowRun', () => {
    test('creates a new workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await createWorkflowRun({
        workflow_name: 'feature-development',
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        user_message: 'Add dark mode support',
      });

      expect(result).toEqual(mockWorkflowRun);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_workflow_runs'),
        [
          'feature-development',
          'conv-456',
          'codebase-789',
          'Add dark mode support',
          '{}',
          null,
          null,
          null,
        ]
      );
    });

    test('creates workflow run with metadata', async () => {
      const runWithMetadata = {
        ...mockWorkflowRun,
        metadata: { github_context: 'Issue #42 context' },
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([runWithMetadata]));

      const result = await createWorkflowRun({
        workflow_name: 'feature-development',
        conversation_id: 'conv-456',
        codebase_id: 'codebase-789',
        user_message: 'Add dark mode support',
        metadata: { github_context: 'Issue #42 context' },
      });

      expect(result.metadata).toEqual({ github_context: 'Issue #42 context' });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_workflow_runs'),
        [
          'feature-development',
          'conv-456',
          'codebase-789',
          'Add dark mode support',
          JSON.stringify({ github_context: 'Issue #42 context' }),
          null,
          null,
          null,
        ]
      );
    });

    test('creates workflow run without codebase_id', async () => {
      const runWithoutCodebase = { ...mockWorkflowRun, codebase_id: null };
      mockQuery.mockResolvedValueOnce(createQueryResult([runWithoutCodebase]));

      const result = await createWorkflowRun({
        workflow_name: 'feature-development',
        conversation_id: 'conv-456',
        user_message: 'Add dark mode support',
      });

      expect(result.codebase_id).toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO remote_agent_workflow_runs'),
        ['feature-development', 'conv-456', null, 'Add dark mode support', '{}', null, null, null]
      );
    });
  });

  describe('getWorkflowRunByDispatchToken', () => {
    test('resolves a run by its deterministic dispatch token', async () => {
      const tokenedRun = { ...mockWorkflowRun, dispatch_token: 'cascade-x:attempt:1' };
      mockQuery.mockResolvedValueOnce(createQueryResult([tokenedRun]));

      const result = await getWorkflowRunByDispatchToken('cascade-x:attempt:1');

      expect(result?.id).toBe('workflow-run-123');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE r.dispatch_token = $1'),
        ['cascade-x:attempt:1']
      );
    });

    test('returns null when no run carries the token', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getWorkflowRunByDispatchToken('cascade-x:attempt:99');

      expect(result).toBeNull();
    });
  });

  describe('getWorkflowRun', () => {
    test('returns workflow run by id', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await getWorkflowRun('workflow-run-123');

      expect(result).toEqual(mockWorkflowRun);
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT * FROM remote_agent_workflow_runs WHERE id = $1',
        ['workflow-run-123']
      );
    });

    test('returns null for non-existent workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getWorkflowRun('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getWorkflowRunStatus', () => {
    test('returns status for existing workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ status: 'running' }]));

      const result = await getWorkflowRunStatus('workflow-run-123');

      expect(result).toBe('running');
      expect(mockQuery).toHaveBeenCalledWith(
        'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
        ['workflow-run-123']
      );
    });

    test('returns null for non-existent workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getWorkflowRunStatus('non-existent');

      expect(result).toBeNull();
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(getWorkflowRunStatus('test-id')).rejects.toThrow(
        'Failed to get workflow run status: Connection refused'
      );
    });
  });

  describe('getActiveWorkflowRun', () => {
    test('returns active workflow run for conversation', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await getActiveWorkflowRun('conv-456');

      expect(result).toEqual(mockWorkflowRun);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining(
          "(conversation_id = $1 OR parent_conversation_id = $2) AND status = 'running'"
        ),
        ['conv-456', 'conv-456']
      );
    });

    test('returns null when no active workflow run', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getActiveWorkflowRun('conv-456');

      expect(result).toBeNull();
    });
  });

  describe('updateWorkflowRun', () => {
    test('updates status to completed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { status: 'completed' });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      // Preserve existing completed_at when re-labeling terminal runs (escalated path).
      expect(query).toContain('completed_at = COALESCE(completed_at, NOW())');
    });

    test('updates status to failed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { status: 'failed' });

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).toContain('completed_at = COALESCE(completed_at, NOW())');
    });

    test('updates metadata', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', { metadata: { lastStep: 'plan' } });

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('metadata = metadata ||'), [
        JSON.stringify({ lastStep: 'plan' }),
        'workflow-run-123',
      ]);
    });

    test('updates multiple fields', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await updateWorkflowRun('workflow-run-123', {
        status: 'running',
        metadata: { step: 'plan' },
      });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status = $1');
      expect(query).toContain('metadata = metadata ||');
      expect(params).toEqual(['running', '{"step":"plan"}', 'workflow-run-123']);
    });

    test('does nothing when no updates provided', async () => {
      await updateWorkflowRun('workflow-run-123', {});

      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('completeWorkflowRun', () => {
    test('atomically persists outcome, legacy status, and terminal event before returning', async () => {
      const terminal: TerminalWorkflowPersistence = {
        outcome: {
          executionState: 'completed',
          deliverableState: 'none',
          validationState: 'not_run',
          recoveryState: 'not_needed',
          routeState: 'current',
          primaryReason: 'execution_completed',
          reasonCodes: ['execution_completed'],
          evidenceRefs: ['run:workflow-run-123'],
        },
        updatedAt: '2026-07-09T18:00:00.000Z',
        eventData: { duration_ms: 100 },
      };
      mockTransactionQuery
        .mockResolvedValueOnce(createQueryResult([{ status: 'running' }], 1))
        .mockResolvedValueOnce(createQueryResult([{ run_id: 'workflow-run-123' }], 1))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([], 1));

      await completeWorkflowRun('workflow-run-123', { node_counts: { total: 1 } }, terminal);

      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      const queries = mockTransactionQuery.mock.calls.map(call => call[0] as string);
      expect(queries[0]).toContain('SELECT status');
      expect(queries[1]).toContain('remote_agent_run_outcomes');
      expect(queries[2]).toContain('remote_agent_workflow_runs');
      expect(queries[3]).toContain('remote_agent_workflow_events');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('propagates an atomic terminal event failure without falling back to legacy writes', async () => {
      const terminal: TerminalWorkflowPersistence = {
        outcome: {
          executionState: 'completed',
          deliverableState: 'none',
          validationState: 'not_run',
          recoveryState: 'not_needed',
          routeState: 'current',
          primaryReason: 'execution_completed',
          reasonCodes: ['execution_completed'],
          evidenceRefs: ['run:workflow-run-123'],
        },
        updatedAt: '2026-07-09T18:00:00.000Z',
        eventData: { duration_ms: 100 },
      };
      mockTransactionQuery
        .mockResolvedValueOnce(createQueryResult([{ status: 'running' }], 1))
        .mockResolvedValueOnce(createQueryResult([{ run_id: 'workflow-run-123' }], 1))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockRejectedValueOnce(new Error('event insert failed'));

      await expect(
        completeWorkflowRun('workflow-run-123', { node_counts: { total: 1 } }, terminal)
      ).rejects.toThrow('event insert failed');
      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test('rejects a changed outcome when retrying an already-terminal finalization', async () => {
      const terminal: TerminalWorkflowPersistence = {
        outcome: {
          executionState: 'completed',
          deliverableState: 'none',
          validationState: 'not_run',
          recoveryState: 'not_needed',
          routeState: 'current',
          primaryReason: 'execution_completed',
          reasonCodes: ['execution_completed'],
          evidenceRefs: ['run:workflow-run-123'],
        },
        updatedAt: '2026-07-09T18:00:00.000Z',
        eventData: { duration_ms: 100 },
      };
      mockTransactionQuery
        .mockResolvedValueOnce(createQueryResult([{ status: 'completed' }], 1))
        .mockResolvedValueOnce(
          createQueryResult([
            {
              execution_state: 'completed',
              deliverable_state: 'pushed',
              validation_state: 'not_run',
              recovery_state: 'not_needed',
              route_state: 'current',
              primary_reason: 'execution_completed',
              reason_codes: ['execution_completed'],
              evidence_refs: ['run:workflow-run-123'],
            },
          ])
        );

      await expect(
        completeWorkflowRun('workflow-run-123', { node_counts: { total: 1 } }, terminal)
      ).rejects.toThrow('terminal_outcome_conflict');
    });

    test('marks workflow run as completed', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await completeWorkflowRun('workflow-run-123');

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'completed'"), [
        'workflow-run-123',
      ]);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('completed_at = NOW()'), [
        'workflow-run-123',
      ]);
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("AND status = 'running'"), [
        'workflow-run-123',
      ]);
    });

    test('throws when rowCount is 0', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(completeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'not found or not in running state'
      );
    });

    test('merges metadata when provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      const metadata = { node_counts: { completed: 3, failed: 1, skipped: 0, total: 4 } };

      await completeWorkflowRun('workflow-run-123', metadata);

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'completed'");
      expect(query).toContain('metadata = metadata ||');
      expect(params).toEqual(['workflow-run-123', JSON.stringify(metadata)]);
    });

    test('uses simple query without metadata merge when no metadata provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await completeWorkflowRun('workflow-run-123');

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).not.toContain('metadata =');
      expect(params).toEqual(['workflow-run-123']);
    });
  });

  describe('failWorkflowRun', () => {
    test('atomically stores failed node counts, terminal cause, outcome, and event', async () => {
      const terminal: TerminalWorkflowPersistence = {
        outcome: {
          executionState: 'failed',
          deliverableState: 'worktree_changes',
          validationState: 'not_run',
          recoveryState: 'recoverable',
          routeState: 'current',
          primaryReason: 'execution_failed',
          reasonCodes: ['execution_failed'],
          evidenceRefs: ['run:workflow-run-123'],
        },
        updatedAt: '2026-07-09T18:00:00.000Z',
        metadata: {
          node_counts: { completed: 1, failed: 1, skipped: 0, total: 2 },
          terminal_cause: 'node_failures',
        },
        eventData: { terminal_cause: 'node_failures' },
      };
      mockTransactionQuery
        .mockResolvedValueOnce(createQueryResult([{ status: 'running' }], 1))
        .mockResolvedValueOnce(createQueryResult([{ run_id: 'workflow-run-123' }], 1))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([], 1));

      await failWorkflowRun('workflow-run-123', 'implement failed', terminal);

      const updateCall = mockTransactionQuery.mock.calls[2] as [string, unknown[]];
      expect(updateCall[0]).toContain('remote_agent_workflow_runs');
      expect(JSON.parse(updateCall[1][1] as string)).toEqual({
        error: 'implement failed',
        node_counts: { completed: 1, failed: 1, skipped: 0, total: 2 },
        terminal_cause: 'node_failures',
      });
      const eventCall = mockTransactionQuery.mock.calls[3] as [string, unknown[]];
      expect(eventCall[1][1]).toBe('workflow_failed');
    });

    test('marks workflow run as failed with error', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await failWorkflowRun('workflow-run-123', 'Step not found: missing.md');

      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), [
        'workflow-run-123',
        JSON.stringify({ error: 'Step not found: missing.md' }),
      ]);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('completed_at = NOW()'),
        expect.any(Array)
      );
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("AND status = 'running'"),
        expect.any(Array)
      );
    });

    test('stores error in metadata', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));

      await failWorkflowRun('workflow-run-123', 'Timeout exceeded');

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toContain(JSON.stringify({ error: 'Timeout exceeded' }));
    });

    test('throws when rowCount is 0', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(failWorkflowRun('workflow-run-123', 'some error')).rejects.toThrow(
        'not found or not in running state'
      );
    });
  });

  describe('cancelWorkflowRun', () => {
    test('atomically persists cancellation outcome, status, and terminal event', async () => {
      const terminal = {
        outcome: {
          executionState: 'cancelled' as const,
          deliverableState: 'none' as const,
          validationState: 'not_run' as const,
          recoveryState: 'not_needed' as const,
          routeState: 'current' as const,
          primaryReason: 'cancelled_by_operator' as const,
          reasonCodes: ['cancelled_by_operator' as const],
          evidenceRefs: ['run:run-1'],
        },
        eventData: { reason_code: 'cancelled_by_operator' },
        updatedAt: '2026-07-09T20:00:00.000Z',
      };
      mockTransactionQuery
        .mockResolvedValueOnce(createQueryResult([{ status: 'running' }], 1))
        .mockResolvedValueOnce(createQueryResult([{ run_id: 'run-1' }], 1))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([], 1));

      await cancelWorkflowRun('run-1', terminal);

      expect(mockWithTransaction).toHaveBeenCalledTimes(1);
      expect(mockTransactionQuery).toHaveBeenCalledTimes(5);
      expect(mockTransactionQuery.mock.calls[2]?.[0]).toContain('status = $1');
      expect(mockTransactionQuery.mock.calls[2]?.[1]).toEqual([
        'cancelled',
        JSON.stringify({}),
        'run-1',
        'running',
      ]);
      expect(mockTransactionQuery.mock.calls[3]?.[0]).toContain('remote_agent_scheduled_waits');
      expect(mockTransactionQuery.mock.calls[4]?.[1]).toEqual([
        'run-1',
        'workflow_cancelled',
        null,
        JSON.stringify(terminal.eventData),
      ]);
    });

    test('cancels a waiting-provider run and its claimed wake in one transaction', async () => {
      const terminal: TerminalWorkflowPersistence = {
        outcome: {
          executionState: 'cancelled',
          deliverableState: 'none',
          validationState: 'not_run',
          recoveryState: 'not_needed',
          routeState: 'exhausted',
          primaryReason: 'cancelled_by_operator',
          reasonCodes: ['cancelled_by_operator'],
          evidenceRefs: ['run:run-waiting'],
        },
        eventData: { reason_code: 'cancelled_by_operator' },
        updatedAt: '2026-07-09T20:00:00.000Z',
      };
      mockTransactionQuery
        .mockResolvedValueOnce(createQueryResult([{ status: 'waiting_provider' }], 1))
        .mockResolvedValueOnce(createQueryResult([{ run_id: 'run-waiting' }], 1))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([], 1));

      await cancelWorkflowRun('run-waiting', terminal);

      expect(mockTransactionQuery.mock.calls[2]?.[1]).toEqual([
        'cancelled',
        JSON.stringify({}),
        'run-waiting',
        'waiting_provider',
      ]);
      expect(mockTransactionQuery.mock.calls[3]?.[0]).toContain(
        "state IN ('scheduled', 'claimed')"
      );
    });
  });

  describe('error handling', () => {
    test('createWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        createWorkflowRun({
          workflow_name: 'test',
          conversation_id: 'conv',
          user_message: 'test',
        })
      ).rejects.toThrow('Failed to create workflow run: Connection refused');
    });

    test('getWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Timeout'));

      await expect(getWorkflowRun('test-id')).rejects.toThrow(
        'Failed to get workflow run: Timeout'
      );
    });

    test('getActiveWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Invalid query'));

      await expect(getActiveWorkflowRun('conv-123')).rejects.toThrow(
        'Failed to get active workflow run: Invalid query'
      );
    });

    test('updateWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Update failed'));

      await expect(updateWorkflowRun('test-id', { status: 'completed' })).rejects.toThrow(
        'Failed to update workflow run: Update failed'
      );
    });

    test('completeWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database locked'));

      await expect(completeWorkflowRun('test-id')).rejects.toThrow(
        'Failed to complete workflow run: Database locked'
      );
    });

    test('failWorkflowRun throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Network error'));

      await expect(failWorkflowRun('test-id', 'Some error')).rejects.toThrow(
        'Failed to fail workflow run: Network error'
      );
    });
  });

  describe('metadata serialization', () => {
    test('throws when critical github_context metadata fails to serialize', async () => {
      // Create metadata with a circular reference
      const circularObj: Record<string, unknown> = { github_context: 'Issue context' };
      circularObj.self = circularObj;

      await expect(
        createWorkflowRun({
          workflow_name: 'test',
          conversation_id: 'conv',
          user_message: 'test',
          metadata: circularObj,
        })
      ).rejects.toThrow('Failed to serialize workflow metadata');
    });

    test('falls back to empty object for non-critical metadata serialization failure', async () => {
      // Create metadata WITHOUT github_context but with circular reference
      const circularObj: Record<string, unknown> = { someKey: 'value' };
      circularObj.self = circularObj;

      mockQuery.mockResolvedValueOnce(createQueryResult([{ ...mockWorkflowRun, metadata: {} }]));

      const result = await createWorkflowRun({
        workflow_name: 'test',
        conversation_id: 'conv',
        user_message: 'test',
        metadata: circularObj,
      });

      // Should succeed with empty metadata fallback
      expect(result.metadata).toEqual({});
      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params[4]).toBe('{}');
    });

    test('serializes github_context metadata successfully under normal conditions', async () => {
      const runWithContext = {
        ...mockWorkflowRun,
        metadata: { github_context: 'Issue #99: Fix bug' },
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([runWithContext]));

      const result = await createWorkflowRun({
        workflow_name: 'test',
        conversation_id: 'conv',
        user_message: 'test',
        metadata: { github_context: 'Issue #99: Fix bug' },
      });

      expect(result.metadata).toEqual({ github_context: 'Issue #99: Fix bug' });
    });
  });

  describe('updateWorkflowActivity', () => {
    test('updates last_activity_at timestamp', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await updateWorkflowActivity('workflow-run-123');

      expect(mockQuery).toHaveBeenCalledWith(
        'UPDATE remote_agent_workflow_runs SET last_activity_at = NOW() WHERE id = $1',
        ['workflow-run-123']
      );
    });

    test('throws on database error so callers can track failures', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

      // Should throw - callers (executor) handle failure tracking
      await expect(updateWorkflowActivity('workflow-run-123')).rejects.toThrow('Connection lost');

      // Verify the query was attempted
      expect(mockQuery).toHaveBeenCalled();
    });
  });

  describe('findResumableRun', () => {
    test('returns the most recent failed run matching workflow name and path', async () => {
      const failedRun = {
        ...mockWorkflowRun,
        status: 'failed' as const,
        working_path: '/repo/path',
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([failedRun]));

      const result = await findResumableRun('feature-development', '/repo/path');

      expect(result).toEqual(failedRun);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status IN ('failed', 'paused')");
      expect(query).toContain('working_path = $2');
      expect(query).not.toContain('conversation_id');
      expect(query).toContain('ORDER BY started_at DESC');
      expect(query).not.toMatch(/--.*\$\d/); // regression guard for #999: $N in SQL comments breaks convertPlaceholders
      expect(params).toEqual(['feature-development', '/repo/path', 1]);
    });

    test('returns a stale running run (no activity for >1 day)', async () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const staleRun = {
        ...mockWorkflowRun,
        status: 'running' as const,
        working_path: '/repo/path',
        last_activity_at: twoDaysAgo,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([staleRun]));

      const result = await findResumableRun('feature-development', '/repo/path');

      expect(result).toEqual(staleRun);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status = 'running'");
      expect(query).toContain('last_activity_at');
      expect(params).toEqual(['feature-development', '/repo/path', 1]);
    });

    test('returns a running run with null last_activity_at (never recorded activity)', async () => {
      const staleRun = {
        ...mockWorkflowRun,
        status: 'running' as const,
        working_path: '/repo/path',
        last_activity_at: null,
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([staleRun]));

      const result = await findResumableRun('feature-development', '/repo/path');

      expect(result).toEqual(staleRun);
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('last_activity_at IS NULL');
    });

    test('returns null when no resumable run exists', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await findResumableRun('feature-development', '/repo/path');

      expect(result).toBeNull();
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(findResumableRun('test', '/path')).rejects.toThrow(
        'Failed to find resumable run: Connection refused'
      );
    });
  });

  describe('getActiveWorkflowRunByPath', () => {
    test('returns active or failed run for the given working path', async () => {
      const activeRun = { ...mockWorkflowRun, working_path: '/repo/path' };
      mockQuery.mockResolvedValueOnce(createQueryResult([activeRun]));

      const result = await getActiveWorkflowRunByPath('/repo/path');

      expect(result).toEqual(activeRun);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain("status IN ('running', 'paused')");
      expect(query).toContain('working_path = $1');
      expect(params).toEqual(['/repo/path']);
    });

    test('includes pending rows within the stale-pending age window', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getActiveWorkflowRunByPath('/repo/path');

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      // Fresh `pending` counts as active so the lock is held immediately
      // after pre-create -- without this, two near-simultaneous dispatches
      // both pass the guard.
      expect(query).toContain("status = 'pending'");
      // Age window cutoff prevents orphaned pending rows (from crashed
      // dispatches) from permanently blocking a path.
      expect(query).toMatch(/started_at >.*INTERVAL.*milliseconds/);
    });

    test('excludes self and applies older-wins tiebreaker when self is provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const startedAt = new Date('2026-04-14T10:00:00Z');

      await getActiveWorkflowRunByPath('/repo/path', { id: 'self-id', startedAt });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('id != $2');
      // PostgreSQL branch: explicit `::timestamptz` cast on the param so
      // the comparison is chronological, not lexical. SQLite branch wraps
      // both sides in datetime() -- covered by tests in adapters/sqlite.test.ts
      // because this suite mocks getDatabaseType as 'postgresql'.
      expect(query).toContain('started_at < $3::timestamptz');
      expect(query).toContain('started_at = $3::timestamptz AND id < $2');
      // selfStartedAt serialized to ISO -- bun:sqlite rejects Date bindings.
      expect(params).toEqual(['/repo/path', 'self-id', startedAt.toISOString()]);
    });

    test('skips self exclusion + tiebreaker when self is omitted (no caller context)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getActiveWorkflowRunByPath('/repo/path');

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      // Without `self`, neither the id-exclusion nor the tiebreaker apply.
      expect(query).not.toContain('id !=');
      expect(query).not.toContain('started_at <');
      expect(params).toEqual(['/repo/path']);
    });

    test('orders by (started_at ASC, id ASC) so older-wins is deterministic', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await getActiveWorkflowRunByPath('/repo/path');

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('ORDER BY started_at ASC, id ASC');
    });

    test('returns null when no active run on path', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await getActiveWorkflowRunByPath('/repo/path');

      expect(result).toBeNull();
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(getActiveWorkflowRunByPath('/repo/path')).rejects.toThrow(
        'Failed to get active workflow run by path: Connection refused'
      );
    });
  });

  describe('listWorkflowRuns', () => {
    test('excludes archived runs by default', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listWorkflowRuns();

      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('archived_at IS NULL');
    });

    test('filters by single status string', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listWorkflowRuns({ status: 'running' });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status IN ($1)');
      expect(params[0]).toBe('running');
    });

    test('filters by status array with IN clause', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listWorkflowRuns({ status: ['running', 'failed'] as const });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status IN ($1, $2)');
      expect(params[0]).toBe('running');
      expect(params[1]).toBe('failed');
    });

    test('single-element array uses IN clause', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await listWorkflowRuns({ status: ['failed'] });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('status IN ($1)');
      expect(params[0]).toBe('failed');
    });

    test('returns results from query', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([mockWorkflowRun]));

      const result = await listWorkflowRuns();

      expect(result).toEqual([mockWorkflowRun]);
    });
  });

  describe('listWorkflowRunsWithWorkingPath', () => {
    test('lists only workflow runs that have a working path', async () => {
      const completedRun = {
        id: 'run-completed',
        status: 'completed',
        working_path: '/tmp/workspaces/owner/repo/worktrees/archon/thread-1',
        completed_at: new Date('2026-07-12T00:00:00Z'),
      };
      mockQuery.mockResolvedValueOnce(createQueryResult([completedRun]));

      const result = await listWorkflowRunsWithWorkingPath();

      expect(result).toEqual([completedRun]);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id, status, working_path, completed_at'),
        []
      );
      const [query] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('FROM remote_agent_workflow_runs');
      expect(query).toContain('WHERE working_path IS NOT NULL');
    });
  });

  // -------------------------------------------------------------------------
  // WO-HARNESS-TOKEN-ATTRIBUTION-01 -- Codex repair: full-window aggregation
  // -------------------------------------------------------------------------
  // The runs API's quota-window summary needs a sum across ALL runs whose
  // activity is in the window -- not just the page-of-runs. These tests pin
  // the SQL shape that makes that possible (COALESCE on activity, JSONB
  // extraction, NULL guard on the extracted total_tokens).
  describe('sumWorkflowTokensInWindow', () => {
    test('issues a SUM query bounded by the activity window and excluding archived rows', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ sum_tokens: 12345 }]));

      const since = Date.now() - 60 * 60 * 1000;
      const result = await sumWorkflowTokensInWindow({ sinceMs: since });

      expect(result).toBe(12345);
      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      // Aggregation, not row-listing.
      expect(query).toContain('SUM(');
      // Activity window uses COALESCE(last_activity_at, started_at).
      expect(query).toContain('COALESCE(last_activity_at, started_at)');
      // Archived rows are excluded.
      expect(query).toContain('archived_at IS NULL');
      // NULL guard so SUM does not coerce missing totals to 0 rows.
      expect(query).toContain('total_tokens');
      expect(query).toContain('IS NOT NULL');
      // First param is the ISO-formatted since cutoff.
      expect(typeof params[0]).toBe('string');
      expect(new Date(params[0] as string).getTime()).toBe(new Date(since).getTime());
    });

    test('returns 0 when no in-window run has tokens (COALESCE SUM)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ sum_tokens: 0 }]));

      const result = await sumWorkflowTokensInWindow({ sinceMs: Date.now() - 1000 });

      expect(result).toBe(0);
    });

    test('coerces string SUM results (pg numeric -> string) to number', async () => {
      // PostgreSQL returns SUM() over BIGINT as a string to avoid JS precision loss.
      mockQuery.mockResolvedValueOnce(createQueryResult([{ sum_tokens: '987654321' }]));

      const result = await sumWorkflowTokensInWindow({ sinceMs: Date.now() - 1000 });

      expect(result).toBe(987654321);
    });

    test('filters by codebaseId when provided', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([{ sum_tokens: 100 }]));

      await sumWorkflowTokensInWindow({ sinceMs: Date.now() - 1000, codebaseId: 'cb-1' });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('codebase_id =');
      expect(params).toContain('cb-1');
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

      await expect(sumWorkflowTokensInWindow({ sinceMs: Date.now() - 1000 })).rejects.toThrow(
        'Failed to sum workflow tokens in window: Connection lost'
      );
    });
  });

  describe('listProviderAttemptsFeed', () => {
    // A raw table row as remote_agent_provider_attempts would return it. ISO
    // string timestamps pass through normalizeTimestamp unchanged.
    const feedRow = (overrides: Record<string, unknown> = {}) => ({
      provider: 'claude',
      model: 'sonnet',
      outcome_class: 'success',
      reason_code: 'execution_completed',
      started_at: '2026-08-01T12:00:00.000Z',
      completed_at: '2026-08-01T12:01:00.000Z',
      served_model_id: 'claude-sonnet-4-5',
      ...overrides,
    });

    test('binds the default limit (200) and omits a WHERE clause when since is absent', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([feedRow()]));

      await listProviderAttemptsFeed({});

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      // No since -> no filter, LIMIT is the only bound parameter ($1).
      expect(query).not.toContain('WHERE');
      expect(query).toContain('ORDER BY started_at DESC');
      expect(query).toContain('LIMIT $1');
      expect(params).toEqual([200]);
    });

    test('filters by since with started_at >= $1 and binds [since, limit]', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([feedRow()]));

      const since = '2026-07-01T00:00:00.000Z';
      await listProviderAttemptsFeed({ since, limit: 50 });

      const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('WHERE started_at >= $1');
      expect(query).toContain('ORDER BY started_at DESC');
      expect(query).toContain('LIMIT $2');
      // since is the first bound param, clamped limit the second.
      expect(params).toEqual([since, 50]);
    });

    test('clamps an oversized limit down to the max (1000) before binding', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([feedRow()]));

      await listProviderAttemptsFeed({ limit: 999999 });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([1000]);
    });

    test('clamps a non-positive limit up to 1 before binding', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([feedRow()]));

      await listProviderAttemptsFeed({ limit: 0 });

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([1]);
    });

    test('returns rows with a NULL outcome_class instead of filtering them out', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          feedRow({ outcome_class: null, reason_code: null, completed_at: null }),
          feedRow({ outcome_class: 'success' }),
        ])
      );

      const rows = await listProviderAttemptsFeed({});

      expect(rows.length).toBe(2);
      const nullRow = rows.find(r => r.outcome_class === null);
      expect(nullRow).toBeDefined();
      expect(nullRow!.reason_code).toBeNull();
      expect(nullRow!.completed_at).toBeNull();
      // Non-null timestamp passes through unchanged.
      expect(nullRow!.started_at).toBe('2026-08-01T12:00:00.000Z');
    });
  });

  describe('failOrphanedRuns', () => {
    test('compatibility wrapper interrupts only runs with expired leases', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          {
            run_id: 'run-1',
            workflow_name: 'feature',
            working_path: 'C:/worktrees/run-1',
            owner_id: 'worker-old',
            lease_token: 'token-old',
            expires_at: '2026-07-09T19:00:00.000Z',
          },
        ])
      );
      mockTransactionQuery
        .mockResolvedValueOnce(createQueryResult([{ status: 'running' }], 1))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([{ run_id: 'run-1' }], 1))
        .mockResolvedValueOnce(createQueryResult([], 1))
        .mockResolvedValueOnce(createQueryResult([], 1));

      const result = await failOrphanedRuns();

      expect(result.count).toBe(1);
      expect(mockQuery.mock.calls[0]?.[0]).toContain('remote_agent_run_leases');
      expect(mockTransactionQuery.mock.calls[1]?.[0]).toContain("status = 'interrupted'");
    });

    test('returns count 0 when no expired leases exist', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      const result = await failOrphanedRuns();

      expect(result.count).toBe(0);
    });

    test('throws on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

      await expect(failOrphanedRuns()).rejects.toThrow(
        'Failed to reconcile orphaned workflow runs: Connection lost'
      );
    });
  });

  describe('resumeWorkflowRun', () => {
    test('updates run to running, clears completed_at, and returns updated row', async () => {
      const updatedRun = { ...mockWorkflowRun, status: 'running' as const, completed_at: null };
      // UPDATE query returns rowCount 1
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // SELECT query returns the updated row
      mockQuery.mockResolvedValueOnce(createQueryResult([updatedRun]));

      const result = await resumeWorkflowRun('workflow-run-123');

      expect(result.status).toBe('running');
      expect(result.completed_at).toBeNull();
      // First call: UPDATE
      const [updateQuery, updateParams] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(updateQuery).toContain("status = 'running'");
      expect(updateQuery).toContain('completed_at = NULL');
      expect(updateQuery).toContain(
        "status IN ('failed', 'paused', 'waiting_provider', 'interrupted')"
      );
      expect(updateParams).toEqual(['workflow-run-123']);
      // Second call: SELECT
      const [selectQuery, selectParams] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(selectQuery).toContain('SELECT *');
      expect(selectParams).toEqual(['workflow-run-123']);
    });

    test('refreshes started_at to NOW so resumed row competes fairly in the path-lock tiebreaker', async () => {
      // Without this refresh, a resumed row carries its original (potentially
      // hours-old) started_at and sorts ahead of any currently-active holder
      // in the older-wins tiebreaker -- slipping past the lock and causing
      // two active workflows on the same working_path.
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      mockQuery.mockResolvedValueOnce(
        createQueryResult([{ ...mockWorkflowRun, status: 'running' as const }])
      );

      await resumeWorkflowRun('workflow-run-123');

      const [updateQuery] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(updateQuery).toContain('started_at = NOW()');
    });

    test('throws when no row matched (run not found)', async () => {
      // UPDATE returns rowCount 0
      mockQuery.mockResolvedValueOnce(createQueryResult([], 0));

      await expect(resumeWorkflowRun('nonexistent-id')).rejects.toThrow(
        'Workflow run is not resumable (id: nonexistent-id)'
      );
    });

    test('throws on database error during UPDATE', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Lock timeout'));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to resume workflow run: Lock timeout'
      );
    });

    test('throws on database error during SELECT after UPDATE', async () => {
      // UPDATE succeeds
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // SELECT fails
      mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Failed to read workflow run after update: Connection lost'
      );
    });

    test('throws when row vanishes between UPDATE and SELECT', async () => {
      // UPDATE succeeds (rowCount 1)
      mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
      // SELECT returns nothing (row deleted between statements)
      mockQuery.mockResolvedValueOnce(createQueryResult([]));

      await expect(resumeWorkflowRun('workflow-run-123')).rejects.toThrow(
        'Workflow run vanished after update (id: workflow-run-123)'
      );
    });
  });

  describe('deleteOldWorkflowRuns', () => {
    test('executes BEGIN, two DELETEs (events then runs), and COMMIT', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockResolvedValueOnce(createQueryResult([], 0)) // events DELETE
        .mockResolvedValueOnce(createQueryResult([], 3)) // runs DELETE
        .mockResolvedValueOnce(createQueryResult([])); // COMMIT

      const result = await deleteOldWorkflowRuns(30);

      expect(result.count).toBe(3);
      expect(mockQuery).toHaveBeenCalledTimes(4);
      const [beginSql] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(beginSql).toBe('BEGIN');
      const [eventsSql] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(eventsSql).toContain('remote_agent_workflow_events');
      const [runsSql] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(runsSql).toContain("status IN ('completed', 'failed', 'escalated', 'cancelled')");
      const [commitSql] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(commitSql).toBe('COMMIT');
    });

    test('uses PostgreSQL INTERVAL syntax', async () => {
      mockQuery.mockResolvedValue(createQueryResult([], 0));

      await deleteOldWorkflowRuns(7);

      const [eventsSql] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(eventsSql).toContain("INTERVAL '7 days'");
    });

    test('validates olderThanDays is a non-negative integer', async () => {
      await expect(deleteOldWorkflowRuns(-1)).rejects.toThrow('Invalid olderThanDays');
      await expect(deleteOldWorkflowRuns(3.5)).rejects.toThrow('Invalid olderThanDays');
    });

    test('rolls back and throws on database error', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockRejectedValueOnce(new Error('disk full')); // events DELETE fails

      await expect(deleteOldWorkflowRuns(30)).rejects.toThrow(
        'Failed to clean up old workflow runs: disk full'
      );
    });
  });

  describe('deleteWorkflowRun', () => {
    test('deletes events then run within a transaction for terminal run', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        // SELECT guard: terminal AND archived (deletion requires archived_at IS NOT NULL)
        .mockResolvedValueOnce(
          createQueryResult([{ status: 'completed', archived_at: new Date('2026-06-01') }])
        )
        .mockResolvedValueOnce(createQueryResult([], 1)) // events DELETE
        .mockResolvedValueOnce(createQueryResult([], 1)) // run DELETE
        .mockResolvedValueOnce(createQueryResult([])); // COMMIT

      await deleteWorkflowRun('run-123');

      expect(mockQuery).toHaveBeenCalledTimes(5);
      const [selectSql] = mockQuery.mock.calls[1] as [string, unknown[]];
      expect(selectSql).toContain('SELECT status');
      const [eventsSql] = mockQuery.mock.calls[2] as [string, unknown[]];
      expect(eventsSql).toContain('remote_agent_workflow_events');
      const [runsSql] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(runsSql).toContain('remote_agent_workflow_runs');
    });

    test('throws when a terminal run has not been archived', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        // terminal status but archived_at is null -> archive guard fires
        .mockResolvedValueOnce(createQueryResult([{ status: 'completed', archived_at: null }]));

      await expect(deleteWorkflowRun('run-unarchived')).rejects.toThrow(
        'Archive the run first before deleting'
      );
    });

    test('force=true bypasses the archive guard', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        // terminal status, NOT archived, but force=true skips the archive guard
        .mockResolvedValueOnce(createQueryResult([{ status: 'completed', archived_at: null }]))
        .mockResolvedValueOnce(createQueryResult([], 1)) // events DELETE
        .mockResolvedValueOnce(createQueryResult([], 1)) // run DELETE
        .mockResolvedValueOnce(createQueryResult([])); // COMMIT

      await deleteWorkflowRun('run-forced', true);

      expect(mockQuery).toHaveBeenCalledTimes(5);
      const [runsSql] = mockQuery.mock.calls[3] as [string, unknown[]];
      expect(runsSql).toContain('remote_agent_workflow_runs');
    });

    test('throws "not found" when run does not exist', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockResolvedValueOnce(createQueryResult([])); // SELECT guard -- empty

      await expect(deleteWorkflowRun('missing')).rejects.toThrow('Workflow run not found: missing');
    });

    test('throws when run is not in terminal status', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockResolvedValueOnce(createQueryResult([{ status: 'running' }])); // SELECT guard

      await expect(deleteWorkflowRun('run-active')).rejects.toThrow(
        "Cannot delete workflow run in 'running' status"
      );
    });

    test('throws on database error', async () => {
      mockQuery
        .mockResolvedValueOnce(createQueryResult([])) // BEGIN
        .mockRejectedValueOnce(new Error('constraint violation'));

      await expect(deleteWorkflowRun('run-123')).rejects.toThrow(
        'Failed to delete workflow run: constraint violation'
      );
    });
  });
});

describe('Smart Cauldron reliability persistence', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
    mockTransactionQuery.mockReset();
    mockTransactionQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
    mockWithTransaction.mockClear();
    activeDatabase = defaultMockDatabase;
  });

  const authority: RunAuthorityRecord = {
    runId: '11111111-1111-4111-8111-111111111111',
    dispatchId: 'dispatch-1',
    woId: 'WO-HARNESS-TEST-01',
    specSource: 'git:docs/work-orders/test.md',
    specRevision: 'a'.repeat(40),
    specHash: 'b'.repeat(64),
    workflowName: 'test-workflow',
    codebaseId: '22222222-2222-4222-8222-222222222222',
    canonicalRemote: 'owner/repo',
    baseBranch: 'dev',
    baseSha: 'c'.repeat(40),
    runScopeSha: 'd'.repeat(40),
    headBranch: 'wo/test',
    worktreePath: '/worktrees/test',
    workflowRevision: 'e'.repeat(64),
    bundleRevision: 'bundle-1',
    engineRevision: 'f'.repeat(40),
    runtimeImageRevision: null,
    createdAt: '2026-07-09T12:00:00.000Z',
  };

  const authorityRow = {
    run_id: authority.runId,
    dispatch_id: authority.dispatchId,
    wo_id: authority.woId,
    spec_source: authority.specSource,
    spec_revision: authority.specRevision,
    spec_hash: authority.specHash,
    workflow_name: authority.workflowName,
    codebase_id: authority.codebaseId,
    canonical_remote: authority.canonicalRemote,
    base_branch: authority.baseBranch,
    base_sha: authority.baseSha,
    run_scope_sha: authority.runScopeSha,
    head_branch: authority.headBranch,
    worktree_path: authority.worktreePath,
    workflow_revision: authority.workflowRevision,
    bundle_revision: authority.bundleRevision,
    engine_revision: authority.engineRevision,
    runtime_image_revision: authority.runtimeImageRevision,
    created_at: authority.createdAt,
  };

  test('creates immutable authority and returns its normalized record', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([authorityRow], 1));

    await expect(createRunAuthority(authority)).resolves.toBe('created');
    await expect(getRunAuthority(authority.runId)).resolves.toBeNull();
    expect(mockQuery.mock.calls[0]?.[0]).toContain('ON CONFLICT DO NOTHING');
  });

  test('accepts an idempotent authority insert but rejects changed authority', async () => {
    mockQuery
      .mockResolvedValueOnce(createQueryResult([], 0))
      .mockResolvedValueOnce(
        createQueryResult([{ ...authorityRow, created_at: new Date(authority.createdAt) }], 1)
      );
    await expect(createRunAuthority(authority)).resolves.toBe('unchanged');

    mockQuery
      .mockResolvedValueOnce(createQueryResult([], 0))
      .mockResolvedValueOnce(
        createQueryResult([{ ...authorityRow, base_sha: 'changed-base-sha' }], 1)
      );
    await expect(createRunAuthority(authority)).rejects.toThrow('authority_conflict');
  });

  const lease: RunLeaseRecord = {
    runId: authority.runId,
    ownerId: 'worker-1',
    leaseToken: '33333333-3333-4333-8333-333333333333',
    acquiredAt: '2026-07-09T12:00:00.000Z',
    lastHeartbeatAt: '2026-07-09T12:00:00.000Z',
    expiresAt: '2026-07-09T12:01:00.000Z',
    releasedAt: null,
  };

  test('claims only absent, released, or expired leases and protects heartbeat/release by token', async () => {
    mockQuery.mockResolvedValueOnce(
      createQueryResult([
        {
          run_id: lease.runId,
          owner_id: lease.ownerId,
          lease_token: lease.leaseToken,
          acquired_at: lease.acquiredAt,
          last_heartbeat_at: lease.lastHeartbeatAt,
          expires_at: lease.expiresAt,
          released_at: null,
        },
      ])
    );
    await expect(claimRunLease(lease)).resolves.toEqual(lease);
    expect(mockQuery.mock.calls[0]?.[0]).toContain('expires_at <= EXCLUDED.acquired_at');

    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    await expect(
      heartbeatRunLease({
        runId: lease.runId,
        ownerId: lease.ownerId,
        leaseToken: lease.leaseToken,
        heartbeatAt: '2026-07-09T12:00:30.000Z',
        expiresAt: '2026-07-09T12:01:30.000Z',
      })
    ).resolves.toBe(true);
    expect(mockQuery.mock.calls[1]?.[0]).toContain('lease_token = $3');

    mockQuery.mockResolvedValueOnce(createQueryResult([], 0));
    await expect(
      releaseRunLease({
        runId: lease.runId,
        ownerId: lease.ownerId,
        leaseToken: 'wrong-token',
        releasedAt: '2026-07-09T12:00:40.000Z',
      })
    ).resolves.toBe(false);
  });

  test('lists only expired leases attached to running runs', async () => {
    mockQuery.mockResolvedValueOnce(
      createQueryResult([
        {
          run_id: 'run-1',
          workflow_name: 'feature',
          working_path: 'C:/worktrees/run-1',
          owner_id: 'worker-old',
          lease_token: 'token-old',
          expires_at: '2026-07-09T19:00:00.000Z',
        },
      ])
    );

    await expect(listExpiredRunLeases('2026-07-09T20:00:00.000Z')).resolves.toEqual([
      {
        runId: 'run-1',
        workflowName: 'feature',
        workingPath: 'C:/worktrees/run-1',
        ownerId: 'worker-old',
        leaseToken: 'token-old',
        expiresAt: '2026-07-09T19:00:00.000Z',
      },
    ]);
    expect(mockQuery.mock.calls[0]?.[0]).toContain("r.status = 'running'");
    expect(mockQuery.mock.calls[0]?.[0]).toContain('l.expires_at <= $1');
  });

  test('lists pending workflow runs before the boot cutoff', async () => {
    const pendingRun = {
      id: 'run-pending-1',
      workflow_name: 'feature-development',
      conversation_id: 'conv-456',
      parent_conversation_id: null,
      codebase_id: 'codebase-789',
      status: 'pending',
      user_message: 'Add dark mode support',
      metadata: {},
      started_at: new Date('2026-07-13T17:46:29.000Z'),
      completed_at: null,
      last_activity_at: new Date('2026-07-13T17:46:29.000Z'),
      working_path: null,
      archived_at: null,
      archived_by: null,
      archive_reason: null,
    };
    mockQuery.mockResolvedValueOnce(createQueryResult([pendingRun]));

    await expect(listPendingWorkflowRunsBefore('2026-07-13T17:53:00.000Z')).resolves.toEqual([
      pendingRun,
    ]);

    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("status = 'pending'");
    expect(query).toContain('started_at <= $1');
    expect(query).toContain('ORDER BY started_at ASC');
    expect(params).toEqual(['2026-07-13T17:53:00.000Z']);
  });

  test('orphans a pending workflow run with a guarded CAS update', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce(createQueryResult([{ status: 'pending' }], 1))
      .mockResolvedValueOnce(createQueryResult([], 1));

    await expect(
      orphanPendingWorkflowRun({
        runId: 'run-pending-1',
        reason: 'pending_run_predates_orchestrator_boot',
        orphanedAt: '2026-07-13T17:53:00.000Z',
      })
    ).resolves.toBe(true);

    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransactionQuery.mock.calls[0]?.[0]).toContain("status = 'pending'");
    expect(mockTransactionQuery.mock.calls[1]?.[0]).toContain("status = 'orphaned'");
    expect(mockTransactionQuery.mock.calls[1]?.[0]).toContain(
      "WHERE id = $2 AND status = 'pending'"
    );
  });

  test('lists running rows with no lease or an expired lease, excluding fresh leases', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([]));
    await listStaleRunningWorkflowRunsBefore('2026-07-13T17:53:00.000Z');
    const [query, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(query).toContain('LEFT JOIN remote_agent_run_leases');
    expect(query).toContain("r.status = 'running'");
    expect(query).toContain('l.run_id IS NULL OR l.expires_at <= $1');
    expect(params).toEqual(['2026-07-13T17:53:00.000Z']);
  });

  test('fails a stale running workflow run with a guarded CAS update', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce(createQueryResult([{ status: 'running' }], 1))
      .mockResolvedValueOnce(createQueryResult([], 1));
    await expect(
      failStaleRunningWorkflowRun({
        runId: 'run-running-1',
        reason: 'server_restart_orphaned',
        failedAt: '2026-07-13T17:53:00.000Z',
      })
    ).resolves.toBe(true);
    expect(mockTransactionQuery.mock.calls[1]?.[0]).toContain("SET status = 'failed'");
    expect(mockTransactionQuery.mock.calls[1]?.[0]).toContain(
      "WHERE id = $3 AND status = 'running'"
    );
  });

  test('orphan pending workflow CAS returns false when no pending row matches', async () => {
    mockTransactionQuery.mockResolvedValueOnce(createQueryResult([], 0));

    await expect(
      orphanPendingWorkflowRun({
        runId: 'run-pending-1',
        reason: 'pending_run_predates_orchestrator_boot',
        orphanedAt: '2026-07-13T17:53:00.000Z',
      })
    ).resolves.toBe(false);

    expect(mockTransactionQuery).toHaveBeenCalledTimes(1);
  });

  test('interrupts an expired lease exactly once and persists recovery evidence', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce(createQueryResult([{ status: 'running' }], 1))
      .mockResolvedValueOnce(createQueryResult([], 1))
      .mockResolvedValueOnce(createQueryResult([{ run_id: 'run-1' }], 1))
      .mockResolvedValueOnce(createQueryResult([], 1))
      .mockResolvedValueOnce(createQueryResult([], 1));

    await expect(
      interruptExpiredRunLease({
        runId: 'run-1',
        leaseToken: 'token-old',
        expiredAt: '2026-07-09T20:00:00.000Z',
        interruptedAt: '2026-07-09T20:00:01.000Z',
      })
    ).resolves.toBe(true);

    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockTransactionQuery.mock.calls[0]?.[0]).toContain('l.lease_token = $2');
    expect(mockTransactionQuery.mock.calls[0]?.[0]).toContain('l.expires_at <= $3');
    expect(mockTransactionQuery.mock.calls[1]?.[0]).toContain("status = 'interrupted'");
    expect(mockTransactionQuery.mock.calls[2]?.[0]).toContain('remote_agent_run_outcomes');
    expect(mockTransactionQuery.mock.calls[3]?.[0]).toContain('workflow_interrupted');
    expect(mockTransactionQuery.mock.calls[4]?.[0]).toContain('released_at = $3');
  });

  const attempt: ProviderAttemptRecord = {
    attemptId: '44444444-4444-4444-8444-444444444444',
    runId: authority.runId,
    nodeId: 'implement',
    attemptNumber: 1,
    provider: 'claude',
    model: 'opus',
    declaredProvider: 'claude',
    declaredModel: 'opus',
    requiredCapabilities: ['repo_read', 'repo_write', 'shell'],
    startedAt: '2026-07-09T12:00:00.000Z',
    completedAt: null,
    servedModelId: null,
    outcomeClass: null,
    reasonCode: null,
    resumeAt: null,
    supersedesAttemptId: null,
  };

  test('persists attempts before calls and completes each attempt once', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([{ attempt_id: attempt.attemptId }], 1));
    await expect(createProviderAttempt(attempt)).resolves.toBe(true);
    expect(mockQuery.mock.calls[0]?.[1]).toContain(JSON.stringify(attempt.requiredCapabilities));

    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    await expect(
      completeProviderAttempt({
        attemptId: attempt.attemptId,
        completedAt: '2026-07-09T12:00:10.000Z',
        servedModelId: 'claude-opus-4-7',
        outcomeClass: 'quota',
        reasonCode: 'provider_quota_wait',
        resumeAt: '2026-07-09T17:00:00.000Z',
      })
    ).resolves.toBe(true);
    expect(mockQuery.mock.calls[1]?.[0]).toContain('completed_at IS NULL');
  });

  test('normalizes attempt JSON arrays', async () => {
    mockQuery.mockResolvedValueOnce(
      createQueryResult([
        {
          attempt_id: attempt.attemptId,
          run_id: attempt.runId,
          node_id: attempt.nodeId,
          attempt_number: attempt.attemptNumber,
          provider: attempt.provider,
          model: attempt.model,
          declared_provider: attempt.declaredProvider,
          declared_model: attempt.declaredModel,
          required_capabilities: JSON.stringify(attempt.requiredCapabilities),
          started_at: attempt.startedAt,
          completed_at: null,
          served_model_id: null,
          outcome_class: null,
          reason_code: null,
          resume_at: null,
          supersedes_attempt_id: null,
        },
      ])
    );
    await expect(listProviderAttempts(attempt.runId, attempt.nodeId)).resolves.toEqual([attempt]);
  });

  const outcome: RunOutcome = {
    executionState: 'waiting_provider',
    deliverableState: 'worktree_changes',
    validationState: 'not_run',
    recoveryState: 'recoverable',
    routeState: 'exhausted',
    primaryReason: 'provider_quota_wait',
    reasonCodes: ['provider_quota_wait'],
    evidenceRefs: ['attempt:' + attempt.attemptId],
  };

  test('upserts and reads multidimensional outcomes without changing legacy run rows', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([{ run_id: authority.runId }], 1));
    await expect(
      upsertRunOutcome(authority.runId, outcome, '2026-07-09T12:00:10.000Z')
    ).resolves.toBe(true);
    expect(mockQuery.mock.calls[0]?.[0]).toContain('remote_agent_run_outcomes');
    expect(mockQuery.mock.calls[0]?.[0]).not.toContain('remote_agent_workflow_runs');
    expect(mockQuery.mock.calls[0]?.[0]).toContain(
      'remote_agent_run_outcomes.updated_at <= EXCLUDED.updated_at'
    );

    mockQuery.mockResolvedValueOnce(
      createQueryResult([
        {
          run_id: authority.runId,
          execution_state: outcome.executionState,
          deliverable_state: outcome.deliverableState,
          validation_state: outcome.validationState,
          recovery_state: outcome.recoveryState,
          route_state: outcome.routeState,
          primary_reason: outcome.primaryReason,
          reason_codes: JSON.stringify(outcome.reasonCodes),
          evidence_refs: JSON.stringify(outcome.evidenceRefs),
          updated_at: '2026-07-09T12:00:10.000Z',
        },
      ])
    );
    await expect(getRunOutcome(authority.runId)).resolves.toEqual(outcome);
  });

  const wait: ScheduledProviderWaitRecord = {
    waitId: '55555555-5555-4555-8555-555555555555',
    runId: authority.runId,
    attemptId: attempt.attemptId,
    provider: 'claude',
    reasonCode: 'provider_quota_wait',
    resumeAt: '2026-07-09T17:00:00.000Z',
    state: 'scheduled',
    claimOwnerId: null,
    claimToken: null,
    createdAt: '2026-07-09T12:00:10.000Z',
    claimedAt: null,
    cancelledAt: null,
    completedAt: null,
  };

  test('schedules, atomically claims, cancels, and completes durable waits', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([{ wait_id: wait.waitId }], 1));
    await expect(scheduleProviderWait(wait)).resolves.toBe(true);

    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    await expect(
      claimProviderWait({
        waitId: wait.waitId,
        ownerId: 'scheduler-1',
        claimToken: '66666666-6666-4666-8666-666666666666',
        claimedAt: wait.resumeAt,
      })
    ).resolves.toBe(true);
    expect(mockQuery.mock.calls[1]?.[0]).toContain("state = 'scheduled'");
    expect(mockQuery.mock.calls[1]?.[0]).toContain('resume_at <= $4');
    expect(mockQuery.mock.calls[1]?.[0]).toContain("r.status = 'waiting_provider'");

    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    await expect(
      releaseProviderWaitClaim({
        waitId: wait.waitId,
        claimToken: '66666666-6666-4666-8666-666666666666',
        resumeAt: '2026-07-09T17:00:30.000Z',
      })
    ).resolves.toBe(true);
    expect(mockQuery.mock.calls[2]?.[0]).toContain("state = 'scheduled'");
    expect(mockQuery.mock.calls[2]?.[0]).toContain('claim_token = NULL');

    mockQuery.mockResolvedValueOnce(createQueryResult([], 2));
    await expect(cancelProviderWaits(wait.runId, wait.resumeAt)).resolves.toBe(2);

    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    await expect(
      completeProviderWait({
        waitId: wait.waitId,
        claimToken: '66666666-6666-4666-8666-666666666666',
        completedAt: '2026-07-09T17:00:01.000Z',
      })
    ).resolves.toBe(true);
  });

  test('lists due waits in resume order with a bounded limit', async () => {
    mockQuery.mockResolvedValueOnce(
      createQueryResult([
        {
          wait_id: wait.waitId,
          run_id: wait.runId,
          attempt_id: wait.attemptId,
          provider: wait.provider,
          reason_code: wait.reasonCode,
          resume_at: wait.resumeAt,
          state: wait.state,
          claim_owner_id: null,
          claim_token: null,
          created_at: wait.createdAt,
          claimed_at: null,
          cancelled_at: null,
          completed_at: null,
        },
      ])
    );
    await expect(listDueProviderWaits(wait.resumeAt, 25)).resolves.toEqual([wait]);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('ORDER BY resume_at ASC'), [
      wait.resumeAt,
      25,
    ]);
  });

  test('uses the database clock for every supervisor lease validity predicate', async () => {
    const leaseRow = {
      incident_id: '99999999-9999-4999-8999-999999999999',
      owner_id: 'sol',
      fencing_token: 1,
      acquired_at: '2026-07-10T12:00:00.000Z',
      last_heartbeat_at: '2026-07-10T12:00:00.000Z',
      expires_at: '2026-07-10T12:01:00.000Z',
      released_at: null,
    };
    mockQuery.mockResolvedValueOnce(createQueryResult([leaseRow], 1));
    await claimSupervisorRepairLease({
      incidentId: leaseRow.incident_id,
      ownerId: leaseRow.owner_id,
      leaseDurationMs: 60_000,
    });
    expect(mockQuery.mock.calls[0]?.[0]).toContain('NOW()');
    expect(mockQuery.mock.calls[0]?.[0]).not.toContain('expires_at <= EXCLUDED.acquired_at');
    expect(mockQuery.mock.calls[0]?.[1]).toEqual([leaseRow.incident_id, leaseRow.owner_id, 60_000]);

    mockQuery.mockResolvedValueOnce(createQueryResult([], 1));
    await heartbeatSupervisorRepairLease({
      incidentId: leaseRow.incident_id,
      ownerId: leaseRow.owner_id,
      fencingToken: 1,
      leaseDurationMs: 60_000,
    });
    expect(mockQuery.mock.calls[1]?.[0]).toContain('expires_at > NOW()');

    mockQuery.mockResolvedValueOnce(createQueryResult([{ incident_id: leaseRow.incident_id }], 1));
    await authorizeSupervisorMutation({
      incidentId: leaseRow.incident_id,
      ownerId: leaseRow.owner_id,
      fencingToken: 1,
    });
    expect(mockQuery.mock.calls[2]?.[0]).toContain('expires_at > NOW()');
    expect(mockQuery.mock.calls[2]?.[1]).toEqual([leaseRow.incident_id, leaseRow.owner_id, 1]);
  });

  test('executes the reliability contract end-to-end on SQLite', async () => {
    const dbPath = join(
      import.meta.dir,
      `.test-reliability-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    const sqlite = new SqliteAdapter(dbPath);
    activeDatabase = sqlite;
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => sqlite.query(sql, params));

    try {
      await sqlite.query(
        `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
        [authority.codebaseId, 'test-codebase', '/tmp/test']
      );
      await sqlite.query(
        `INSERT INTO remote_agent_conversations
         (id, platform_type, platform_conversation_id, codebase_id)
         VALUES ($1, $2, $3, $4)`,
        ['77777777-7777-4777-8777-777777777777', 'test', 'conversation-1', authority.codebaseId]
      );
      await sqlite.query(
        `INSERT INTO remote_agent_workflow_runs
         (id, conversation_id, codebase_id, workflow_name, user_message, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          authority.runId,
          '77777777-7777-4777-8777-777777777777',
          authority.codebaseId,
          authority.workflowName,
          'test',
          'running',
        ]
      );

      await expect(createRunAuthority(authority)).resolves.toBe('created');
      await expect(createRunAuthority(authority)).resolves.toBe('unchanged');
      await expect(getRunAuthority(authority.runId)).resolves.toEqual(authority);

      const duplicateDispatchRunId = '88888888-8888-4888-8888-888888888888';
      await sqlite.query(
        `INSERT INTO remote_agent_workflow_runs
         (id, conversation_id, codebase_id, workflow_name, user_message, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          duplicateDispatchRunId,
          '77777777-7777-4777-8777-777777777777',
          authority.codebaseId,
          authority.workflowName,
          'duplicate dispatch test',
          'running',
        ]
      );
      await expect(
        createRunAuthority({ ...authority, runId: duplicateDispatchRunId })
      ).rejects.toThrow('dispatch_conflict');
      await expect(getRunAuthority(authority.runId)).resolves.toEqual(authority);
      await expect(getRunAuthority(duplicateDispatchRunId)).resolves.toBeNull();

      await expect(claimRunLease(lease)).resolves.toEqual(lease);
      await expect(
        claimRunLease({ ...lease, ownerId: 'worker-2', leaseToken: crypto.randomUUID() })
      ).resolves.toBeNull();
      await expect(
        heartbeatRunLease({
          runId: lease.runId,
          ownerId: lease.ownerId,
          leaseToken: lease.leaseToken,
          heartbeatAt: '2026-07-09T12:00:30.000Z',
          expiresAt: '2026-07-09T12:01:30.000Z',
        })
      ).resolves.toBe(true);

      await expect(createProviderAttempt(attempt)).resolves.toBe(true);
      await expect(createProviderAttempt(attempt)).resolves.toBe(false);
      await expect(listProviderAttempts(attempt.runId, attempt.nodeId)).resolves.toEqual([attempt]);

      await expect(
        upsertRunOutcome(authority.runId, outcome, '2026-07-09T12:00:10.000Z')
      ).resolves.toBe(true);
      await expect(getRunOutcome(authority.runId)).resolves.toEqual(outcome);
      await expect(
        upsertRunOutcome(
          authority.runId,
          {
            ...outcome,
            executionState: 'failed',
            primaryReason: 'execution_failed',
            reasonCodes: ['execution_failed'],
          },
          '2026-07-09T12:00:09.000Z'
        )
      ).resolves.toBe(false);
      await expect(getRunOutcome(authority.runId)).resolves.toEqual(outcome);

      await updateWorkflowRun(wait.runId, { status: 'waiting_provider' });
      await expect(scheduleProviderWait(wait)).resolves.toBe(true);
      await expect(listDueProviderWaits('2026-07-09T16:59:59.000Z', 10)).resolves.toEqual([]);
      await expect(listDueProviderWaits(wait.resumeAt, 10)).resolves.toEqual([wait]);
      await expect(
        claimProviderWait({
          waitId: wait.waitId,
          ownerId: 'scheduler-1',
          claimToken: '66666666-6666-4666-8666-666666666666',
          claimedAt: wait.resumeAt,
        })
      ).resolves.toBe(true);
      await expect(cancelProviderWaits(wait.runId, wait.resumeAt)).resolves.toBe(1);
      await expect(
        completeProviderWait({
          waitId: wait.waitId,
          claimToken: '66666666-6666-4666-8666-666666666666',
          completedAt: '2026-07-09T17:00:01.000Z',
        })
      ).resolves.toBe(false);
      await updateWorkflowRun(wait.runId, { status: 'running' });
      const expiredAt = '2026-07-09T17:00:01.000Z';
      await expect(listExpiredRunLeases(expiredAt)).resolves.toHaveLength(1);
      await expect(
        interruptExpiredRunLease({
          runId: lease.runId,
          leaseToken: lease.leaseToken,
          expiredAt,
          interruptedAt: expiredAt,
        })
      ).resolves.toBe(true);
      await expect(
        interruptExpiredRunLease({
          runId: lease.runId,
          leaseToken: lease.leaseToken,
          expiredAt,
          interruptedAt: expiredAt,
        })
      ).resolves.toBe(false);
      await expect(getWorkflowRunStatus(lease.runId)).resolves.toBe('interrupted');
      await expect(getRunOutcome(lease.runId)).resolves.toMatchObject({
        executionState: 'interrupted',
        recoveryState: 'recoverable',
        primaryReason: 'worker_lease_expired',
      });

      const recoveryLease: RunLeaseRecord = {
        ...lease,
        ownerId: 'worker-2',
        leaseToken: '88888888-8888-4888-8888-888888888888',
        acquiredAt: '2026-07-09T17:00:02.000Z',
        lastHeartbeatAt: '2026-07-09T17:00:02.000Z',
        expiresAt: '2026-07-09T17:01:02.000Z',
      };
      await expect(claimRunLease(recoveryLease)).resolves.toEqual(recoveryLease);
      await expect(resumeWorkflowRun(lease.runId)).resolves.toMatchObject({ status: 'running' });
      await expect(
        releaseRunLease({
          runId: recoveryLease.runId,
          ownerId: recoveryLease.ownerId,
          leaseToken: recoveryLease.leaseToken,
          releasedAt: '2026-07-09T17:00:03.000Z',
        })
      ).resolves.toBe(true);

      const terminal: TerminalWorkflowPersistence = {
        outcome: {
          executionState: 'completed',
          deliverableState: 'worktree_changes',
          validationState: 'not_run',
          recoveryState: 'not_needed',
          routeState: 'current',
          primaryReason: 'execution_completed',
          reasonCodes: ['execution_completed'],
          evidenceRefs: [`run:${authority.runId}`],
        },
        updatedAt: '2026-07-09T18:00:00.000Z',
        eventData: { duration_ms: 100, terminal_cause: 'test' },
      };
      const terminalMetadata = {
        node_counts: { completed: 1, failed: 0, skipped: 0, total: 1 },
      };
      await completeWorkflowRun(authority.runId, terminalMetadata, terminal);
      await completeWorkflowRun(authority.runId, terminalMetadata, terminal);

      const finalizedRun = await sqlite.query<{ status: string }>(
        'SELECT status FROM remote_agent_workflow_runs WHERE id = $1',
        [authority.runId]
      );
      expect(finalizedRun.rows[0]?.status).toBe('completed');
      const terminalEvents = await sqlite.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM remote_agent_workflow_events
         WHERE workflow_run_id = $1 AND event_type = 'workflow_completed'`,
        [authority.runId]
      );
      expect(terminalEvents.rows[0]?.count).toBe(1);
    } finally {
      await sqlite.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(dbPath + suffix);
        } catch {
          // File may not exist depending on SQLite checkpoint timing.
        }
      }
    }
  });

  test('treats SQLite reservation lock contention as a lost race', async () => {
    const busy = Object.assign(new Error('database is locked'), {
      code: 'SQLITE_BUSY_SNAPSHOT',
    });
    activeDatabase = {
      dialect: 'sqlite',
      sql: mockPostgresDialect,
      withTransaction: mock(async () => {
        throw busy;
      }),
    };

    await expect(
      reserveSupervisorAction({
        actionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        incidentId: '99999999-9999-4999-8999-999999999999',
        ownerId: 'sol',
        fencingToken: 1,
        actionType: 'repair_or_refire',
        outcome: 'reserved',
        evidenceRefs: [],
        createdAt: '2026-07-10T12:01:05.000Z',
      })
    ).resolves.toBe(false);
  });

  test('does not hide unrelated SQLite reservation integrity failures', async () => {
    const foreignKey = Object.assign(new Error('foreign key constraint failed'), {
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });
    activeDatabase = {
      dialect: 'sqlite',
      sql: mockPostgresDialect,
      withTransaction: mock(async () => {
        throw foreignKey;
      }),
    };

    await expect(
      reserveSupervisorAction({
        actionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        incidentId: '99999999-9999-4999-8999-999999999999',
        ownerId: 'sol',
        fencingToken: 1,
        actionType: 'repair_or_refire',
        outcome: 'reserved',
        evidenceRefs: [],
        createdAt: '2026-07-10T12:01:05.000Z',
      })
    ).rejects.toBe(foreignKey);
  });

  test('coordinates simultaneous supervisors with fenced expiry takeover on SQLite', async () => {
    const dbPath = join(
      import.meta.dir,
      `.test-supervisors-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    const sqlite = new SqliteAdapter(dbPath);
    activeDatabase = sqlite;
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => sqlite.query(sql, params));
    const incident: SupervisorIncidentRecord = {
      incidentId: '99999999-9999-4999-8999-999999999999',
      incidentKey: 'run-supervisor:terminal-failure',
      runId: authority.runId,
      woId: authority.woId,
      status: 'open',
      createdAt: '2026-07-10T12:00:00.000Z',
      updatedAt: '2026-07-10T12:00:00.000Z',
    };
    try {
      await sqlite.query(
        `INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)`,
        [authority.codebaseId, 'supervisor-test', '/tmp/supervisor-test']
      );
      await sqlite.query(
        `INSERT INTO remote_agent_conversations
         (id, platform_type, platform_conversation_id, codebase_id)
         VALUES ($1, $2, $3, $4)`,
        ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'test', 'supervisor-test', authority.codebaseId]
      );
      await sqlite.query(
        `INSERT INTO remote_agent_workflow_runs
         (id, conversation_id, codebase_id, workflow_name, user_message, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          authority.runId,
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          authority.codebaseId,
          authority.workflowName,
          'supervisor test',
          'failed',
        ]
      );
      await expect(createSupervisorIncident(incident)).resolves.toEqual(incident);
      await Promise.all([
        appendSupervisorObservation({
          observationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          incidentId: incident.incidentId,
          supervisorId: 'sol',
          assessment: 'repairable',
          evidenceRefs: ['event:1'],
          createdAt: '2026-07-10T12:00:01.000Z',
        }),
        appendSupervisorObservation({
          observationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          incidentId: incident.incidentId,
          supervisorId: 'fable',
          assessment: 'repairable',
          evidenceRefs: ['event:2'],
          createdAt: '2026-07-10T12:00:01.000Z',
        }),
      ]);
      await expect(listSupervisorObservations(incident.incidentId)).resolves.toHaveLength(2);

      const claims = await Promise.all([
        claimSupervisorRepairLease({
          incidentId: incident.incidentId,
          ownerId: 'sol',
          leaseDurationMs: 60_000,
        }),
        claimSupervisorRepairLease({
          incidentId: incident.incidentId,
          ownerId: 'fable',
          leaseDurationMs: 60_000,
        }),
      ]);
      const firstOwner = claims.find(claim => claim !== null);
      expect(claims.filter(claim => claim !== null)).toHaveLength(1);
      expect(firstOwner?.fencingToken).toBe(1);

      const takeoverOwner = firstOwner?.ownerId === 'sol' ? 'fable' : 'sol';
      await sqlite.query(
        `UPDATE remote_agent_supervisor_repair_leases
         SET expires_at = '2000-01-01T00:00:00.000Z'
         WHERE incident_id = $1`,
        [incident.incidentId]
      );
      const takeover = await claimSupervisorRepairLease({
        incidentId: incident.incidentId,
        ownerId: takeoverOwner,
        leaseDurationMs: 60_000,
      });
      expect(takeover?.fencingToken).toBe(2);
      await expect(
        authorizeSupervisorMutation({
          incidentId: incident.incidentId,
          ownerId: firstOwner?.ownerId ?? '',
          fencingToken: firstOwner?.fencingToken ?? 0,
        })
      ).resolves.toBe(false);
      await expect(
        authorizeSupervisorMutation({
          incidentId: incident.incidentId,
          ownerId: takeoverOwner,
          fencingToken: 2,
        })
      ).resolves.toBe(true);
      await expect(
        reserveSupervisorAction({
          actionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          incidentId: incident.incidentId,
          ownerId: takeoverOwner,
          fencingToken: 2,
          actionType: 'repair_or_refire',
          outcome: 'reserved',
          evidenceRefs: [],
          createdAt: '2026-07-10T12:01:05.000Z',
        })
      ).resolves.toBe(true);
      await expect(
        reserveSupervisorAction({
          actionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          incidentId: incident.incidentId,
          ownerId: takeoverOwner,
          fencingToken: 2,
          actionType: 'repair_or_refire',
          outcome: 'reserved',
          evidenceRefs: [],
          createdAt: '2026-07-10T12:01:05.000Z',
        })
      ).resolves.toBe(false);
      await sqlite.query(
        `UPDATE remote_agent_supervisor_repair_leases
         SET expires_at = '2000-01-01T00:00:00.000Z'
         WHERE incident_id = $1`,
        [incident.incidentId]
      );
      await expect(
        finalizeSupervisorAction({
          actionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          incidentId: incident.incidentId,
          ownerId: takeoverOwner,
          fencingToken: 2,
          status: 'completed',
          outcome: 'must-not-close-after-expiry',
          evidenceRefs: [],
          completedAt: '2026-07-10T12:01:05.000Z',
        })
      ).resolves.toBe(false);
      await sqlite.query(
        `UPDATE remote_agent_supervisor_repair_leases
         SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')
         WHERE incident_id = $1`,
        [incident.incidentId]
      );
      await expect(
        finalizeSupervisorAction({
          actionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          incidentId: incident.incidentId,
          ownerId: takeoverOwner,
          fencingToken: 2,
          status: 'completed',
          outcome: 'recovered',
          evidenceRefs: ['run:recovered'],
          completedAt: '2026-07-10T12:01:05.000Z',
        })
      ).resolves.toBe(true);
      await expect(
        releaseSupervisorRepairLease({
          incidentId: incident.incidentId,
          ownerId: takeoverOwner,
          fencingToken: 2,
          releasedAt: '2026-07-10T12:01:06.000Z',
        })
      ).resolves.toBe(true);
      await expect(
        claimSupervisorRepairLease({
          incidentId: incident.incidentId,
          ownerId: firstOwner?.ownerId ?? 'sol',
          leaseDurationMs: 60_000,
        })
      ).resolves.toBeNull();
    } finally {
      await sqlite.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(dbPath + suffix);
        } catch {
          // File may not exist depending on SQLite checkpoint timing.
        }
      }
    }
  });

  test('reconciles durable terminal evidence and reports contradictions without guessing', async () => {
    mockTransactionQuery.mockResolvedValueOnce(
      createQueryResult([
        {
          id: 'run-outcome',
          status: 'running',
          execution_state: 'completed',
          route_state: 'current',
          terminal_event: null,
        },
        {
          id: 'run-event',
          status: 'running',
          execution_state: null,
          route_state: null,
          terminal_event: 'workflow_failed',
        },
        {
          id: 'run-conflict',
          status: 'running',
          execution_state: 'completed',
          route_state: 'current',
          terminal_event: 'workflow_failed',
        },
      ])
    );
    mockTransactionQuery.mockImplementation(() => Promise.resolve(createQueryResult([], 1)));

    await expect(reconcileTerminalWorkflowRuns('2026-07-09T19:00:00.000Z')).resolves.toEqual({
      scanned: 3,
      repaired: 2,
      conflicts: 1,
    });

    const updates = mockTransactionQuery.mock.calls.filter(call =>
      (call[0] as string).includes('UPDATE remote_agent_workflow_runs')
    );
    expect(updates).toHaveLength(2);
    expect(updates.map(call => (call[1] as unknown[])[0]).sort()).toEqual(['completed', 'failed']);
  });
});

describe('Cauldron drain mode', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
    mockTransactionQuery.mockReset();
    mockTransactionQuery.mockImplementation(() => Promise.resolve(createQueryResult([])));
    mockWithTransaction.mockClear();
    activeDatabase = defaultMockDatabase;
  });

  test('reports durable mode, active leases and runs, and conservative drained state', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce(createQueryResult([{ mode: 'draining', updated_at: 'now' }]))
      .mockResolvedValueOnce(createQueryResult([{ active_lease_count: 0 }]))
      .mockResolvedValueOnce(createQueryResult([{ active_run_count: 1 }]))
      .mockResolvedValueOnce(createQueryResult([{ id: 'run-legacy' }]));

    await expect(getCauldronDrainState('2026-07-09T20:00:00.000Z')).resolves.toEqual({
      mode: 'draining',
      activeLeaseCount: 0,
      activeRunCount: 1,
      activeRunIds: ['run-legacy'],
      drained: false,
      updatedAt: 'now',
    });
  });

  test('changes drain mode and appends audit evidence atomically', async () => {
    mockTransactionQuery
      .mockResolvedValueOnce(createQueryResult([{ mode: 'normal' }], 1))
      .mockResolvedValueOnce(createQueryResult([], 1))
      .mockResolvedValueOnce(createQueryResult([], 1));

    await expect(
      setCauldronDrainMode({
        mode: 'draining',
        actor: 'operator',
        reason: 'maintenance',
        updatedAt: '2026-07-09T20:00:00.000Z',
      })
    ).resolves.toEqual({ changed: true, mode: 'draining' });
    expect(mockTransactionQuery.mock.calls[1]?.[0]).toContain('remote_agent_cauldron_control');
    expect(mockTransactionQuery.mock.calls[2]?.[0]).toContain(
      'remote_agent_cauldron_control_events'
    );
  });

  test('setting the current drain mode is idempotent and emits no duplicate audit row', async () => {
    mockTransactionQuery.mockResolvedValueOnce(createQueryResult([{ mode: 'draining' }], 1));

    await expect(
      setCauldronDrainMode({
        mode: 'draining',
        actor: 'operator',
        reason: null,
        updatedAt: '2026-07-09T20:00:00.000Z',
      })
    ).resolves.toEqual({ changed: false, mode: 'draining' });
    expect(mockTransactionQuery).toHaveBeenCalledTimes(1);
  });

  test('persists idempotent drain transitions and audit evidence on SQLite', async () => {
    const dbPath = join(
      import.meta.dir,
      `.test-drain-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    const sqlite = new SqliteAdapter(dbPath);
    activeDatabase = sqlite;
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => sqlite.query(sql, params));
    try {
      await expect(getCauldronDrainState()).resolves.toMatchObject({
        mode: 'normal',
        drained: false,
      });
      const change = {
        mode: 'draining' as const,
        actor: 'operator',
        reason: 'maintenance',
        updatedAt: '2026-07-09T20:00:00.000Z',
      };
      await expect(setCauldronDrainMode(change)).resolves.toEqual({
        changed: true,
        mode: 'draining',
      });
      const codebaseId = '99999999-9999-4999-8999-999999999999';
      const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      await sqlite.query(
        'INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)',
        [codebaseId, 'drain-test', '/tmp/drain-test']
      );
      await sqlite.query(
        `INSERT INTO remote_agent_conversations
         (id, platform_type, platform_conversation_id, codebase_id)
         VALUES ($1, 'test', 'drain-conversation', $2)`,
        [conversationId, codebaseId]
      );
      await sqlite.query(
        `INSERT INTO remote_agent_workflow_runs
         (id, conversation_id, codebase_id, workflow_name, user_message, status)
         VALUES ($1, $2, $3, 'feature', 'test', 'running')`,
        [runId, conversationId, codebaseId]
      );
      await sqlite.query(
        `INSERT INTO remote_agent_run_leases
         (run_id, owner_id, lease_token, acquired_at, last_heartbeat_at, expires_at)
         VALUES ($1, 'worker', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                 '2026-07-09T20:00:00.000Z', '2026-07-09T20:00:00.000Z',
                 '2999-07-09T20:00:00.000Z')`,
        [runId]
      );
      await expect(getCauldronDrainState()).resolves.toMatchObject({
        mode: 'draining',
        activeLeaseCount: 1,
        activeRunCount: 1,
        activeRunIds: [runId],
        drained: false,
      });
      await expect(setCauldronDrainMode(change)).resolves.toEqual({
        changed: false,
        mode: 'draining',
      });
      await sqlite.query(
        "UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = $1",
        [runId]
      );
      await sqlite.query('UPDATE remote_agent_run_leases SET released_at = $2 WHERE run_id = $1', [
        runId,
        '2026-07-09T20:01:00.000Z',
      ]);
      await expect(getCauldronDrainState()).resolves.toMatchObject({
        mode: 'draining',
        activeLeaseCount: 0,
        activeRunCount: 0,
        drained: true,
      });
      const audit = await sqlite.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM remote_agent_cauldron_control_events'
      );
      expect(audit.rows[0]?.count).toBe(1);
    } finally {
      await sqlite.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(dbPath + suffix);
        } catch {
          // File may not exist depending on SQLite checkpoint timing.
        }
      }
    }
  });
});
