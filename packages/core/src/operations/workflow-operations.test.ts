import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock DB modules before importing the module under test
// ---------------------------------------------------------------------------

const mockGetWorkflowRun = mock(() => Promise.resolve(null));
const mockListWorkflowRuns = mock(() => Promise.resolve([]));
const mockUpdateWorkflowRun = mock(() => Promise.resolve());
const mockCancelWorkflowRun = mock(() => Promise.resolve());

mock.module('../db/workflows', () => ({
  getWorkflowRun: mockGetWorkflowRun,
  listWorkflowRuns: mockListWorkflowRuns,
  updateWorkflowRun: mockUpdateWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
}));

const mockCreateWorkflowEvent = mock(() => Promise.resolve());

mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Import AFTER mocks
const { approveWorkflow, rejectWorkflow, getWorkflowStatus, resumeWorkflow, abandonWorkflow } =
  await import('./workflow-operations');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePausedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: 'cb-1',
    status: 'paused',
    user_message: 'test',
    metadata: {
      approval: {
        nodeId: 'review',
        message: 'Please review',
        type: 'approval',
      },
    },
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/workspace/worktree',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('approveWorkflow', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockClear();
    mockCreateWorkflowEvent.mockClear();
    mockUpdateWorkflowRun.mockClear();
  });

  test('approves standard approval gate -- writes node_completed + approval_received', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await approveWorkflow('run-1', 'Looks good');

    expect(result.type).toBe('approval_gate');
    expect(result.workflowName).toBe('test-workflow');
    expect(result.workingPath).toBe('/workspace/worktree');

    // node_completed + approval_received = 2 events
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(2);
    const firstCall = mockCreateWorkflowEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(firstCall.event_type).toBe('node_completed');
    const secondCall = mockCreateWorkflowEvent.mock.calls[1][0] as Record<string, unknown>;
    expect(secondCall.event_type).toBe('approval_received');

    // Transitions to failed + clears rejection state
    expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      metadata: { approval_response: 'approved', rejection_reason: '', rejection_count: 0 },
    });
  });

  test('approves interactive_loop -- writes only approval_received, stores loop_user_input', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 2,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await approveWorkflow('run-1', 'fix the tests');

    expect(result.type).toBe('interactive_loop');

    // Only approval_received -- NOT node_completed
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(1);
    const call = mockCreateWorkflowEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(call.event_type).toBe('approval_received');

    // Stores loop_user_input in metadata
    expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      metadata: { loop_user_input: 'fix the tests' },
    });
  });

  test('approves with captureResponse -- stores comment as node output', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          type: 'approval',
          captureResponse: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', 'My review notes');

    const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls[0][0] as Record<string, unknown>;
    expect((nodeCompletedCall.data as Record<string, unknown>).node_output).toBe('My review notes');
  });

  test('throws on non-paused run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));

    await expect(approveWorkflow('run-1')).rejects.toThrow(
      "Cannot approve run with status 'running'"
    );
  });

  test('throws on missing approval context', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ metadata: {} }));

    await expect(approveWorkflow('run-1')).rejects.toThrow('missing approval context');
  });

  test('throws on run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);

    await expect(approveWorkflow('run-1')).rejects.toThrow('Workflow run not found: run-1');
  });
});

describe('rejectWorkflow', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockClear();
    mockCreateWorkflowEvent.mockClear();
    mockUpdateWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockClear();
  });

  test('rejects with onRejectPrompt under max attempts -- transitions to failed', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'needs more tests');

    expect(result.cancelled).toBe(false);
    expect(result.workflowName).toBe('test-workflow');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      metadata: { rejection_reason: 'needs more tests', rejection_count: 1 },
    });
  });

  test('rejects at max attempts -- cancels run', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 2,
        },
        rejection_count: 1,
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'still broken');

    expect(result.cancelled).toBe(true);
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  test('rejects without onRejectPrompt -- cancels immediately', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await rejectWorkflow('run-1', 'no good');

    expect(result.cancelled).toBe(true);
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  test('throws on non-paused run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(rejectWorkflow('run-1')).rejects.toThrow(
      "Cannot reject run with status 'completed'"
    );
  });
});

describe('getWorkflowStatus', () => {
  beforeEach(() => {
    mockListWorkflowRuns.mockClear();
  });

  test('returns running and paused runs', async () => {
    const runs = [
      makePausedRun({ status: 'running' }),
      makePausedRun({ id: 'run-2', status: 'paused' }),
    ];
    mockListWorkflowRuns.mockResolvedValueOnce(runs);

    const result = await getWorkflowStatus();

    expect(result.runs).toHaveLength(2);
    expect(mockListWorkflowRuns).toHaveBeenCalledWith({
      status: ['running', 'paused'],
      limit: 50,
    });
  });
});

describe('resumeWorkflow', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockClear();
  });

  test('returns run when status is resumable', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'failed' }));

    const run = await resumeWorkflow('run-1');
    expect(run.id).toBe('run-1');
  });

  test('throws on non-resumable status', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(resumeWorkflow('run-1')).rejects.toThrow(
      "Cannot resume run with status 'completed'"
    );
  });

  test('throws wrapped message and logs when DB throws', async () => {
    mockGetWorkflowRun.mockRejectedValueOnce(new Error('connection reset'));

    await expect(resumeWorkflow('run-1')).rejects.toThrow(
      'Failed to look up workflow run run-1: connection reset'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1' }),
      'operations.workflow_resume_lookup_failed'
    );
  });
});

describe('abandonWorkflow', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockClear();
  });

  test('cancels a non-terminal run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));

    const run = await abandonWorkflow('run-1');
    expect(run.id).toBe('run-1');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  test('throws on terminal run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(abandonWorkflow('run-1')).rejects.toThrow(
      "Cannot abandon run with status 'completed'"
    );
  });
});

describe('binding-v2 shared operations continuation gate', () => {
  const refusal = 'Codex-only continuation is not supported by shared workflow operations.';
  const restrictedName = 'bdc-feature-development-codex-only';
  const markers = [
    ['undefined', undefined],
    ['null', null],
    ['false', false],
    ['corrupt', 'broken'],
    ['v1', { version: 'codex-only-v1' }],
    ['v2', { version: 'codex-only-v2' }],
    ['future', { version: 'codex-only-v999' }],
  ] as const;
  const operations = [resumeWorkflow, approveWorkflow, rejectWorkflow] as const;

  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockCreateWorkflowEvent.mockClear();
    mockUpdateWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockClear();
  });

  function expectNoWrites() {
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  }

  for (const operation of [resumeWorkflow, approveWorkflow]) {
    for (const status of ['paused', 'failed', 'running', 'completed']) {
      for (const [label, marker] of markers) {
        test(`${operation.name} refuses own ${label} marker with ${status} status`, async () => {
          const run = makePausedRun({
            status,
            metadata: { codex_only_dispatch: marker },
          });
          // Own undefined must be tested before any serialization can discard it.
          expect(Object.hasOwn(run.metadata, 'codex_only_dispatch')).toBe(true);
          const before = structuredClone(run);
          mockGetWorkflowRun.mockResolvedValueOnce(run);
          await expect(operation('run-1')).rejects.toThrow(refusal);
          expect(run).toEqual(before);
          expectNoWrites();
        });
      }
      test(`${operation.name} refuses reserved name before status/context access (${status})`, async () => {
        const run = makePausedRun({ workflow_name: restrictedName, status });
        Object.defineProperty(run, 'status', {
          get() {
            throw new Error('must not inspect restricted status');
          },
        });
        Object.defineProperty(run, 'metadata', {
          get() {
            throw new Error('must not inspect restricted approval');
          },
        });
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        await expect(operation('run-1')).rejects.toThrow(refusal);
        expectNoWrites();
      });
    }
    for (const type of ['approval', 'interactive_loop']) {
      test(`${operation.name} refuses reserved name with valid ${type} context`, async () => {
        const run = makePausedRun({
          workflow_name: restrictedName,
          metadata: { approval: { nodeId: 'review', message: 'Review', type } },
        });
        const before = structuredClone(run);
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        await expect(operation('run-1')).rejects.toThrow(refusal);
        expect(run).toEqual(before);
        expectNoWrites();
      });
    }
  }

  for (const [label, marker] of markers) {
    for (const prompt of ['Fix it', '', null, false, 0]) {
      test(`reject refuses own ${label} retry marker and present prompt ${JSON.stringify(prompt)}`, async () => {
        const run = makePausedRun({
          metadata: {
            codex_only_dispatch: marker,
            approval: { nodeId: 'review', message: 'Review', onRejectPrompt: prompt },
          },
        });
        const before = structuredClone(run);
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        await expect(rejectWorkflow('run-1', 'fix')).rejects.toThrow(refusal);
        expect(run).toEqual(before);
        expectNoWrites();
      });
    }
  }

  for (const count of [undefined, null, 0, 1, Number.NaN]) {
    test(`reserved-name rejection refuses retry with count ${String(count)}`, async () => {
      const run = makePausedRun({
        workflow_name: restrictedName,
        metadata: {
          rejection_count: count,
          approval: { nodeId: 'review', message: 'Review', onRejectPrompt: 'Fix' },
        },
      });
      mockGetWorkflowRun.mockResolvedValueOnce(run);
      await expect(rejectWorkflow('run-1')).rejects.toThrow(refusal);
      expectNoWrites();
    });
  }

  for (const restricted of [false, true]) {
    for (const [label, approval, count, maxReached] of [
      ['no handler', { nodeId: 'review', message: 'Review' }, 0, false],
      ['invalid context', { nodeId: 'review', onRejectPrompt: 'Fix' }, 0, false],
      ['absent context', undefined, 0, false],
      [
        'inclusive limit',
        { nodeId: 'review', message: 'Review', onRejectPrompt: '', onRejectMaxAttempts: 2 },
        1,
        true,
      ],
      [
        'above limit',
        { nodeId: 'review', message: 'Review', onRejectPrompt: false, onRejectMaxAttempts: 2 },
        3,
        true,
      ],
      ['default limit', { nodeId: 'review', message: 'Review', onRejectPrompt: null }, 2, true],
    ] as const) {
      test(`${restricted ? 'restricted' : 'ordinary'} ${label} preserves cancellation event, order and result`, async () => {
        const run = makePausedRun({
          workflow_name: restricted ? restrictedName : 'test-workflow',
          metadata: { approval, rejection_count: count },
        });
        const before = structuredClone(run);
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        const result = await rejectWorkflow('run-1');
        expect(mockCreateWorkflowEvent.mock.calls).toEqual([
          [
            {
              workflow_run_id: 'run-1',
              event_type: 'approval_received',
              step_name: approval && 'message' in approval ? 'review' : 'unknown',
              data: { decision: 'rejected', reason: 'Rejected' },
            },
          ],
        ]);
        expect(mockCancelWorkflowRun.mock.calls).toEqual([['run-1']]);
        expect(mockCreateWorkflowEvent.mock.invocationCallOrder[0]).toBeLessThan(
          mockCancelWorkflowRun.mock.invocationCallOrder[0]!
        );
        expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
        expect(result).toEqual({
          workflowName: run.workflow_name,
          workingPath: run.working_path,
          userMessage: run.user_message,
          codebaseId: run.codebase_id,
          conversationId: run.conversation_id,
          cancelled: true,
          maxAttemptsReached: maxReached,
        });
        expect(run).toEqual(before);
      });
    }
  }

  test('ordinary NaN comparison retains retry rather than invented cancellation', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          rejection_count: Number.NaN,
          approval: { nodeId: 'review', message: 'Review', onRejectPrompt: 'Fix' },
        },
      })
    );
    expect(await rejectWorkflow('run-1', 'reason')).toMatchObject({
      cancelled: false,
      maxAttemptsReached: false,
    });
    expect(mockUpdateWorkflowRun.mock.calls).toEqual([
      [
        'run-1',
        {
          status: 'failed',
          metadata: { rejection_reason: 'reason', rejection_count: Number.NaN },
        },
      ],
    ]);
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(1);
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  for (const field of ['approval', 'rejection_count']) {
    test(`restricted unreadable ${field} refuses before first event`, async () => {
      const metadata = { codex_only_dispatch: false };
      Object.defineProperty(metadata, field, {
        get() {
          throw new Error('unreadable context');
        },
      });
      mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ metadata }));
      await expect(rejectWorkflow('run-1')).rejects.toThrow(refusal);
      expectNoWrites();
    });
  }
  test('restricted counter coercion failure refuses before first event', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          codex_only_dispatch: false,
          rejection_count: Symbol('unreadable'),
          approval: { nodeId: 'review', message: 'Review', onRejectPrompt: 'Fix' },
        },
      })
    );
    await expect(rejectWorkflow('run-1')).rejects.toThrow(refusal);
    expectNoWrites();
  });

  for (const field of ['nodeId', 'message', 'onRejectPrompt', 'onRejectMaxAttempts']) {
    test(`restricted unreadable approval ${field} refuses before first event`, async () => {
      const approval = { nodeId: 'review', message: 'Review', onRejectPrompt: 'Fix' };
      Object.defineProperty(approval, field, {
        get() {
          throw new Error('unreadable approval');
        },
      });
      mockGetWorkflowRun.mockResolvedValueOnce(
        makePausedRun({ metadata: { codex_only_dispatch: false, approval } })
      );
      await expect(rejectWorkflow('run-1')).rejects.toThrow(refusal);
      expectNoWrites();
    });
  }

  test('restricted NaN limit does not authorize cancellation', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          codex_only_dispatch: false,
          approval: {
            nodeId: 'review',
            message: 'Review',
            onRejectPrompt: 'Fix',
            onRejectMaxAttempts: Number.NaN,
          },
        },
      })
    );
    await expect(rejectWorkflow('run-1')).rejects.toThrow(refusal);
    expectNoWrites();
  });

  test('restricted cancellation uses its pre-write branch decision once', async () => {
    let promptReads = 0;
    const approval = { nodeId: 'review', message: 'Review' };
    Object.defineProperty(approval, 'onRejectPrompt', {
      get() {
        promptReads++;
        if (promptReads > 1) throw new Error('branch reread after evidence write');
        return undefined;
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          codex_only_dispatch: false,
          approval,
        },
      })
    );
    expect(await rejectWorkflow('run-1')).toMatchObject({
      cancelled: true,
      maxAttemptsReached: false,
    });
    expect(promptReads).toBe(1);
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(1);
    expect(mockCancelWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
  });

  test('restricted at-limit comparison is evaluated before the event and only once', async () => {
    let comparisons = 0;
    const count = {
      valueOf() {
        comparisons++;
        expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
        if (comparisons > 1) throw new Error('comparison repeated');
        return 2;
      },
    };
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          codex_only_dispatch: false,
          rejection_count: count,
          approval: { nodeId: 'review', message: 'Review', onRejectPrompt: 'Fix' },
        },
      })
    );
    expect(await rejectWorkflow('run-1')).toMatchObject({
      cancelled: true,
      maxAttemptsReached: true,
    });
    expect(comparisons).toBe(1);
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(1);
    expect(mockCancelWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
  });

  for (const operation of operations) {
    test(`${operation.name} preserves missing and failed lookup errors`, async () => {
      mockGetWorkflowRun.mockResolvedValueOnce(null);
      await expect(operation('missing')).rejects.toThrow('Workflow run not found: missing');
      mockGetWorkflowRun.mockRejectedValueOnce(new Error('offline'));
      await expect(operation('missing')).rejects.toThrow(
        'Failed to look up workflow run missing: offline'
      );
      expect(mockGetWorkflowRun).toHaveBeenCalledTimes(2);
      expectNoWrites();
    });
    test(`${operation.name} repeated restricted calls never accumulate writes`, async () => {
      const run = makePausedRun({
        workflow_name: restrictedName,
        metadata: {
          approval: { nodeId: 'review', message: 'Review', onRejectPrompt: 'Fix' },
        },
      });
      const before = structuredClone(run);
      mockGetWorkflowRun.mockResolvedValueOnce(run).mockResolvedValueOnce(run);
      await expect(operation('run-1')).rejects.toThrow(refusal);
      await expect(operation('run-1')).rejects.toThrow(refusal);
      expect(run).toEqual(before);
      expectNoWrites();
    });
    test(`${operation.name} unreadable restriction refuses without writes`, async () => {
      const run = makePausedRun();
      Object.defineProperty(run, 'metadata', {
        get() {
          throw new Error('unreadable marker');
        },
      });
      mockGetWorkflowRun.mockResolvedValueOnce(run);
      await expect(operation('run-1')).rejects.toThrow(refusal);
      expectNoWrites();
    });
  }

  test('an inherited marker does not restrict ordinary readonly resume', async () => {
    const metadata = Object.create({ codex_only_dispatch: true });
    const run = makePausedRun({ status: 'failed', metadata });
    mockGetWorkflowRun.mockResolvedValueOnce(run);
    expect(await resumeWorkflow('run-1')).toBe(run);
    expectNoWrites();
  });
  test('ordinary non-paused reject keeps status error before context access', async () => {
    const run = makePausedRun({ status: 'completed' });
    Object.defineProperty(run, 'metadata', {
      get() {
        throw new Error('context accessed');
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);
    await expect(rejectWorkflow('run-1')).rejects.toThrow(
      "Cannot reject run with status 'completed'"
    );
    expectNoWrites();
  });
  test('restricted explicit abandon keeps cancellation and terminal checks', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ workflow_name: restrictedName }));
    expect((await abandonWorkflow('run-1')).workflow_name).toBe(restrictedName);
    expect(mockCancelWorkflowRun.mock.calls).toEqual([['run-1']]);
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({ workflow_name: restrictedName, status: 'completed' })
    );
    await expect(abandonWorkflow('run-1')).rejects.toThrow(
      "Cannot abandon run with status 'completed'"
    );
    expect(mockCancelWorkflowRun).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
  });
});
