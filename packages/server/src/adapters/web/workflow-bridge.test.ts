/**
 * Tests for resolveWebLane() in workflow-bridge.ts.
 *
 * W1: explicit workflowName is forwarded to resolveExecutorLane and returned.
 * W2: task_class is mapped to camelCase taskClass when calling resolveExecutorLane
 *     (verifies the snake_case -> camelCase field conversion at bridge.ts:325).
 * W3: neither workflowName nor task_class -> resolveWebLane returns undefined.
 * W4: null-lane result from resolveExecutorLane (Tier 0 / deterministic-script)
 *     propagates as undefined from resolveWebLane.
 *
 * Pattern mirrors persistence.test.ts -- mock @archon/paths BEFORE importing the
 * module under test so the lazy-cached logger picks up the mock.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock @archon/paths logger (must come before module imports)
// ---------------------------------------------------------------------------

const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// ---------------------------------------------------------------------------
// Mock @archon/workflows/event-emitter (imported transitively by workflow-bridge)
// ---------------------------------------------------------------------------

const mockSubscribe = mock((_handler: unknown) => () => {});
const mockGetConversationId = mock((_runId: string): string | undefined => undefined);
const mockSubscribeForConversation = mock((_convId: string, _handler: unknown) => () => {});
const mockEmitter = {
  subscribe: mockSubscribe,
  getConversationId: mockGetConversationId,
  subscribeForConversation: mockSubscribeForConversation,
};
mock.module('@archon/workflows/event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => mockEmitter),
}));

// ---------------------------------------------------------------------------
// Mock @archon/workflows/executor -- provides resolveExecutorLane
// ---------------------------------------------------------------------------

// Mutable holder so individual tests can override the return value.
let _resolveExecutorLaneImpl: (opts: {
  workflowName?: string;
  taskClass?: string;
  routerYamlPath: string;
  routerYamlContent?: string;
}) => Promise<string | undefined> = async () => undefined;

const mockResolveExecutorLane = mock(
  (opts: {
    workflowName?: string;
    taskClass?: string;
    routerYamlPath: string;
    routerYamlContent?: string;
  }) => _resolveExecutorLaneImpl(opts)
);

mock.module('@archon/workflows/executor', () => ({
  resolveExecutorLane: mockResolveExecutorLane,
  executeWorkflow: mock(async () => ({ success: true })),
}));

// ---------------------------------------------------------------------------
// Import module under test (after all mocks are installed)
// ---------------------------------------------------------------------------

const { resolveWebLane } = await import('./workflow-bridge');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROUTER_YAML_PATH = '/workspace/config/router.yaml';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveWebLane', () => {
  beforeEach(() => {
    mockResolveExecutorLane.mockClear();
    // Reset to default (returns undefined) before each test
    _resolveExecutorLaneImpl = async () => undefined;
  });

  it('W1: explicit workflowName is forwarded to resolveExecutorLane and returned', async () => {
    // The real resolveExecutorLane short-circuits when workflowName is set;
    // here we simulate that same return to test resolveWebLane end-to-end.
    _resolveExecutorLaneImpl = async opts => opts.workflowName;

    const result = await resolveWebLane({
      workflowName: 'bdc-feature-development',
      routerYamlPath: ROUTER_YAML_PATH,
    });

    expect(result).toBe('bdc-feature-development');
    expect(mockResolveExecutorLane).toHaveBeenCalledTimes(1);
    const callArgs = mockResolveExecutorLane.mock.calls[0][0];
    expect(callArgs.workflowName).toBe('bdc-feature-development');
    expect(callArgs.routerYamlPath).toBe(ROUTER_YAML_PATH);
  });

  it('W2: task_class (snake_case) is mapped to camelCase taskClass for resolveExecutorLane', async () => {
    // This is the critical mapping at workflow-bridge.ts line 325:
    //   taskClass: req.task_class
    // The test verifies that the camelCase field is set and the snake_case
    // field is NOT forwarded verbatim to resolveExecutorLane.
    _resolveExecutorLaneImpl = async () => 'bdc-feature-development-codex';

    const result = await resolveWebLane({
      task_class: 'single-builder-pr',
      routerYamlPath: ROUTER_YAML_PATH,
    });

    expect(result).toBe('bdc-feature-development-codex');
    expect(mockResolveExecutorLane).toHaveBeenCalledTimes(1);

    const callArgs = mockResolveExecutorLane.mock.calls[0][0];
    // camelCase taskClass must be set
    expect(callArgs.taskClass).toBe('single-builder-pr');
    // snake_case task_class must NOT appear in the forwarded opts
    expect((callArgs as Record<string, unknown>).task_class).toBeUndefined();
    expect(callArgs.routerYamlPath).toBe(ROUTER_YAML_PATH);
  });

  it('W3: neither workflowName nor task_class provided -> returns undefined', async () => {
    // _resolveExecutorLaneImpl is already reset to () => undefined in beforeEach
    const result = await resolveWebLane({
      routerYamlPath: ROUTER_YAML_PATH,
    });

    expect(result).toBeUndefined();
    expect(mockResolveExecutorLane).toHaveBeenCalledTimes(1);
    const callArgs = mockResolveExecutorLane.mock.calls[0][0];
    expect(callArgs.workflowName).toBeUndefined();
    expect(callArgs.taskClass).toBeUndefined();
  });

  it('W4: null-lane result from resolveExecutorLane propagates as undefined', async () => {
    // When the resolved engine maps to a null lane (e.g. deterministic-script),
    // resolveExecutorLane returns undefined. resolveWebLane must propagate that.
    _resolveExecutorLaneImpl = async () => undefined;

    const result = await resolveWebLane({
      task_class: 'notion-flip',
      routerYamlPath: ROUTER_YAML_PATH,
    });

    expect(result).toBeUndefined();
  });
});
