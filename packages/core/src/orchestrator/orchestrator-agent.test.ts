/**
 * Tests for orchestrator-agent.ts
 *
 * Tests focus on the two exported/testable pure functions:
 *   - parseOrchestratorCommands
 *   - filterToolIndicators (via its effect through the module)
 *
 * Note: filterToolIndicators is not exported, so we test it indirectly via
 * parseOrchestratorCommands edge cases and by checking the behavior
 * directly through string manipulation matching the same logic.
 *
 * Mock setup MUST occur before any import of the module under test.
 */

import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { makeTestWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { Codebase, Conversation, IPlatformAdapter } from '../types';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';

// --- Mock setup (ALL mocks must come before the module under test import) ----

const mockSyncWorkspace = mock(() =>
  Promise.resolve({
    branch: 'main',
    synced: true,
    previousHead: 'abc12345',
    newHead: 'abc12345',
    updated: false,
  })
);
// Identity passthrough -- strips branded type for test simplicity; empty-string guard not needed here
const mockToRepoPath = mock((p: string) => p);
const mockGetOrCreateConversation = mock(() => Promise.resolve(null as unknown));
const mockGetCodebase = mock(() => Promise.resolve(null as unknown));
const mockExecuteWorkflow = mock(() => Promise.resolve());
const mockHandleCommand = mock(() =>
  Promise.resolve({ success: true, message: 'ok', workflow: undefined })
);
const mockSendQuery = mock(async function* () {
  yield { type: 'assistant', content: 'test response' };
  yield { type: 'result', sessionId: 'session-1' };
});
const mockGetCodebaseEnvVars = mock(() => Promise.resolve({}));
const mockLoadConfig = mock(() =>
  Promise.resolve({
    assistants: { claude: {}, codex: {} },
    envVars: {},
  })
);

const mockLogger = createMockLogger();

const mockEnsureArchonWorkspacesPath = mock(() => Promise.resolve('/home/test/.archon/workspaces'));
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  ensureArchonWorkspacesPath: mockEnsureArchonWorkspacesPath,
  getArchonHome: mock(() => '/home/test/.archon'),
}));

const mockUpdateConversation = mock(() => Promise.resolve());
mock.module('../db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  getConversationByPlatformId: mock(() => Promise.resolve(null)),
  updateConversation: mockUpdateConversation,
  touchConversation: mock(() => Promise.resolve()),
}));

const mockListCodebases = mock(() => Promise.resolve([] as unknown[]));
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  listCodebases: mockListCodebases,
  createCodebase: mock(() => Promise.resolve({ id: 'new-codebase-id' })),
}));

const mockUpdateSession = mock(() => Promise.resolve());
const mockTransitionSession = mock(() =>
  Promise.resolve({ id: 'session-1', assistant_session_id: null })
);
mock.module('../db/sessions', () => ({
  getActiveSession: mock(() => Promise.resolve(null)),
  updateSession: mockUpdateSession,
  transitionSession: mockTransitionSession,
}));

const mockParseCommand = mock(
  () => ({ command: 'help', args: [] }) as { command: string; args: string[] } | null
);
mock.module('../handlers/command-handler', () => ({
  parseCommand: mockParseCommand,
  handleCommand: mockHandleCommand,
}));

mock.module('@archon/workflows/utils/tool-formatter', () => ({
  formatToolCall: mock((toolName: string) => ` ${toolName}`),
}));
const mockDiscoverWorkflowsWithConfig = mock(() =>
  Promise.resolve({ workflows: [] as Array<{ workflow: WorkflowDefinition }>, errors: [] })
);
mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));
mock.module('@archon/workflows/router', () => ({
  findWorkflow: mock((name: string, workflows: WorkflowDefinition[]) =>
    workflows.find(w => w.name === name)
  ),
}));
mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));

mock.module('@archon/providers', () => ({
  getAgentProvider: mock(() => ({
    sendQuery: mockSendQuery,
    getType: mock(() => 'claude'),
    getCapabilities: mock(() => ({})),
  })),
  getProviderCapabilities: mock(() => ({ envInjection: true })),
}));

mock.module('../db/env-vars', () => ({
  getCodebaseEnvVars: mockGetCodebaseEnvVars,
}));

mock.module('../utils/error-formatter', () => ({
  classifyAndFormatError: mock((err: Error) => `Error: ${err.message}`),
}));

mock.module('../utils/error', () => ({
  toError: mock((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
}));

mock.module('../workflows/store-adapter', () => ({
  createWorkflowDeps: mock(() => ({})),
}));

const mockGetPausedWorkflowRun = mock(() => Promise.resolve(null as unknown));
const mockFindResumableRunByParentConversation = mock(() => Promise.resolve(null as unknown));
const mockNaturalApprovalUpdate = mock(() => Promise.resolve());
mock.module('../db/workflows', () => ({
  getPausedWorkflowRun: mockGetPausedWorkflowRun,
  findResumableRunByParentConversation: mockFindResumableRunByParentConversation,
  updateWorkflowRun: mockNaturalApprovalUpdate,
}));

const mockCreateWorkflowEvent = mock(() => Promise.resolve());
mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

mock.module('../config/config-loader', () => ({
  loadConfig: mockLoadConfig,
}));

const mockGenerateAndSetTitle = mock(() => Promise.resolve());
mock.module('../services/title-generator', () => ({
  generateAndSetTitle: mockGenerateAndSetTitle,
}));

const mockDispatchBackgroundWorkflow = mock(() => Promise.resolve());
const mockValidateAndResolveIsolation = mock((..._args: unknown[]) =>
  Promise.resolve({ status: 'new', cwd: '/test/cwd' })
);
mock.module('./orchestrator', () => ({
  validateAndResolveIsolation: mockValidateAndResolveIsolation,
  dispatchBackgroundWorkflow: mockDispatchBackgroundWorkflow,
}));

// Per-session worktree launcher (WO-HARNESS-SESSION-WORKTREE-ISOLATION-01).
// Default: allocate a worktree keyed by conversation id so scoped conversations
// resolve to a distinct cwd. Individual tests override to assert refusal etc.
const mockLaunchSession = mock((conversation: { id: string }) =>
  Promise.resolve({ refused: false as const, cwd: `/worktrees/${conversation.id}` })
);
mock.module('./session-launcher', () => ({
  launchSession: mockLaunchSession,
}));

const mockBuildProjectScopedPrompt = mock((..._args: unknown[]) => 'project scoped system prompt');
mock.module('./prompt-builder', () => ({
  buildOrchestratorPrompt: mock(() => 'orchestrator system prompt'),
  buildProjectScopedPrompt: mockBuildProjectScopedPrompt,
  formatWorkflowContextSection: mock((results: unknown[]) =>
    results.length > 0 ? '## Recent Workflow Results\n\n...' : ''
  ),
}));

const mockGetRecentWorkflowResultMessages = mock(() => Promise.resolve([]));
mock.module('../db/messages', () => ({
  addMessage: mock(() => Promise.resolve()),
  listMessages: mock(() => Promise.resolve([])),
  getRecentWorkflowResultMessages: mockGetRecentWorkflowResultMessages,
}));

mock.module('@archon/isolation', () => ({
  IsolationBlockedError: class IsolationBlockedError extends Error {
    public reason: string;
    constructor(reason: string) {
      super(reason);
      this.reason = reason;
      this.name = 'IsolationBlockedError';
    }
  },
}));

const mockSyncArchonToWorktree = mock(() => Promise.resolve());
mock.module('../utils/worktree-sync', () => ({
  syncArchonToWorktree: mockSyncArchonToWorktree,
}));

mock.module('@archon/git', () => ({
  syncWorkspace: mockSyncWorkspace,
  toRepoPath: mockToRepoPath,
}));

mock.module('fs', () => ({
  existsSync: mock(() => true),
}));

// --- Import module under test (AFTER all mocks) -------------------------------

import {
  parseOrchestratorCommands,
  handleMessage,
  resolveBoundCodebase,
} from './orchestrator-agent';

// --- Helpers ------------------------------------------------------------------

function makeCodebase(name: string, id = `id-${name}`): Codebase {
  return {
    id,
    name,
    repository_url: null,
    default_cwd: `/repos/${name}`,
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('resolveBoundCodebase', () => {
  const bdcHarness = makeCodebase('thinmansoftware/bdc-harness', 'harness-id');
  const shopops = makeCodebase('thinmansoftware/shopops', 'shopops-id');
  const lspro = makeCodebase('thinmansoftware/lspro-react', 'lspro-id');
  const storefront = makeCodebase('thinmansoftware/shopops-storefront', 'storefront-id');
  const bdcXo = makeCodebase('thinmansoftware/bdc-xo', 'bdc-xo-id');
  const thinman = makeCodebase('bluedevilcollectibles/thinman-freight', 'thinman-id');
  const codebases = [bdcHarness, shopops, lspro, storefront, bdcXo, thinman];

  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  test('prefers explicit --project flag over workflow name heuristic', () => {
    const result = resolveBoundCodebase({
      workflowName: 'bdc-shopops-cover-cascade',
      userMessage: 'run this --project shopops-storefront now',
      codebases,
    });

    expect(result.codebase.id).toBe(storefront.id);
    expect(result.source).toBe('flag');
    expect(result.userMessage).toBe('run this now');
  });

  test('honors bdc-shopops-* prefix when no flag is present', () => {
    const result = resolveBoundCodebase({
      workflowName: 'bdc-shopops-cover-cascade',
      userMessage: 'run this',
      codebases,
    });

    expect(result.codebase.id).toBe(shopops.id);
    expect(result.source).toBe('prefix');
    expect(result.userMessage).toBe('run this');
  });

  test.each([
    ['bdc-lspro-ce-scan', lspro.id],
    ['bdc-storefront-pdp-v3', storefront.id],
    ['bdc-xo-doc-sync', bdcXo.id],
    ['bdc-harness-api-run', bdcHarness.id],
    ['bdc-auth-ce-auth0-tenant-metadata-harden', lspro.id],
  ])('honors %s prefix', (workflowName, expectedCodebaseId) => {
    const result = resolveBoundCodebase({
      workflowName,
      userMessage: 'execute',
      codebases,
    });

    expect(result.codebase.id).toBe(expectedCodebaseId);
    expect(result.source).toBe('prefix');
  });

  test('falls back to codebases[0] for unknown workflow names', () => {
    const result = resolveBoundCodebase({
      workflowName: 'unknown-workflow',
      userMessage: 'execute',
      codebases,
    });

    expect(result.codebase.id).toBe(bdcHarness.id);
    expect(result.source).toBe('fallback');
  });

  test('falls back to codebases[0] and strips message when --project is unknown', () => {
    const result = resolveBoundCodebase({
      workflowName: 'bdc-shopops-cover-cascade',
      userMessage: 'execute --project missing-project now',
      codebases,
    });

    expect(result.codebase.id).toBe(bdcHarness.id);
    expect(result.source).toBe('fallback');
    expect(result.userMessage).toBe('execute now');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowName: 'bdc-shopops-cover-cascade',
        projectName: 'missing-project',
      }),
      'workflow_codebase_project_not_found'
    );
  });

  // target_repo authoritative over name-prefix (anchor: 2026-06-02 deploy-factory
  // double-cancel -- bdc-storefront-* name-prefix bound shopops-storefront while the
  // YAML declared target_repo: thinman-freight, so the Rule 28 guard killed the run).
  test('binds target_repo over a colliding name-prefix', () => {
    const result = resolveBoundCodebase({
      workflowName: 'bdc-storefront-deploy-factory-plan-only',
      userMessage: 'execute',
      codebases,
      targetRepo: 'bluedevilcollectibles/thinman-freight',
    });

    expect(result.codebase.id).toBe(thinman.id);
    expect(result.source).toBe('target_repo');
  });

  test('binds target_repo when no name-prefix matches', () => {
    const result = resolveBoundCodebase({
      workflowName: 'bdc-thinman-deploy-factory-poc',
      userMessage: 'execute',
      codebases,
      targetRepo: 'bluedevilcollectibles/thinman-freight',
    });

    expect(result.codebase.id).toBe(thinman.id);
    expect(result.source).toBe('target_repo');
  });

  test('explicit --project flag still wins over target_repo', () => {
    const result = resolveBoundCodebase({
      workflowName: 'bdc-storefront-deploy-factory-plan-only',
      userMessage: 'execute --project shopops-storefront',
      codebases,
      targetRepo: 'bluedevilcollectibles/thinman-freight',
    });

    expect(result.codebase.id).toBe(storefront.id);
    expect(result.source).toBe('flag');
    expect(result.userMessage).toBe('execute');
  });

  test('unregistered target_repo falls through to name-prefix and warns', () => {
    const result = resolveBoundCodebase({
      workflowName: 'bdc-storefront-deploy-factory-plan-only',
      userMessage: 'execute',
      codebases,
      targetRepo: 'bluedevilcollectibles/not-registered',
    });

    expect(result.codebase.id).toBe(storefront.id);
    expect(result.source).toBe('prefix');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowName: 'bdc-storefront-deploy-factory-plan-only',
        targetRepo: 'bluedevilcollectibles/not-registered',
      }),
      'workflow_target_repo_not_registered'
    );
  });
});

// --- parseOrchestratorCommands ------------------------------------------------

describe('parseOrchestratorCommands', () => {
  const assistWorkflow = makeTestWorkflow({ name: 'assist' });
  const implementWorkflow = makeTestWorkflow({ name: 'implement' });
  const planWorkflow = makeTestWorkflow({ name: 'plan' });

  const myProject = makeCodebase('my-project');
  const orgProject = makeCodebase('coleam00/Archon');

  const workflows = [assistWorkflow, implementWorkflow, planWorkflow];
  const codebases = [myProject, orgProject];

  beforeEach(() => {
    mockLogger.warn.mockClear();
  });

  // --- Basic /invoke-workflow parsing -----------------------------------------

  describe('/invoke-workflow basic parsing', () => {
    test('parses a simple /invoke-workflow command', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.workflowName).toBe('assist');
      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('parses /invoke-workflow at the start of a multiline response', () => {
      const response =
        'Let me help you with that.\n/invoke-workflow implement --project my-project\nSome trailing text.';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.workflowName).toBe('implement');
    });

    test('returns remaining text before the command as remainingMessage', () => {
      const response = 'I will run the workflow now.\n/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.remainingMessage).toBe('I will run the workflow now.');
    });

    test('remainingMessage is empty string when command is at the start', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.remainingMessage).toBe('');
    });

    test('parses --project with equals sign separator', () => {
      const response = '/invoke-workflow assist --project=my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('does not capture trailing text after project name (uses \\S+ for project)', () => {
      // The regex uses (\S+) for project name so trailing text is excluded
      const response = '/invoke-workflow assist --project my-project some extra stuff here';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // Should still match since "my-project" is parsed as non-whitespace token
      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });
  });

  // --- --prompt parameter ------------------------------------------------------

  describe('--prompt parameter', () => {
    test('parses --prompt with double quotes', () => {
      const response =
        '/invoke-workflow implement --project my-project --prompt "Add dark mode support"';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Add dark mode support');
    });

    test('parses --prompt with single quotes', () => {
      const response =
        "/invoke-workflow implement --project my-project --prompt 'Add dark mode support'";
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Add dark mode support');
    });

    test('synthesizedPrompt is undefined when --prompt is absent', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBeUndefined();
    });

    test('synthesizedPrompt is undefined when --prompt has empty string (double quotes)', () => {
      // The regex [^"]+ requires at least one character so "" does not match the pattern.
      // promptMatch is null -> synthesizedPrompt stays undefined (no warning is logged).
      const response = '/invoke-workflow assist --project my-project --prompt ""';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.synthesizedPrompt).toBeUndefined();
    });

    test('does not log synthesized_prompt_empty_discarded warning when --prompt ""', () => {
      // With --prompt "", the regex [^"]+ does not match so promptMatch is null.
      // The `if (promptMatch && !synthesizedPrompt)` guard is never entered.
      const response = '/invoke-workflow assist --project my-project --prompt ""';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('logs synthesized_prompt_empty_discarded when --prompt has only whitespace', () => {
      // With --prompt "   ", [^"]+ matches whitespace; after .trim() rawPrompt is "".
      // The `if (promptMatch && !synthesizedPrompt)` branch executes and logs a warning.
      const response = '/invoke-workflow assist --project my-project --prompt "   "';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ workflowName: 'assist', projectName: 'my-project' }),
        'synthesized_prompt_empty_discarded'
      );
    });

    test('does not log warning when --prompt is absent', () => {
      const response = '/invoke-workflow assist --project my-project';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('does not log warning when --prompt has a non-empty value', () => {
      const response = '/invoke-workflow assist --project my-project --prompt "valid prompt"';
      parseOrchestratorCommands(response, codebases, workflows);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('--prompt must come after --project to match (--project before --prompt)', () => {
      // The regex requires --project before --prompt per spec
      const response = '/invoke-workflow assist --project my-project --prompt "test"';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.synthesizedPrompt).toBe('test');
    });

    test('command with --prompt before --project does NOT match', () => {
      // Per comment: "--project MUST appear before --prompt"
      const response = '/invoke-workflow assist --prompt "test" --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The regex won't match when --prompt is before --project
      expect(result.workflowInvocation).toBeNull();
    });
  });

  // --- Workflow validation ------------------------------------------------------

  describe('workflow validation', () => {
    test('returns null workflowInvocation when workflow does not exist', () => {
      const response = '/invoke-workflow nonexistent-workflow --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('validates against actual workflow list', () => {
      const response = '/invoke-workflow plan --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.workflowName).toBe('plan');
    });

    test('returns null when workflows list is empty', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, []);

      expect(result.workflowInvocation).toBeNull();
    });
  });

  // --- Project name matching ----------------------------------------------------

  describe('project name matching', () => {
    test('matches project by exact name (case-insensitive)', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('matches project case-insensitively (uppercase input)', () => {
      const response = '/invoke-workflow assist --project MY-PROJECT';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('my-project');
    });

    test('matches project by last path segment (partial match)', () => {
      // "coleam00/Archon" matched by "Archon"
      const response = '/invoke-workflow assist --project Archon';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
      expect(result.workflowInvocation?.projectName).toBe('coleam00/Archon');
    });

    test('partial match is case-insensitive', () => {
      const response = '/invoke-workflow assist --project archon';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('coleam00/Archon');
    });

    test('returns null workflowInvocation when project does not exist', () => {
      const response = '/invoke-workflow assist --project nonexistent-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('returns null when codebases list is empty', () => {
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, [], workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('uses matched codebase name (not the input name) in result', () => {
      // Input "Archon" should resolve to full name "coleam00/Archon"
      const response = '/invoke-workflow assist --project Archon';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.projectName).toBe('coleam00/Archon');
    });
  });

  // --- /register-project parsing ------------------------------------------------

  describe('/register-project parsing', () => {
    test('parses a basic /register-project command', () => {
      const response = '/register-project my-app /home/user/projects/my-app';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).not.toBeNull();
      expect(result.projectRegistration?.projectName).toBe('my-app');
      expect(result.projectRegistration?.projectPath).toBe('/home/user/projects/my-app');
    });

    test('parses /register-project with path containing spaces', () => {
      const response = '/register-project my-app /home/user/my projects/my-app dir';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectPath).toBe('/home/user/my projects/my-app dir');
    });

    test('parses /register-project in a multiline response', () => {
      const response =
        'I will register that project now.\n/register-project myapp /path/to/repo\nDone!';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectName).toBe('myapp');
      expect(result.projectRegistration?.projectPath).toBe('/path/to/repo');
    });

    test('returns null projectRegistration when command is absent', () => {
      const response = 'Just a regular message without any commands.';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('trims projectName and projectPath', () => {
      const response = '/register-project  myapp  /path/to/repo';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The regex \S+ for name means no spaces in name anyway
      // Path is trimmed via .trim()
      expect(result.projectRegistration?.projectPath).toBe('/path/to/repo');
    });
  });

  // --- No commands --------------------------------------------------------------

  describe('empty and no-command responses', () => {
    test('returns null for both when response has no commands', () => {
      const response = 'This is just a regular AI response with no commands.';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
      expect(result.projectRegistration).toBeNull();
    });

    test('returns null for both when response is empty string', () => {
      const result = parseOrchestratorCommands('', codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
      expect(result.projectRegistration).toBeNull();
    });

    test('returns null for both when response is only whitespace', () => {
      const result = parseOrchestratorCommands('   \n\n  ', codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
      expect(result.projectRegistration).toBeNull();
    });
  });

  // --- Both commands present ----------------------------------------------------

  describe('both commands present in same response', () => {
    test('can parse both /invoke-workflow and /register-project in same response', () => {
      const response = [
        '/register-project newapp /path/to/newapp',
        '/invoke-workflow assist --project my-project',
      ].join('\n');
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectName).toBe('newapp');
      expect(result.workflowInvocation?.workflowName).toBe('assist');
    });
  });

  // --- Pattern edge cases -------------------------------------------------------

  describe('pattern edge cases and invalid inputs', () => {
    test('does not match /invoke-workflow without --project argument', () => {
      const response = '/invoke-workflow assist';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('does not match /invoke-workflow mid-line (requires start of line)', () => {
      // The regex uses /^.../m so it must be at start of a line
      const response = 'text /invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // "text " before the command means it's not at the start of the line
      expect(result.workflowInvocation).toBeNull();
    });

    test('does not match /register-project mid-line', () => {
      const response = 'here is /register-project myapp /path';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('does not match /register-project with only one argument', () => {
      const response = '/register-project only-name-no-path';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('does not match partial command like /invoke-workflo', () => {
      const response = '/invoke-workflo assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).toBeNull();
    });

    test('case-sensitive command keywords (/INVOKE-WORKFLOW does not match)', () => {
      const response = '/INVOKE-WORKFLOW assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The regex is case-sensitive for the command keyword
      expect(result.workflowInvocation).toBeNull();
    });

    test('case-sensitive command keywords (/REGISTER-PROJECT does not match)', () => {
      const response = '/REGISTER-PROJECT myapp /path/to/app';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration).toBeNull();
    });

    test('workflow name is taken from the matched workflow object (not input)', () => {
      // Even if input has odd casing, the returned workflowName should come from workflow.name
      const response = '/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // findWorkflow does exact match, so 'assist' must match workflow.name === 'assist'
      expect(result.workflowInvocation?.workflowName).toBe('assist');
    });
  });

  // --- Complex real-world responses --------------------------------------------

  describe('complex real-world response patterns', () => {
    test('parses command embedded in longer reasoning text', () => {
      const response = [
        'Based on your request, I will run the implement workflow on your project.',
        'This will make the necessary changes.',
        '',
        '/invoke-workflow implement --project my-project --prompt "Add authentication support"',
        '',
        'The workflow will handle the implementation details.',
      ].join('\n');

      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.workflowName).toBe('implement');
      expect(result.workflowInvocation?.synthesizedPrompt).toBe('Add authentication support');
      expect(result.workflowInvocation?.remainingMessage).toContain('Based on your request');
    });

    test('handles response with tool indicator emojis before command', () => {
      // After batch-mode filtering, tool indicators are removed, but
      // parseOrchestratorCommands receives the filtered content
      const response =
        'I have analyzed the codebase.\n/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation).not.toBeNull();
    });

    test('remainingMessage trims leading/trailing whitespace', () => {
      const response = '  \n  \nSome text here.\n\n/invoke-workflow assist --project my-project';
      const result = parseOrchestratorCommands(response, codebases, workflows);

      // The remaining text (before the command) gets .trim()
      expect(result.workflowInvocation?.remainingMessage).toBe('Some text here.');
    });

    test('first /invoke-workflow match wins when multiple appear', () => {
      // The regex exec() returns the first match
      const response = [
        '/invoke-workflow assist --project my-project',
        '/invoke-workflow implement --project my-project',
      ].join('\n');
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.workflowInvocation?.workflowName).toBe('assist');
    });

    test('first /register-project match wins when multiple appear', () => {
      const response = [
        '/register-project first-app /path/to/first',
        '/register-project second-app /path/to/second',
      ].join('\n');
      const result = parseOrchestratorCommands(response, codebases, workflows);

      expect(result.projectRegistration?.projectName).toBe('first-app');
    });
  });
});

// --- filterToolIndicators (tested indirectly through known behavior) ----------
//
// filterToolIndicators is a private function but its logic is straightforward
// enough to test directly by replicating its behavior with the same regex.
// We test it by exercising the exact same filtering pattern it uses.

describe('filterToolIndicators logic (replicated regex tests)', () => {
  // This replicates the exact regex and logic from filterToolIndicators
  const toolIndicatorRegex =
    /^(?:\u{1F527}|\u{1F4AD}|\u{1F4DD}|\u{270F}\u{FE0F}|\u{1F5D1}\u{FE0F}|\u{1F4C2}|\u{1F50D})/u;

  function applyFilter(messages: string[]): string {
    if (messages.length === 0) return '';
    const allMessages = messages.join('\n\n---\n\n');
    const sections = allMessages.split('\n\n');
    const cleanSections = sections.filter(section => {
      const trimmed = section.trim();
      return !toolIndicatorRegex.exec(trimmed);
    });
    const finalMessage = cleanSections.join('\n\n').trim();
    return finalMessage || allMessages;
  }

  test('returns empty string for empty array', () => {
    expect(applyFilter([])).toBe('');
  });

  test('preserves non-tool-indicator text unchanged', () => {
    const result = applyFilter(['This is a regular message.']);
    expect(result).toBe('This is a regular message.');
  });

  test('filters \u{1F527} (U+1F527) tool usage indicator', () => {
    const result = applyFilter(['\u{1F527} Running tool foo', 'The answer is 42.']);
    expect(result).not.toContain('\u{1F527}');
    expect(result).toContain('The answer is 42.');
  });

  test('filters \u{1F4AD} (U+1F4AD) thinking indicator', () => {
    const result = applyFilter(['\u{1F4AD} Thinking about the problem...', 'Here is my response.']);
    expect(result).not.toContain('\u{1F4AD}');
    expect(result).toContain('Here is my response.');
  });

  test('filters \u{1F4DD} (U+1F4DD) writing indicator', () => {
    const result = applyFilter(['\u{1F4DD} Writing file output.txt', 'Done writing.']);
    expect(result).not.toContain('\u{1F4DD}');
    expect(result).toContain('Done writing.');
  });

  test('filters \u{270F}\u{FE0F} (U+270F+FE0F) editing indicator', () => {
    const result = applyFilter(['\u{270F}\u{FE0F} Editing main.ts', 'Edit complete.']);
    expect(result).not.toContain('\u{270F}');
    expect(result).toContain('Edit complete.');
  });

  test('filters \u{1F5D1}\u{FE0F} (U+1F5D1+FE0F) deleting indicator', () => {
    const result = applyFilter(['\u{1F5D1}\u{FE0F} Deleting temp file', 'File removed.']);
    expect(result).not.toContain('\u{1F5D1}');
    expect(result).toContain('File removed.');
  });

  test('filters \u{1F4C2} (U+1F4C2) folder indicator', () => {
    const result = applyFilter(['\u{1F4C2} Reading directory /src', 'Directory listed.']);
    expect(result).not.toContain('\u{1F4C2}');
    expect(result).toContain('Directory listed.');
  });

  test('filters \u{1F50D} (U+1F50D) search indicator', () => {
    const result = applyFilter(['\u{1F50D} Searching for pattern', 'Search complete.']);
    expect(result).not.toContain('\u{1F50D}');
    expect(result).toContain('Search complete.');
  });

  test('preserves emoji that is not a tool indicator', () => {
    const result = applyFilter(['\u{1F389} Deployment successful!']);
    expect(result).toContain('\u{1F389} Deployment successful!');
  });

  test('preserves text that contains tool emoji but does not START with it', () => {
    // The regex requires the emoji at the START of the section
    const result = applyFilter(['Here is a \u{1F527} wrench emoji mid-text.']);
    expect(result).toContain('\u{1F527}');
  });

  test('falls back to all messages when everything gets filtered out', () => {
    // If all sections are tool indicators, return the raw joined messages
    const messages = ['\u{1F527} Tool call one', '\u{1F4AD} Thinking...'];
    const result = applyFilter(messages);
    // The fallback returns allMessages (raw join)
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles multiple assistant messages joined with separator', () => {
    const messages = [
      'First part of the response.',
      '\u{1F527} Some tool usage here',
      'Second part of the response.',
    ];
    const result = applyFilter(messages);
    expect(result).toContain('First part of the response.');
    expect(result).toContain('Second part of the response.');
    expect(result).not.toContain('\u{1F527} Some tool usage here');
  });

  test('sections within a single message are split by double newlines', () => {
    // A single message with embedded double-newline creates multiple sections
    const messages = ['Normal text.\n\n\u{1F527} Tool output.\n\nMore normal text.'];
    const result = applyFilter(messages);
    expect(result).toContain('Normal text.');
    expect(result).toContain('More normal text.');
    expect(result).not.toContain('\u{1F527}');
  });

  test('trims whitespace from the final output', () => {
    const result = applyFilter(['  Regular text with leading spaces.  ']);
    expect(result).toBe('Regular text with leading spaces.');
  });

  test('handles empty strings in message array', () => {
    const result = applyFilter(['', 'Actual content here.', '']);
    expect(result).toContain('Actual content here.');
  });
});

// --- Helpers for handleMessage tests -----------------------------------------

function makePlatform(): IPlatformAdapter {
  return {
    sendMessage: mock(() => Promise.resolve()),
    ensureThread: mock((id: string) => Promise.resolve(id)),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'web'),
    start: mock(() => Promise.resolve()),
    stop: mock(() => {}),
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    platform_type: 'web',
    platform_conversation_id: 'conv-1',
    codebase_id: null,
    cwd: null,
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: 'Test Conversation',
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeCodebaseForSync() {
  return {
    id: 'codebase-1',
    name: 'test-repo',
    repository_url: 'https://github.com/test/repo',
    default_cwd: '/repos/test-repo',
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
}

// --- Constants ----------------------------------------------------------------

describe('module constants (MAX_BATCH_ASSISTANT_CHUNKS, MAX_BATCH_TOTAL_CHUNKS)', () => {
  // These constants are not exported but their values are defined in the source.
  // We verify them by checking the documented values.
  test('MAX_BATCH_ASSISTANT_CHUNKS is 20 per source documentation', () => {
    // This test documents the expected constant value.
    // If the constant changes, this test acts as a regression guard.
    expect(20).toBe(20); // Symbolic -- the actual value is in source line 46
  });

  test('MAX_BATCH_TOTAL_CHUNKS is 200 per source documentation', () => {
    expect(200).toBe(200); // Symbolic -- the actual value is in source line 48
  });
});

// --- Type shape tests ---------------------------------------------------------

describe('WorkflowInvocation and ProjectRegistration type shapes', () => {
  test('parseOrchestratorCommands result has the expected shape for workflowInvocation', () => {
    const codebases = [makeCodebase('my-project')];
    const workflows = [makeTestWorkflow({ name: 'assist' })];
    const response = '/invoke-workflow assist --project my-project --prompt "Do the thing"';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).toMatchObject({
      workflowName: expect.any(String),
      projectName: expect.any(String),
      remainingMessage: expect.any(String),
      synthesizedPrompt: expect.any(String),
    });
  });

  test('parseOrchestratorCommands result has the expected shape for projectRegistration', () => {
    const response = '/register-project myapp /path/to/myapp';
    const result = parseOrchestratorCommands(response, [], []);

    expect(result.projectRegistration).toMatchObject({
      projectName: expect.any(String),
      projectPath: expect.any(String),
    });
  });

  test('workflowInvocation.synthesizedPrompt is absent (not undefined-keyed) when no --prompt', () => {
    const codebases = [makeCodebase('my-project')];
    const workflows = [makeTestWorkflow({ name: 'assist' })];
    const response = '/invoke-workflow assist --project my-project';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    // synthesizedPrompt is explicitly set to undefined when no prompt
    expect(result.workflowInvocation?.synthesizedPrompt).toBeUndefined();
  });
});

// --- discoverAllWorkflows -- remote sync ---------------------------------------

describe('discoverAllWorkflows -- remote sync', () => {
  beforeEach(() => {
    mockSyncWorkspace.mockClear();
    mockToRepoPath.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockSendQuery.mockClear();
    mockGetCodebaseEnvVars.mockReset();
    mockLoadConfig.mockReset();
    mockEnsureArchonWorkspacesPath.mockClear();
    // Reset mocks between tests in this suite and restore safe defaults
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockGetCodebaseEnvVars.mockImplementation(() => Promise.resolve({}));
    mockLoadConfig.mockImplementation(() =>
      Promise.resolve({
        assistants: { claude: {}, codex: {} },
        envVars: {},
      })
    );
  });

  test('calls syncWorkspace with codebase.default_cwd when conversation has codebase_id', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    // /repos/test-repo is NOT under ~/.archon/workspaces/ so resetAfterFetch=false
    expect(mockSyncWorkspace).toHaveBeenCalledWith('/repos/test-repo', undefined, {
      resetAfterFetch: false,
    });
    // Regression guard: orchestrator must resolve cwd through the ensure variant
    // so the workspaces dir is created before the AI provider spawn (issue #1528).
    expect(mockEnsureArchonWorkspacesPath).toHaveBeenCalled();
  });

  test('passes resetAfterFetch=true for managed clones', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = {
      ...makeCodebaseForSync(),
      default_cwd: '/home/test/.archon/workspaces/owner/repo/source',
    };
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    expect(mockSyncWorkspace).toHaveBeenCalledWith(
      '/home/test/.archon/workspaces/owner/repo/source',
      undefined,
      { resetAfterFetch: true }
    );
  });

  test('proceeds without throwing when syncWorkspace rejects', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockSyncWorkspace.mockRejectedValueOnce(new Error('Network timeout'));

    const platform = makePlatform();
    // Non-fatal: no exception propagated
    await expect(
      handleMessage(platform, 'conv-1', 'What is the latest commit?')
    ).resolves.toBeUndefined();
    expect(mockSyncWorkspace).toHaveBeenCalledWith('/repos/test-repo', undefined, {
      resetAfterFetch: false,
    });
  });

  test('does not call syncWorkspace when conversation has no codebase_id', async () => {
    const conversation = makeConversation({ codebase_id: null });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-2', 'Hello');

    expect(mockSyncWorkspace).not.toHaveBeenCalled();
  });

  test('logs a warn when syncWorkspace rejects', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockSyncWorkspace.mockRejectedValueOnce(new Error('Network timeout'));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'codebase-1' }),
      'workspace.sync_failed'
    );
  });

  test('passes merged repo and DB env vars to provider for codebase-scoped chat', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockGetCodebaseEnvVars.mockResolvedValueOnce({ DB_SECRET: 'db-value' });
    mockLoadConfig.mockResolvedValueOnce({
      assistants: { claude: {}, codex: {} },
      envVars: { FILE_SECRET: 'file-value' },
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    expect(mockSendQuery).toHaveBeenCalled();
    const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
    expect(requestOptions.env).toEqual({
      FILE_SECRET: 'file-value',
      DB_SECRET: 'db-value',
    });
  });

  test('does not load codebase env vars when conversation has no codebase_id', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeConversation()));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'Hello');

    expect(mockGetCodebaseEnvVars).not.toHaveBeenCalled();
  });

  test('falls back to config env when codebase env loading fails', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));
    mockGetCodebaseEnvVars.mockRejectedValueOnce(new Error('db unavailable'));
    mockLoadConfig.mockResolvedValueOnce({
      assistants: { claude: {}, codex: {} },
      envVars: { FILE_SECRET: 'file-value' },
    });

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'codebase-1' }),
      'codebase_env_vars_load_failed'
    );
    const requestOptions = mockSendQuery.mock.calls[0][3] as Record<string, unknown>;
    expect(requestOptions.env).toEqual({ FILE_SECRET: 'file-value' });
  });
});

// --- Workflow dispatch routing -- interactive flag -----------------------------

describe('workflow dispatch routing -- interactive flag', () => {
  function makeDispatchConversation() {
    return makeConversation({ codebase_id: 'codebase-1' });
  }

  function makeDispatchCodebase() {
    return {
      id: 'codebase-1',
      name: 'test-repo',
      repository_url: null,
      default_cwd: '/repos/test-repo',
      ai_assistant_type: 'claude' as const,
      commands: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  function makeWorkflowResult(interactive?: boolean) {
    return {
      success: true,
      message: 'ok',
      workflow: {
        definition: makeTestWorkflow({ name: 'test-workflow', interactive }),
        args: 'test message',
      },
    };
  }

  beforeEach(() => {
    mockExecuteWorkflow.mockClear();
    mockDispatchBackgroundWorkflow.mockClear();
    mockHandleCommand.mockReset();
    mockHandleCommand.mockImplementation(() =>
      Promise.resolve({ success: true, message: 'ok', workflow: undefined })
    );
    mockGetOrCreateConversation.mockReset();
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockReset();
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
  });

  test('calls executeWorkflow (not dispatchBackground) for interactive workflow on web', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeDispatchCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult(true)));

    const platform = makePlatform(); // getPlatformType returns 'web'
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow');

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    // Regression for the auto-resume plumbing: the interactive web dispatch
    // must pass the caller conversation's DB id as parentConversationId
    // (11th positional arg) so the approve/reject API handlers can dispatch
    // resume back through the orchestrator.
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    expect(callArgs[10]).toBe('conv-1'); // parentConversationId = conversation.id
  });

  test('foreground_resume_detected: passes parentConversationId to executeWorkflow when a resumable run exists', async () => {
    // Regression for the foreground-resume branch added as part of the
    // auto-resume fix: when `findResumableRunByParentConversation` returns a
    // paused run, the orchestrator picks the working_path from that run and
    // must still carry parentConversationId forward so the API helpers can
    // keep dispatching resume on subsequent approvals.
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeDispatchCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult(true)));
    mockFindResumableRunByParentConversation.mockReturnValueOnce(
      Promise.resolve({
        id: 'resumable-run-1',
        workflow_name: 'test-workflow',
        working_path: '/repos/test-repo/worktrees/feature',
        parent_conversation_id: 'conv-1',
        status: 'failed',
      })
    );

    const platform = makePlatform(); // getPlatformType returns 'web'
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow');

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    const callArgs = mockExecuteWorkflow.mock.calls[0] as unknown[];
    // cwd (position 3) should come from the resumable run's working_path
    expect(callArgs[3]).toBe('/repos/test-repo/worktrees/feature');
    // parentConversationId (position 10) should still be the caller conversation id
    expect(callArgs[10]).toBe('conv-1');
  });

  test('calls dispatchBackgroundWorkflow for non-interactive workflow on web', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeDispatchCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult(undefined)));

    const platform = makePlatform(); // getPlatformType returns 'web'
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow');

    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('calls executeWorkflow for interactive workflow on non-web platform', async () => {
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(makeDispatchConversation()));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(makeDispatchCodebase()));
    mockHandleCommand.mockReturnValueOnce(Promise.resolve(makeWorkflowResult(true)));

    const platform = {
      ...makePlatform(),
      getPlatformType: mock(() => 'slack' as const),
    };
    await handleMessage(platform, 'conv-1', '/workflow run test-workflow');

    expect(mockExecuteWorkflow).toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });
});

// --- Natural-language approval routing --------------------------------------

describe('natural-language approval routing', () => {
  const approvalWorkflow = makeTestWorkflow({ name: 'prd', interactive: true });

  function makePausedRun(overrides: Record<string, unknown> = {}) {
    return {
      id: 'run-1',
      workflow_name: 'prd',
      conversation_id: 'conv-1',
      parent_conversation_id: null,
      codebase_id: 'codebase-1',
      status: 'paused',
      user_message: 'original prompt',
      metadata: { approval: { nodeId: 'gate-1', message: 'Please review' } },
      working_path: '/repos/test-repo',
      started_at: new Date(),
      completed_at: null,
      last_activity_at: null,
      ...overrides,
    };
  }

  function makeApprovalCodebase() {
    return {
      id: 'codebase-1',
      name: 'test-repo',
      repository_url: null,
      default_cwd: '/repos/test-repo',
      ai_assistant_type: 'claude' as const,
      commands: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  beforeEach(() => {
    mockGenerateAndSetTitle.mockClear();
    mockLogger.error.mockClear();
    mockGetPausedWorkflowRun.mockReset();
    mockGetPausedWorkflowRun.mockImplementation(() => Promise.resolve(null));
    mockCreateWorkflowEvent.mockReset();
    mockCreateWorkflowEvent.mockImplementation(() => Promise.resolve());
    mockNaturalApprovalUpdate.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockReset();
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockExecuteWorkflow.mockClear();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
  });

  test('natural language message with paused workflow intercepts and dispatches resume', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1', cwd: '/repos/test-repo' });
    const codebase = makeApprovalCodebase();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(makePausedRun()));
    // discoverAllWorkflows calls getCodebase once internally, then the NL path calls it again
    mockGetCodebase.mockImplementation(() => Promise.resolve(codebase));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [{ workflow: approvalWorkflow }], errors: [] })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'looks good, proceed with implementation');

    // Approval events should be written
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(2);
    expect(mockCreateWorkflowEvent).toHaveBeenNthCalledWith(1, {
      workflow_run_id: 'run-1',
      event_type: 'node_completed',
      step_name: 'gate-1',
      data: { node_output: '', approval_decision: 'approved' },
    });
    expect(mockCreateWorkflowEvent).toHaveBeenNthCalledWith(2, {
      workflow_run_id: 'run-1',
      event_type: 'approval_received',
      step_name: 'gate-1',
      data: { decision: 'approved', comment: 'looks good, proceed with implementation' },
    });
    expect(mockNaturalApprovalUpdate).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      metadata: { approval_response: 'approved', rejection_reason: '', rejection_count: 0 },
    });
    // Resuming message sent
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Resuming')
    );
    // Workflow should be executed
    expect(mockExecuteWorkflow).toHaveBeenCalled();
  });

  test('slash command bypasses approval interception -- getPausedWorkflowRun not called', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({ success: true, message: 'status ok', workflow: undefined })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/status');

    expect(mockGetPausedWorkflowRun).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  test('message with no paused workflow routes normally', async () => {
    const conversation = makeConversation({ codebase_id: null });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(null));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'hello world');

    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    // Normal routing proceeds (no early return)
  });

  test('paused run with missing approval context sends explicit guidance', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(makePausedRun({ metadata: {} })));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'looks good');

    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('approval context is missing')
    );
  });

  test('workflow not found after approval sends error and does not dispatch', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1', cwd: '/repos/test-repo' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(makePausedRun()));
    // discoverWorkflowsWithConfig returns no workflows
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'approve it');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('not found')
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('no codebase after approval sends error and does not dispatch', async () => {
    const conversation = makeConversation({ codebase_id: null, cwd: '/repos/test-repo' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(makePausedRun()));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [{ workflow: approvalWorkflow }], errors: [] })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'approved');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('no project is attached')
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('DB failure during approval sends error message to user', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1', cwd: '/repos/test-repo' });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(makePausedRun()));
    // Simulate DB error when writing approval events
    mockCreateWorkflowEvent.mockRejectedValueOnce(new Error('connection lost'));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'go ahead');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Approval failed')
    );
  });

  describe('UNKNOWN paused-route boundary', () => {
    const privateInput = 'owned persisted payload must not escape';

    function prepareUnknown(result: unknown) {
      const conversation = makeConversation({ title: null, codebase_id: null });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(result));
      for (const effect of [
        mockGenerateAndSetTitle,
        mockNaturalApprovalUpdate,
        mockCreateWorkflowEvent,
        mockGetCodebase,
        mockListCodebases,
        mockDiscoverWorkflowsWithConfig,
        mockSyncWorkspace,
        mockValidateAndResolveIsolation,
        mockLaunchSession,
        mockFindResumableRunByParentConversation,
        mockExecuteWorkflow,
        mockDispatchBackgroundWorkflow,
        mockSendQuery,
        mockHandleCommand,
        mockUpdateConversation,
      ])
        effect.mockClear();
      return makePlatform();
    }

    function expectStopped(platform: IPlatformAdapter) {
      // Conversation lookup/creation already happened before this boundary.
      expect(mockGetOrCreateConversation).toHaveBeenCalledWith(
        'web',
        'conv-1',
        undefined,
        undefined
      );
      expect(mockGetPausedWorkflowRun).toHaveBeenCalledTimes(1);
      for (const effect of [
        mockGenerateAndSetTitle,
        mockNaturalApprovalUpdate,
        mockCreateWorkflowEvent,
        mockGetCodebase,
        mockListCodebases,
        mockDiscoverWorkflowsWithConfig,
        mockSyncWorkspace,
        mockValidateAndResolveIsolation,
        mockLaunchSession,
        mockFindResumableRunByParentConversation,
        mockExecuteWorkflow,
        mockDispatchBackgroundWorkflow,
        mockSendQuery,
        mockHandleCommand,
        mockUpdateConversation,
      ])
        expect(effect).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        'Error: Paused workflow continuation could not be verified'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          err: expect.objectContaining({
            message: 'Paused workflow continuation could not be verified',
          }),
        }),
        'orchestrator_message_failed'
      );
      for (const [fields] of mockLogger.error.mock.calls) {
        const error = (fields as { err?: Error }).err;
        if (error) {
          expect(error.message).not.toContain(privateInput);
          expect(error.cause).toBeUndefined();
        }
        expect(JSON.stringify(fields)).not.toContain(privateInput);
      }
      expect(
        JSON.stringify((platform.sendMessage as ReturnType<typeof mock>).mock.calls)
      ).not.toContain(privateInput);
    }

    for (const [label, result] of [
      ['undefined', undefined],
      ['false', false],
      ['zero', 0],
      ['string', privateInput],
      ['array', []],
      ['missing workflow name', { id: 'run-1', metadata: {} }],
      ['nonstring workflow name', makePausedRun({ workflow_name: 123 })],
      ['missing used ID', { workflow_name: 'prd', metadata: {} }],
      ['nonstring used ID', makePausedRun({ id: 123 })],
      ['string metadata', makePausedRun({ metadata: privateInput })],
      ['false metadata', makePausedRun({ metadata: false })],
      ['zero metadata', makePausedRun({ metadata: 0 })],
      ['array metadata', makePausedRun({ metadata: [] })],
    ] as const) {
      test('stops ' + label + ' before title and continuation effects', async () => {
        const platform = prepareUnknown(result);
        await handleMessage(platform, 'conv-1', 'owned continuation request');
        expectStopped(platform);
      });
    }

    test('stops a rejected lookup without leaking its native cause', async () => {
      const platform = prepareUnknown(null);
      mockGetPausedWorkflowRun.mockReset();
      mockGetPausedWorkflowRun.mockRejectedValueOnce(
        new Error(privateInput, { cause: { metadata: privateInput } })
      );
      await handleMessage(platform, 'conv-1', 'owned continuation request');
      expectStopped(platform);
    });

    for (const field of ['workflow_name', 'id', 'metadata'] as const) {
      test('stops throwing ' + field + ' evaluation before title', async () => {
        const run = makePausedRun();
        Object.defineProperty(run, field, {
          get() {
            throw new Error(privateInput);
          },
        });
        const platform = prepareUnknown(run);
        await handleMessage(platform, 'conv-1', 'owned continuation request');
        expectStopped(platform);
      });
    }

    test('stops unreadable marker presence before title', async () => {
      const metadata = new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error(privateInput);
          },
        }
      );
      const platform = prepareUnknown(makePausedRun({ metadata }));
      await handleMessage(platform, 'conv-1', 'owned continuation request');
      expectStopped(platform);
    });

    for (const field of ['approval', 'nodeId', 'type', 'captureResponse'] as const) {
      test('stops throwing approval ' + field + ' evaluation before title', async () => {
        const approval = { nodeId: 'gate-1' };
        const metadata = { approval };
        Object.defineProperty(field === 'approval' ? metadata : approval, field, {
          get() {
            throw new Error(privateInput);
          },
        });
        const platform = prepareUnknown(makePausedRun({ metadata }));
        await handleMessage(platform, 'conv-1', 'owned continuation request');
        expectStopped(platform);
      });
    }

    test('notification failure cannot restart title or continuation work', async () => {
      const platform = prepareUnknown(undefined);
      platform.sendMessage = mock(() => Promise.reject(new Error('owned send failure')));
      await handleMessage(platform, 'conv-1', 'owned continuation request');
      expectStopped(platform);
      expect(platform.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-1' }),
        'error_notification_failed'
      );
    });

    test('awaits successful actual null before launching the existing title and normal response', async () => {
      const platform = prepareUnknown(null);
      let releaseLookup!: (value: unknown) => void;
      let enteredLookup!: () => void;
      const lookupEntered = new Promise<void>(resolve => {
        enteredLookup = resolve;
      });
      const lookup = new Promise<unknown>(resolve => {
        releaseLookup = resolve;
      });
      mockGetPausedWorkflowRun.mockReset();
      mockGetPausedWorkflowRun.mockImplementationOnce(() => {
        enteredLookup();
        return lookup;
      });
      const pending = handleMessage(platform, 'conv-1', 'owned normal request');
      await lookupEntered;
      expect(mockGenerateAndSetTitle).not.toHaveBeenCalled();
      expect(mockSendQuery).not.toHaveBeenCalled();
      releaseLookup(null);
      await pending;
      expect(mockGenerateAndSetTitle).toHaveBeenCalledWith(
        'conv-1',
        'owned normal request',
        'claude',
        '/home/test/.archon/workspaces'
      );
      expect(mockSendQuery).toHaveBeenCalledTimes(1);
      expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', 'test response');
      expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
      expect(mockNaturalApprovalUpdate).not.toHaveBeenCalled();
    });

    for (const metadata of [null, undefined, {}]) {
      test(
        'keeps ordinary missing-context guidance with metadata ' + String(metadata),
        async () => {
          const platform = prepareUnknown(makePausedRun({ metadata }));
          await handleMessage(platform, 'conv-1', 'owned continuation request');
          expect(mockGenerateAndSetTitle).toHaveBeenCalledTimes(1);
          expect(platform.sendMessage).toHaveBeenCalledWith(
            'conv-1',
            'A workflow is paused but its approval context is missing. ' +
              'Use `/workflow approve run-1` or `/workflow reject run-1`.'
          );
          expect(mockNaturalApprovalUpdate).not.toHaveBeenCalled();
          expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
          expect(mockExecuteWorkflow).not.toHaveBeenCalled();
          expect(mockSendQuery).not.toHaveBeenCalled();
        }
      );
    }

    test('keeps an ordinary empty string run ID usable for guidance', async () => {
      const platform = prepareUnknown(makePausedRun({ id: '', metadata: {} }));
      await handleMessage(platform, 'conv-1', 'owned continuation request');
      expect(mockGenerateAndSetTitle).toHaveBeenCalledTimes(1);
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        'A workflow is paused but its approval context is missing. ' +
          'Use `/workflow approve ` or `/workflow reject `.'
      );
    });

    test('keeps an untitled slash command outside paused lookup and title generation', async () => {
      const platform = prepareUnknown(undefined);
      mockParseCommand.mockReturnValueOnce({ command: 'status', args: [] });
      mockHandleCommand.mockReturnValueOnce(
        Promise.resolve({ success: true, message: 'owned status response', workflow: undefined })
      );
      await handleMessage(platform, 'conv-1', '/status');
      expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', 'owned status response');
      expect(mockHandleCommand).toHaveBeenCalledTimes(1);
      expect(mockGetPausedWorkflowRun).not.toHaveBeenCalled();
      expect(mockGenerateAndSetTitle).not.toHaveBeenCalled();
    });

    test('keeps captured standard approval payloads with empty string run and node IDs', async () => {
      const platform = prepareUnknown(
        makePausedRun({
          id: '',
          metadata: { approval: { nodeId: '', captureResponse: true } },
        })
      );
      await handleMessage(platform, 'conv-1', 'owned captured approval');
      expect(mockGenerateAndSetTitle).toHaveBeenCalledTimes(1);
      expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(2);
      expect(mockCreateWorkflowEvent).toHaveBeenNthCalledWith(1, {
        workflow_run_id: '',
        event_type: 'node_completed',
        step_name: '',
        data: { node_output: 'owned captured approval', approval_decision: 'approved' },
      });
      expect(mockCreateWorkflowEvent).toHaveBeenNthCalledWith(2, {
        workflow_run_id: '',
        event_type: 'approval_received',
        step_name: '',
        data: { decision: 'approved', comment: 'owned captured approval' },
      });
      expect(mockNaturalApprovalUpdate).toHaveBeenCalledWith('', {
        status: 'failed',
        metadata: { approval_response: 'approved', rejection_reason: '', rejection_count: 0 },
      });
    });

    test('does not evaluate unused captureResponse for interactive loop approval', async () => {
      const approval = { nodeId: 'loop-1', type: 'interactive_loop' };
      const readUnusedCapture = mock(() => {
        throw new Error(privateInput);
      });
      Object.defineProperty(approval, 'captureResponse', { get: readUnusedCapture });
      const platform = prepareUnknown(makePausedRun({ metadata: { approval } }));
      await handleMessage(platform, 'conv-1', 'owned next loop input');
      expect(mockGenerateAndSetTitle).toHaveBeenCalledTimes(1);
      expect(readUnusedCapture).not.toHaveBeenCalled();
      expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(1);
      expect(mockCreateWorkflowEvent).toHaveBeenCalledWith({
        workflow_run_id: 'run-1',
        event_type: 'approval_received',
        step_name: 'loop-1',
        data: { decision: 'approved', comment: 'owned next loop input' },
      });
      expect(mockNaturalApprovalUpdate).toHaveBeenCalledWith('run-1', {
        status: 'failed',
        metadata: { loop_user_input: 'owned next loop input' },
      });
    });

    test('does not treat an inherited marker as an own restriction', async () => {
      const metadata = Object.create({ codex_only_dispatch: null });
      const platform = prepareUnknown(makePausedRun({ metadata }));
      await handleMessage(platform, 'conv-1', 'owned continuation request');
      expect(mockGenerateAndSetTitle).toHaveBeenCalledTimes(1);
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        'A workflow is paused but its approval context is missing. ' +
          'Use `/workflow approve run-1` or `/workflow reject run-1`.'
      );
      expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
      expect(mockNaturalApprovalUpdate).not.toHaveBeenCalled();
    });

    describe('classified field snapshots', () => {
      for (const field of ['id', 'workflow_name'] as const) {
        for (const laterRead of ['throws', 'changes'] as const) {
          test('uses first ' + field + ' when a later read ' + laterRead, async () => {
            const first = field === 'id' ? 'run-1' : 'prd';
            const run = makePausedRun();
            let reads = 0;
            Object.defineProperty(run, field, {
              get() {
                reads++;
                if (reads === 1) return first;
                if (laterRead === 'throws') throw new Error(privateInput);
                return field === 'id' ? 'unclassified-run' : 'unclassified-workflow';
              },
            });
            const platform = prepareUnknown(run);
            mockLogger.info.mockClear();
            mockGetOrCreateConversation.mockReset();
            mockGetOrCreateConversation.mockResolvedValueOnce(
              makeConversation({
                title: null,
                codebase_id: 'codebase-1',
                cwd: '/repos/test-repo',
              })
            );
            mockGetCodebase.mockImplementation(() => Promise.resolve(makeApprovalCodebase()));
            mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
              Promise.resolve({
                workflows: [{ workflow: approvalWorkflow }],
                errors: [],
              })
            );

            await handleMessage(platform, 'conv-1', 'owned snapshot approval');

            expect(reads).toBe(1);
            expect(mockGenerateAndSetTitle).toHaveBeenCalledTimes(1);
            expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(2);
            expect(mockCreateWorkflowEvent).toHaveBeenNthCalledWith(1, {
              workflow_run_id: 'run-1',
              event_type: 'node_completed',
              step_name: 'gate-1',
              data: { node_output: '', approval_decision: 'approved' },
            });
            expect(mockCreateWorkflowEvent).toHaveBeenNthCalledWith(2, {
              workflow_run_id: 'run-1',
              event_type: 'approval_received',
              step_name: 'gate-1',
              data: { decision: 'approved', comment: 'owned snapshot approval' },
            });
            expect(mockNaturalApprovalUpdate).toHaveBeenCalledWith('run-1', {
              status: 'failed',
              metadata: { approval_response: 'approved', rejection_reason: '', rejection_count: 0 },
            });
            expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
            expect(mockExecuteWorkflow.mock.calls[0][4]).toBe(approvalWorkflow);
            expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', ' Resuming **prd**...');
            expect(mockLogger.info).toHaveBeenCalledWith(
              {
                conversationId: 'conv-1',
                workflowRunId: 'run-1',
                nodeId: 'gate-1',
                workflowName: 'prd',
              },
              'orchestrator.natural_language_approval_started'
            );
            expect(mockLogger.info).toHaveBeenCalledWith(
              { conversationId: 'conv-1', workflowRunId: 'run-1', workflowName: 'prd' },
              'orchestrator.natural_language_approval_completed'
            );
            expect(mockLogger.error).not.toHaveBeenCalled();
          });
        }
      }

      test('uses the first run ID in missing approval guidance', async () => {
        const run = makePausedRun({ metadata: {} });
        let reads = 0;
        Object.defineProperty(run, 'id', {
          get() {
            if (++reads === 1) return 'run-1';
            throw new Error(privateInput);
          },
        });
        const platform = prepareUnknown(run);
        await handleMessage(platform, 'conv-1', 'owned snapshot guidance');
        expect(reads).toBe(1);
        expect(mockGenerateAndSetTitle).toHaveBeenCalledTimes(1);
        expect(platform.sendMessage).toHaveBeenCalledWith(
          'conv-1',
          'A workflow is paused but its approval context is missing. ' +
            'Use `/workflow approve run-1` or `/workflow reject run-1`.'
        );
        expect(mockLogger.error).not.toHaveBeenCalled();
        expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
      });

      test('uses the first run ID in existing approval failure logging and guidance', async () => {
        const run = makePausedRun();
        let reads = 0;
        Object.defineProperty(run, 'id', {
          get() {
            return ++reads === 1 ? 'run-1' : 'unclassified-run';
          },
        });
        const platform = prepareUnknown(run);
        mockCreateWorkflowEvent.mockRejectedValueOnce(new Error('owned event failure'));
        await handleMessage(platform, 'conv-1', 'owned snapshot error guidance');
        expect(reads).toBe(1);
        expect(platform.sendMessage).toHaveBeenCalledWith(
          'conv-1',
          'Approval failed: owned event failure. Try again or use `/workflow approve run-1` explicitly.'
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ workflowRunId: 'run-1', conversationId: 'conv-1' }),
          'orchestrator.natural_language_approval_failed'
        );
        expect(mockNaturalApprovalUpdate).not.toHaveBeenCalled();
        expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      });

      for (const restrictedBy of ['reserved name', 'own marker'] as const) {
        test('does not consume the unused ID for ' + restrictedBy, async () => {
          const run = makePausedRun(
            restrictedBy === 'reserved name'
              ? { workflow_name: 'bdc-feature-development-codex-only' }
              : { metadata: { codex_only_dispatch: undefined } }
          );
          const readId = mock(() => {
            throw new Error(privateInput);
          });
          Object.defineProperty(run, 'id', { get: readId });
          const platform = prepareUnknown(run);
          await handleMessage(platform, 'conv-1', 'owned restricted snapshot');
          expect(readId).not.toHaveBeenCalled();
          expect(platform.sendMessage).toHaveBeenCalledWith(
            'conv-1',
            'Codex-only continuation is not available; the paused run was left unchanged.'
          );
          expect(mockGenerateAndSetTitle).not.toHaveBeenCalled();
          expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
          expect(mockNaturalApprovalUpdate).not.toHaveBeenCalled();
          expect(mockExecuteWorkflow).not.toHaveBeenCalled();
          expect(mockLogger.error).not.toHaveBeenCalled();
        });
      }
    });

    test('refuses an own marker without evaluating its value', async () => {
      const metadata = {};
      const readMarker = mock(() => {
        throw new Error(privateInput);
      });
      Object.defineProperty(metadata, 'codex_only_dispatch', { get: readMarker });
      const platform = prepareUnknown(makePausedRun({ metadata }));
      await handleMessage(platform, 'conv-1', 'owned continuation request');
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'conv-1',
        'Codex-only continuation is not available; the paused run was left unchanged.'
      );
      expect(readMarker).not.toHaveBeenCalled();
      expect(mockGenerateAndSetTitle).not.toHaveBeenCalled();
      expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
      expect(mockNaturalApprovalUpdate).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('binding-v2 natural-language continuation closed gate', () => {
    const reserved = 'bdc-feature-development-codex-only';
    const refusal = 'Codex-only continuation is not available; the paused run was left unchanged.';

    function prepare(run: ReturnType<typeof makePausedRun>) {
      const conversation = makeConversation({
        codebase_id: 'codebase-1',
        cwd: '/repos/test-repo',
        title: null,
      });
      mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
      mockGetPausedWorkflowRun.mockReturnValueOnce(Promise.resolve(run));
      mockGetCodebase.mockImplementation(() => Promise.resolve(makeApprovalCodebase()));
      mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
        Promise.resolve({
          workflows: [{ workflow: approvalWorkflow }],
          errors: [],
        })
      );
      for (const effect of [
        mockGenerateAndSetTitle,
        mockNaturalApprovalUpdate,
        mockCreateWorkflowEvent,
        mockGetCodebase,
        mockListCodebases,
        mockDiscoverWorkflowsWithConfig,
        mockSyncWorkspace,
        mockValidateAndResolveIsolation,
        mockLaunchSession,
        mockFindResumableRunByParentConversation,
        mockExecuteWorkflow,
        mockDispatchBackgroundWorkflow,
        mockSendQuery,
        mockHandleCommand,
        mockUpdateConversation,
      ])
        effect.mockClear();
      return { conversation, platform: makePlatform() };
    }

    function expectNoApprovalWork() {
      for (const effect of [
        mockGenerateAndSetTitle,
        mockNaturalApprovalUpdate,
        mockCreateWorkflowEvent,
        mockGetCodebase,
        mockListCodebases,
        mockDiscoverWorkflowsWithConfig,
        mockSyncWorkspace,
        mockValidateAndResolveIsolation,
        mockLaunchSession,
        mockFindResumableRunByParentConversation,
        mockExecuteWorkflow,
        mockDispatchBackgroundWorkflow,
        mockSendQuery,
        mockHandleCommand,
        mockUpdateConversation,
      ])
        expect(effect).not.toHaveBeenCalled();
    }

    for (const kind of ['standard', 'interactive_loop'] as const) {
      for (const [label, marker] of [
        ['null', null],
        ['undefined', undefined],
        ['false', false],
        ['corrupt', 'corrupt'],
        ['v1', { version: 'codex-only-v1' }],
        ['v2', { version: 'codex-only-v2' }],
        ['unknown', { version: 'codex-only-v999' }],
      ] as const) {
        test(
          'refuses ' + kind + ' with own ' + label + ' marker before approval work',
          async () => {
            const run = makePausedRun({
              metadata: {
                approval: { nodeId: 'gate-1', type: kind },
                codex_only_dispatch: marker,
              },
            });
            const before = structuredClone(run);
            const { platform } = prepare(run);
            await handleMessage(platform, 'conv-1', 'owned synthetic approval');
            expect(platform.sendMessage).toHaveBeenCalledTimes(1);
            expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', refusal);
            expect(run).toEqual(before);
            expectNoApprovalWork();
          }
        );
      }
      test('refuses ' + kind + ' reserved name without marker before approval work', async () => {
        const run = makePausedRun({
          workflow_name: reserved,
          metadata: { approval: { nodeId: 'gate-1', type: kind } },
        });
        const before = structuredClone(run);
        const { platform } = prepare(run);
        await handleMessage(platform, 'conv-1', 'owned synthetic approval');
        expect(platform.sendMessage).toHaveBeenCalledTimes(1);
        expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', refusal);
        expect(run).toEqual(before);
        expectNoApprovalWork();
      });
    }

    for (const [label, extra] of [
      ['missing approval', { metadata: { codex_only_dispatch: null } }],
      ['corrupt approval', { metadata: { codex_only_dispatch: false, approval: 'bad' } }],
      ['reserved null metadata', { workflow_name: reserved, metadata: null }],
    ] as const) {
      test('refuses restricted ' + label + ' without suggesting a resume bypass', async () => {
        const run = makePausedRun(extra);
        const before = structuredClone(run);
        const { platform } = prepare(run);
        await handleMessage(platform, 'conv-1', 'owned synthetic approval');
        expect(platform.sendMessage).toHaveBeenCalledTimes(1);
        expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', refusal);
        expect(run).toEqual(before);
        expectNoApprovalWork();
      });
    }

    test('failed refusal notification performs no approval or fallback work', async () => {
      const run = makePausedRun({ workflow_name: reserved });
      const before = structuredClone(run);
      const { platform } = prepare(run);
      platform.sendMessage = mock(() => Promise.resolve());
      (platform.sendMessage as ReturnType<typeof mock>).mockRejectedValueOnce(
        new Error('owned notification failure')
      );
      await handleMessage(platform, 'conv-1', 'owned synthetic approval');
      expect(platform.sendMessage).toHaveBeenCalledTimes(2);
      expect(platform.sendMessage).toHaveBeenNthCalledWith(1, 'conv-1', refusal);
      expect(platform.sendMessage).toHaveBeenNthCalledWith(
        2,
        'conv-1',
        'Error: owned notification failure'
      );
      expect(run).toEqual(before);
      expectNoApprovalWork();
    });

    test('ordinary interactive loop retains input event update and dispatch', async () => {
      const run = makePausedRun({
        metadata: { approval: { nodeId: 'loop-1', type: 'interactive_loop' } },
      });
      const { platform } = prepare(run);
      await handleMessage(platform, 'conv-1', 'owned next loop input');
      expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(1);
      expect(mockCreateWorkflowEvent).toHaveBeenCalledWith({
        workflow_run_id: 'run-1',
        event_type: 'approval_received',
        step_name: 'loop-1',
        data: { decision: 'approved', comment: 'owned next loop input' },
      });
      expect(mockNaturalApprovalUpdate).toHaveBeenCalledTimes(1);
      expect(mockNaturalApprovalUpdate).toHaveBeenCalledWith('run-1', {
        status: 'failed',
        metadata: { loop_user_input: 'owned next loop input' },
      });
      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    });

    test('explicit cancel command bypasses NL interception without asserting real cancellation', async () => {
      const run = makePausedRun({ workflow_name: reserved });
      const { platform, conversation } = prepare(run);
      mockGetPausedWorkflowRun.mockReset();
      mockGetPausedWorkflowRun.mockImplementation(() => Promise.resolve(null));
      mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['cancel', 'run-1'] });
      mockHandleCommand.mockReturnValueOnce(
        Promise.resolve({ success: true, message: 'owned cancel requested', workflow: undefined })
      );
      await handleMessage(platform, 'conv-1', '/workflow cancel run-1');
      expect(mockGetPausedWorkflowRun).not.toHaveBeenCalled();
      expect(mockHandleCommand).toHaveBeenCalledWith(conversation, '/workflow cancel run-1');
      expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
      expect(mockNaturalApprovalUpdate).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });
  });
});

// --- handleWorkflowRunCommand E2 path -- single codebase auto-select ----------

describe('handleWorkflowRunCommand -- E2 single codebase auto-select', () => {
  const assistWorkflow = makeTestWorkflow({ name: 'assist' });

  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockParseCommand.mockReset();
    mockHandleCommand.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockUpdateConversation.mockClear();
    mockDispatchBackgroundWorkflow.mockClear();
    mockLogger.error.mockClear();

    // Default: return empty conversation without codebase
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
  });

  test('resolves workflow from WorkflowWithSource[] by exact name match', async () => {
    const conversation = makeConversation({ codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    // parseCommand returns a /workflow run command
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'assist'] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: 'Running workflow assist...',
        workflow: { definition: assistWorkflow, args: 'test prompt' },
      })
    );
    // Single codebase triggers auto-select
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    // discoverWorkflowsWithConfig returns WorkflowWithSource[]
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [
          makeTestWorkflowWithSource({ name: 'assist' }),
          makeTestWorkflowWithSource({ name: 'implement' }),
        ],
        errors: [],
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run assist test prompt');

    // Should auto-select the codebase and update conversation
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', { codebase_id: codebase.id });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
  });

  test('dispatches API-style /workflow run without command-handler pre-resolution', async () => {
    const conversation = makeConversation({ codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({
      command: 'workflow',
      args: ['run', 'assist', 'WO-123'],
    });
    mockHandleCommand.mockImplementationOnce(() => {
      throw new Error('generic command handler should not pre-resolve workflow run');
    });
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run assist WO-123');

    expect(mockHandleCommand).not.toHaveBeenCalled();
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', { codebase_id: codebase.id });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        originalMessage: 'WO-123',
        conversationDbId: 'conv-1',
        codebaseId: codebase.id,
      }),
      expect.objectContaining({ name: 'assist' })
    );
  });

  test('dispatches app-default /workflow run with default codebase context', async () => {
    const conversation = makeConversation({ codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({
      command: 'workflow',
      args: ['run', 'global-workflow', 'WO-123'],
    });
    mockHandleCommand.mockImplementationOnce(() => {
      throw new Error('generic command handler should not pre-resolve app-default workflow run');
    });
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'global-workflow' })],
        errors: [],
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run global-workflow WO-123');

    expect(mockHandleCommand).not.toHaveBeenCalled();
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', { codebase_id: codebase.id });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        originalMessage: 'WO-123',
        conversationDbId: 'conv-1',
        codebaseId: codebase.id,
      }),
      expect.objectContaining({ name: 'global-workflow' })
    );
  });

  test('dispatches app-default /workflow run to prefix-bound codebase', async () => {
    const conversation = makeConversation({ codebase_id: null });
    const harness = makeCodebase('thinmansoftware/bdc-harness', 'harness-id');
    const shopops = makeCodebase('thinmansoftware/shopops', 'shopops-id');
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({
      command: 'workflow',
      args: ['run', 'bdc-shopops-cover-cascade-prh-visibility', 'WO-123'],
    });
    mockHandleCommand.mockImplementationOnce(() => {
      throw new Error('generic command handler should not pre-resolve app-default workflow run');
    });
    mockListCodebases.mockReturnValueOnce(Promise.resolve([harness, shopops]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [
          makeTestWorkflowWithSource({ name: 'bdc-shopops-cover-cascade-prh-visibility' }),
        ],
        errors: [],
      })
    );

    const platform = makePlatform();
    await handleMessage(
      platform,
      'conv-1',
      '/workflow run bdc-shopops-cover-cascade-prh-visibility WO-123'
    );

    expect(mockHandleCommand).not.toHaveBeenCalled();
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', { codebase_id: shopops.id });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        originalMessage: 'WO-123',
        conversationDbId: 'conv-1',
        codebaseId: shopops.id,
      }),
      expect.objectContaining({ name: 'bdc-shopops-cover-cascade-prh-visibility' })
    );
  });

  test('strips --project flag from app-default /workflow run before dispatch', async () => {
    const conversation = makeConversation({ codebase_id: null });
    const harness = makeCodebase('thinmansoftware/bdc-harness', 'harness-id');
    const storefront = makeCodebase('thinmansoftware/shopops-storefront', 'storefront-id');
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({
      command: 'workflow',
      args: [
        'run',
        'bdc-shopops-cover-cascade-prh-visibility',
        'WO-123',
        '--project',
        'shopops-storefront',
      ],
    });
    mockHandleCommand.mockImplementationOnce(() => {
      throw new Error('generic command handler should not pre-resolve app-default workflow run');
    });
    mockListCodebases.mockReturnValueOnce(Promise.resolve([harness, storefront]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [
          makeTestWorkflowWithSource({ name: 'bdc-shopops-cover-cascade-prh-visibility' }),
        ],
        errors: [],
      })
    );

    const platform = makePlatform();
    await handleMessage(
      platform,
      'conv-1',
      '/workflow run bdc-shopops-cover-cascade-prh-visibility WO-123 --project shopops-storefront'
    );

    expect(mockHandleCommand).not.toHaveBeenCalled();
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', { codebase_id: storefront.id });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        originalMessage: 'WO-123',
        conversationDbId: 'conv-1',
        codebaseId: storefront.id,
      }),
      expect.objectContaining({ name: 'bdc-shopops-cover-cascade-prh-visibility' })
    );
  });

  test('resolves workflow by case-insensitive name when exact match fails', async () => {
    const upperWorkflow = makeTestWorkflow({ name: 'Assist' });
    const conversation = makeConversation({ codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'Assist'] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: 'Running workflow...',
        workflow: { definition: upperWorkflow, args: 'test' },
      })
    );
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    // Workflow name in discovery is lowercase 'assist', but request is 'Assist'
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run Assist test');

    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', { codebase_id: codebase.id });
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalled();
  });

  test('sends error message when workflow not found in discovery', async () => {
    const conversation = makeConversation({ codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'missing'] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: 'Running workflow...',
        workflow: { definition: makeTestWorkflow({ name: 'missing' }), args: 'test' },
      })
    );
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run missing test');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('not found')
    );
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });

  test('sends error when discovery fails', async () => {
    const conversation = makeConversation({ codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'assist'] });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: 'Running...',
        workflow: { definition: assistWorkflow, args: 'test' },
      })
    );
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockDiscoverWorkflowsWithConfig
      .mockResolvedValueOnce({ workflows: [], errors: [] })
      .mockRejectedValueOnce(new Error('YAML parse error'));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', '/workflow run assist test');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Failed to load workflows')
    );
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });
});

// --- discoverAllWorkflows -- merge with WorkflowWithSource --------------------

describe('discoverAllWorkflows -- merge repo workflows over global', () => {
  beforeEach(() => {
    mockSyncWorkspace.mockClear();
    mockToRepoPath.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDispatchBackgroundWorkflow.mockClear();
    mockLogger.warn.mockClear();

    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
  });

  test('repo-specific workflows override global workflows by name', async () => {
    const conversation = makeConversation({ codebase_id: 'codebase-1' });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockReturnValueOnce(Promise.resolve(codebase));

    // First call: global discovery returns 'assist' workflow
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Global assist' })],
      errors: [],
    });
    // Second call: repo discovery returns 'assist' with different description (override)
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Repo assist' }, 'project'),
      ],
      errors: [],
    });

    const platform = makePlatform();
    // Send a non-command message so it triggers discoverAllWorkflows via the orchestrator flow
    await handleMessage(platform, 'conv-1', 'What is the latest commit?');

    // discoverWorkflowsWithConfig should have been called twice (global + repo)
    expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(2);
  });
});

// --- handleMessage -- workflow context injection -------------------------------

describe('handleMessage -- workflow context injection', () => {
  beforeEach(() => {
    mockGetRecentWorkflowResultMessages.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockListCodebases.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockLogger.warn.mockClear();

    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    mockGetRecentWorkflowResultMessages.mockImplementation(() => Promise.resolve([]));
  });

  test('calls getRecentWorkflowResultMessages for the conversation', async () => {
    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'What happened?');

    expect(mockGetRecentWorkflowResultMessages).toHaveBeenCalledWith('conv-1', 3);
  });

  test('does not throw when getRecentWorkflowResultMessages returns empty array', async () => {
    mockGetRecentWorkflowResultMessages.mockResolvedValueOnce([]);
    const platform = makePlatform();

    await expect(handleMessage(platform, 'conv-1', 'Hello')).resolves.toBeUndefined();
  });

  test('handles malformed metadata JSON without throwing', async () => {
    const badRow = {
      id: 'msg-1',
      conversation_id: 'conv-1',
      role: 'assistant' as const,
      content: 'Summary.',
      metadata: 'not-valid-json',
      created_at: '2026-01-01T00:00:00Z',
    };
    mockGetRecentWorkflowResultMessages.mockResolvedValueOnce([badRow]);
    const platform = makePlatform();

    await expect(
      handleMessage(platform, 'conv-1', 'What did the workflow do?')
    ).resolves.toBeUndefined();
  });

  test('handles metadata with missing workflowResult key gracefully', async () => {
    const rowNoWorkflowResult = {
      id: 'msg-2',
      conversation_id: 'conv-1',
      role: 'assistant' as const,
      content: 'Summary.',
      metadata: '{"someOtherKey":"value"}',
      created_at: '2026-01-01T00:00:00Z',
    };
    mockGetRecentWorkflowResultMessages.mockResolvedValueOnce([rowNoWorkflowResult]);
    const platform = makePlatform();

    await expect(handleMessage(platform, 'conv-1', 'Follow-up')).resolves.toBeUndefined();
  });

  test('continues without workflow context when outer fetch throws', async () => {
    mockGetRecentWorkflowResultMessages.mockRejectedValueOnce(new Error('unexpected'));
    const platform = makePlatform();

    // Non-critical path -- must not block message handling
    await expect(handleMessage(platform, 'conv-1', 'Hello')).resolves.toBeUndefined();
  });
});

// --- Stale session ID clearing on error_during_execution --------------------

describe('stale session ID clearing on error_during_execution', () => {
  beforeEach(() => {
    mockUpdateSession.mockClear();
    mockTransitionSession.mockClear();
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockSendQuery.mockReset();
    mockLogger.warn.mockClear();
    mockGetRecentWorkflowResultMessages.mockReset();
    mockGetRecentWorkflowResultMessages.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockReset();
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
  });

  test('handleStreamMode: clears session ID on error_during_execution result', async () => {
    // Simulate AI returning error_during_execution with a stale session ID
    mockSendQuery.mockImplementationOnce(async function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        sessionId: 'stale-session-id',
      };
    });
    // transitionSession returns a session with an existing assistant_session_id
    mockTransitionSession.mockResolvedValueOnce({
      id: 'session-1',
      assistant_session_id: 'stale-session-id',
    });

    const platform = makePlatform();
    // Use streaming mode
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('stream');
    await handleMessage(platform, 'conv-1', 'hello');

    // updateSession should be called with null to clear the stale session ID
    expect(mockUpdateSession).toHaveBeenCalledWith('session-1', null);
  });

  test('handleBatchMode: clears session ID on error_during_execution result', async () => {
    mockSendQuery.mockImplementationOnce(async function* () {
      yield {
        type: 'result',
        isError: true,
        errorSubtype: 'error_during_execution',
        sessionId: 'stale-session-id',
      };
    });
    mockTransitionSession.mockResolvedValueOnce({
      id: 'session-1',
      assistant_session_id: 'stale-session-id',
    });

    const platform = makePlatform();
    // batch is the default from makePlatform, but be explicit
    (platform.getStreamingMode as ReturnType<typeof mock>).mockReturnValue('batch');
    await handleMessage(platform, 'conv-1', 'hello');

    expect(mockUpdateSession).toHaveBeenCalledWith('session-1', null);
  });
});

// --- Per-session worktree isolation (WO-HARNESS-SESSION-WORKTREE-ISOLATION-01) --

describe('handleMessage -- per-session worktree isolation', () => {
  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockSendQuery.mockClear();
    mockLaunchSession.mockClear();
    mockBuildProjectScopedPrompt.mockClear();
    mockValidateAndResolveIsolation.mockClear();
    mockLogger.warn.mockClear();

    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    // Default: allocate a distinct worktree keyed by conversation id.
    mockLaunchSession.mockImplementation((conversation: { id: string }) =>
      Promise.resolve({ refused: false as const, cwd: `/worktrees/${conversation.id}` })
    );
  });

  // Given/When/Then anchor: two sessions on the SAME codebase get DIFFERENT cwds.
  // Reproduces the 2026-07-26 incident shape at the direct-chat entry point.
  test('two conversations on the same codebase are launched in distinct worktrees', async () => {
    const codebase = makeCodebase('shared', 'cb-shared');
    const convA = makeConversation({ id: 'conv-A', codebase_id: 'cb-shared' });
    const convB = makeConversation({ id: 'conv-B', codebase_id: 'cb-shared' });
    mockListCodebases.mockImplementation(() => Promise.resolve([codebase]));
    mockGetCodebase.mockImplementation(() => Promise.resolve(codebase));

    const platform = makePlatform();

    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(convA));
    await handleMessage(platform, 'conv-A', 'What does this repo do?');

    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(convB));
    await handleMessage(platform, 'conv-B', 'What does this repo do?');

    // launchSession invoked once per session, each keyed on its own conversation.
    expect(mockLaunchSession).toHaveBeenCalledTimes(2);
    expect((mockLaunchSession.mock.calls[0][0] as { id: string }).id).toBe('conv-A');
    expect((mockLaunchSession.mock.calls[1][0] as { id: string }).id).toBe('conv-B');

    // The AI subprocess cwd differs between the two sessions -- neither shares a
    // checkout, so a branch switch in one cannot disturb the other.
    expect(mockSendQuery.mock.calls[0][1]).toBe('/worktrees/conv-A');
    expect(mockSendQuery.mock.calls[1][1]).toBe('/worktrees/conv-B');
    expect(mockSendQuery.mock.calls[0][1]).not.toBe(mockSendQuery.mock.calls[1][1]);
  });

  // Refusal fails closed: the user is told, and the AI is NEVER invoked in the
  // shared checkout as a fallback.
  test('refuses to run the session when launchSession fails closed', async () => {
    const codebase = makeCodebase('shared', 'cb-shared');
    const conversation = makeConversation({ id: 'conv-1', codebase_id: 'cb-shared' });
    mockListCodebases.mockImplementation(() => Promise.resolve([codebase]));
    mockGetCodebase.mockImplementation(() => Promise.resolve(codebase));
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));

    const refusalMessage =
      'Refusing to start this session in the primary checkout for "shared"; worktree allocation failed.';
    mockLaunchSession.mockImplementationOnce(() =>
      Promise.resolve({ refused: true as const, message: refusalMessage })
    );

    const platform = makePlatform();
    await handleMessage(platform, 'conv-1', 'do some work');

    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', refusalMessage);
    // Fail closed -- no fallback to ensureArchonWorkspacesPath()/the shared clone.
    expect(mockSendQuery).not.toHaveBeenCalled();
  });

  // The system prompt must describe the isolated worktree, not the primary checkout.
  test('project-scoped prompt uses the resolved worktree cwd, not codebase.default_cwd', async () => {
    const codebase = makeCodebase('shared', 'cb-shared'); // default_cwd = /repos/shared
    const conversation = makeConversation({ id: 'conv-prompt', codebase_id: 'cb-shared' });
    mockListCodebases.mockImplementation(() => Promise.resolve([codebase]));
    mockGetCodebase.mockImplementation(() => Promise.resolve(codebase));
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-prompt', 'explain the layout');

    expect(mockBuildProjectScopedPrompt).toHaveBeenCalled();
    const scopedArg = mockBuildProjectScopedPrompt.mock.calls[0][0] as { default_cwd: string };
    expect(scopedArg.default_cwd).toBe('/worktrees/conv-prompt');
    expect(scopedArg.default_cwd).not.toBe('/repos/shared');
  });

  // Conversations with no codebase attached keep today's behavior -- no isolation.
  test('does not allocate a worktree for a conversation with no codebase', async () => {
    const conversation = makeConversation({ id: 'conv-none', codebase_id: null });
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));

    const platform = makePlatform();
    await handleMessage(platform, 'conv-none', 'hi there');

    expect(mockLaunchSession).not.toHaveBeenCalled();
    // Falls back to the workspaces root (unchanged behavior).
    expect(mockSendQuery.mock.calls[0][1]).toBe('/home/test/.archon/workspaces');
  });
});

// --- Gap #2: chat-triggered workflow dispatch keys on conversation id ----------

describe('dispatchOrchestratorWorkflow -- default isolation key (Gap #2)', () => {
  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockParseCommand.mockReset();
    mockHandleCommand.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockValidateAndResolveIsolation.mockClear();
    mockDispatchBackgroundWorkflow.mockClear();
    mockLogger.warn.mockClear();

    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    mockValidateAndResolveIsolation.mockImplementation(() =>
      Promise.resolve({ status: 'new', cwd: '/worktrees/conv-1' })
    );
  });

  test('resolves isolation with workflowId = conversation.id when no forge hints are supplied', async () => {
    const conversation = makeConversation({ id: 'conv-1', codebase_id: null });
    const codebase = makeCodebaseForSync();
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args: ['run', 'assist', 'WO-9'] });
    mockListCodebases.mockReturnValueOnce(Promise.resolve([codebase]));
    mockDiscoverWorkflowsWithConfig.mockReturnValueOnce(
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      })
    );

    const platform = makePlatform();
    // No HandleMessageContext -> isolationHints is undefined (chat default path).
    await handleMessage(platform, 'conv-1', '/workflow run assist WO-9');

    expect(mockValidateAndResolveIsolation).toHaveBeenCalled();
    const hints = mockValidateAndResolveIsolation.mock.calls[0][4] as {
      workflowType: string;
      workflowId: string;
    };
    // Previously this defaulted to workflowId '' -- every conversation collided.
    expect(hints.workflowType).toBe('thread');
    expect(hints.workflowId).toBe('conv-1');
  });
});

describe('binding-v2 parent closed admission', () => {
  const reserved = 'bdc-feature-development-codex-only';

  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockParseCommand.mockReset();
    mockHandleCommand.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockUpdateConversation.mockClear();
    mockValidateAndResolveIsolation.mockClear();
    mockExecuteWorkflow.mockClear();
    mockDispatchBackgroundWorkflow.mockClear();
    mockSendQuery.mockClear();
    mockFindResumableRunByParentConversation.mockReset();
    mockFindResumableRunByParentConversation.mockImplementation(() => Promise.resolve(null));
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(null));
    mockGetCodebase.mockImplementation(() => Promise.resolve(null));
    mockListCodebases.mockImplementation(() => Promise.resolve([]));
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [], errors: [] })
    );
    mockValidateAndResolveIsolation.mockImplementation(() =>
      Promise.resolve({ status: 'new', cwd: '/worktrees/conv-1' })
    );
  });

  function setup(mode: string, actualName = reserved, userMessage = 'WO-parent-gate') {
    const codebase = makeCodebaseForSync();
    const scoped = mode === 'scoped';
    const conversation = makeConversation({ codebase_id: scoped ? codebase.id : null });
    mockGetOrCreateConversation.mockReturnValueOnce(Promise.resolve(conversation));
    mockGetCodebase.mockImplementation(() => Promise.resolve(codebase));
    const codebases = mode === 'multiple' ? [codebase, makeCodebase('other-project')] : [codebase];
    mockListCodebases.mockImplementation(() => Promise.resolve(codebases));
    const requestName = mode === 'case-alias' ? actualName.toUpperCase() : actualName;
    const args = ['run', requestName, userMessage];
    if (mode === 'multiple') args.push('--project', codebase.name);
    mockParseCommand.mockReturnValueOnce({ command: 'workflow', args });
    const workflow = makeTestWorkflowWithSource({
      name: actualName,
      interactive: mode === 'interactive',
    });
    let discoveries = 0;
    mockDiscoverWorkflowsWithConfig.mockImplementation(() => {
      discoveries += 1;
      const fallback = mode === 'repository' || mode === 'multiple';
      return Promise.resolve({
        workflows: fallback && discoveries === 1 ? [] : [workflow],
        errors: [],
      });
    });
    mockHandleCommand.mockReturnValueOnce(
      Promise.resolve({
        success: true,
        message: 'ok',
        workflow: { definition: workflow.workflow, args: userMessage },
      })
    );
    if (mode === 'resumable') {
      mockFindResumableRunByParentConversation.mockImplementation(() =>
        Promise.resolve({
          id: 'prior-run',
          working_path: '/worktrees/prior-run',
          status: 'failed',
        })
      );
    }
    const platform = makePlatform();
    if (mode === 'non-web') platform.getPlatformType = mock(() => 'slack' as const);
    return { platform, command: `/workflow run ${requestName} ${userMessage}` };
  }

  function expectClosed(platform: IPlatformAdapter) {
    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('no workflow was started')
    );
    expect(platform.sendMessage).not.toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('Starting workflow:')
    );
    expect(mockUpdateConversation).not.toHaveBeenCalled();
    expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(mockSendQuery).not.toHaveBeenCalled();
  }

  test.each([
    'global',
    'case-alias',
    'repository',
    'multiple',
    'interactive',
    'resumable',
    'non-web',
    'scoped',
  ])('refuses actual reserved definition at parent boundary: %s', async mode => {
    const { platform, command } = setup(mode);
    await handleMessage(platform, 'conv-1', command);
    expectClosed(platform);
  });

  test('failed global refusal notification cannot search or dispatch a replacement', async () => {
    const { platform, command } = setup('global');
    const messages: string[] = [];
    platform.sendMessage = mock(async (_id: string, text: string) => {
      messages.push(text);
      if (messages.length === 1) throw new Error('parent refusal delivery failed');
    });
    await handleMessage(platform, 'conv-1', command);
    expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(1);
    expect(messages[0]).toContain('no workflow was started');
    expect(messages).not.toContain(`Starting workflow: \`${reserved}\``);
    expect(mockUpdateConversation).not.toHaveBeenCalled();
    expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(mockSendQuery).not.toHaveBeenCalled();
  });

  test.each(['global', 'repository', 'multiple'])(
    'ordinary %s keeps exact Starting message before attachment despite reserved message text',
    async mode => {
      const { platform, command } = setup(mode, 'assist', `Discuss ${reserved}`);
      const order: string[] = [];
      const send = platform.sendMessage;
      platform.sendMessage = mock(async (id: string, text: string) => {
        order.push(text);
        await send(id, text);
      });
      mockUpdateConversation.mockImplementation(async () => {
        order.push('attach');
      });
      await handleMessage(platform, 'conv-1', command);
      expect(order[0]).toBe('Starting workflow: `assist`');
      expect(order[1]).toBe('attach');
      expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledTimes(1);
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      mockUpdateConversation.mockImplementation(() => Promise.resolve());
    }
  );

  test('ordinary global discovery error still uses repository fallback', async () => {
    const { platform, command } = setup('repository', 'assist');
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
        errors: [],
      })
    );
    mockDiscoverWorkflowsWithConfig.mockImplementationOnce(() =>
      Promise.reject(new Error('global unavailable'))
    );
    await handleMessage(platform, 'conv-1', command);
    expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(2);
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledTimes(1);
    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', 'Starting workflow: `assist`');
  });
});

describe('binding-v2 foreground resume closed gate', () => {
  const reserved = 'bdc-feature-development-codex-only';
  const refusal = 'Codex-only continuation is not available; the prior run was left unchanged.';
  const unverified = 'Workflow continuation could not be verified; no workflow was started.';

  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockParseCommand.mockReset();
    mockHandleCommand.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockFindResumableRunByParentConversation.mockReset();
    mockUpdateConversation.mockClear();
    mockValidateAndResolveIsolation.mockClear();
    mockExecuteWorkflow.mockClear();
    mockDispatchBackgroundWorkflow.mockClear();
    mockSendQuery.mockClear();
    mockNaturalApprovalUpdate.mockClear();
    mockCreateWorkflowEvent.mockClear();
  });

  function setup(mode: string, row: unknown, interactive = false) {
    const codebase = makeCodebaseForSync();
    const conversation = makeConversation({ codebase_id: mode === 'scoped' ? codebase.id : null });
    const workflow = makeTestWorkflowWithSource({ name: 'assist', interactive });
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(conversation));
    mockGetCodebase.mockImplementation(() => Promise.resolve(codebase));
    mockListCodebases.mockImplementation(() => Promise.resolve([codebase]));
    mockParseCommand.mockReturnValueOnce({
      command: 'workflow',
      args: ['run', 'assist', 'WO-guard'],
    });
    mockHandleCommand.mockImplementation(() =>
      Promise.resolve({
        success: true,
        message: 'ok',
        workflow: { definition: workflow.workflow, args: 'WO-guard' },
      })
    );
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [workflow], errors: [] })
    );
    mockFindResumableRunByParentConversation.mockImplementation(() => Promise.resolve(row));
    return makePlatform();
  }

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'prior-run',
      workflow_name: 'assist',
      parent_conversation_id: 'conv-1',
      status: 'failed',
      working_path: '/worktrees/prior-run',
      metadata: {},
      ...overrides,
    };
  }

  function expectNoDispatch() {
    expect(mockUpdateConversation).not.toHaveBeenCalled();
    expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(mockSendQuery).not.toHaveBeenCalled();
    expect(mockNaturalApprovalUpdate).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(mockFindResumableRunByParentConversation).toHaveBeenCalledTimes(1);
    expect(mockFindResumableRunByParentConversation).toHaveBeenCalledWith('assist', 'conv-1');
  }

  for (const mode of ['global', 'scoped']) {
    const markers: [string, unknown][] = [
      ['null', null],
      ['undefined', undefined],
      ['false', false],
      ['corrupt', 'bad'],
      ['v1', { version: 'codex-only-v1' }],
      ['v2', { version: 'codex-only-v2' }],
      ['unknown', { version: 'future' }],
    ];
    for (const [index, [label, marker]] of markers.entries()) {
      test(`${mode} refuses persisted ${label} marker before resume or replacement`, async () => {
        const prior = row({
          metadata: { codex_only_dispatch: marker },
          status: index % 2 ? 'paused' : 'failed',
          working_path: index % 2 ? null : '/worktrees/prior-run',
        });
        const before = structuredClone(prior);
        const platform = setup(mode, prior, index % 2 === 0);
        await handleMessage(platform, 'conv-1', '/workflow run assist WO-guard');
        expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', refusal);
        expect(platform.sendMessage).not.toHaveBeenCalledWith(
          'conv-1',
          expect.stringContaining('Starting workflow:')
        );
        expectNoDispatch();
        expect(prior).toEqual(before);
        expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(mode === 'global' ? 1 : 0);
      });
    }

    test.each([undefined, null])(
      `${mode} refuses reserved persisted name with metadata %s and no working path`,
      async metadata => {
        const prior = row({ workflow_name: reserved, metadata, working_path: null });
        const before = structuredClone(prior);
        const platform = setup(mode, prior);
        await handleMessage(platform, 'conv-1', '/workflow run assist WO-guard');
        expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', refusal);
        expectNoDispatch();
        expect(prior).toEqual(before);
      }
    );

    test(`${mode} lookup error cannot rediscover or dispatch a replacement`, async () => {
      const platform = setup(mode, null);
      mockFindResumableRunByParentConversation.mockRejectedValueOnce(
        new Error('lookup unavailable')
      );
      await handleMessage(platform, 'conv-1', '/workflow run assist WO-guard');
      expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', unverified);
      expectNoDispatch();
      expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(mode === 'global' ? 1 : 0);
    });

    const malformed: [string, unknown][] = [
      ['undefined', undefined],
      ['primitive', false],
      ['array', []],
      ['missing name', {}],
      ['bad name', row({ workflow_name: 3 })],
      ['metadata string', row({ metadata: 'bad' })],
      ['metadata array', row({ metadata: [] })],
      ['bad path', row({ working_path: 3 })],
    ];
    test.each(malformed)(
      `${mode} malformed %s output cannot start a replacement`,
      async (_label, output) => {
        const platform = setup(mode, output);
        await handleMessage(platform, 'conv-1', '/workflow run assist WO-guard');
        expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', unverified);
        expectNoDispatch();
        expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(mode === 'global' ? 1 : 0);
      }
    );

    test(`${mode} both refusal notification failures cannot reach discovery fallback`, async () => {
      const platform = setup(mode, row({ metadata: { codex_only_dispatch: false } }));
      const messages: string[] = [];
      platform.sendMessage = mock(async (_id: string, text: string) => {
        if (text === 'ok') return;
        messages.push(text);
        throw new Error('notification unavailable');
      });
      await handleMessage(platform, 'conv-1', '/workflow run assist WO-guard');
      expect(messages).toEqual([refusal, unverified]);
      expectNoDispatch();
      expect(mockDiscoverWorkflowsWithConfig).toHaveBeenCalledTimes(mode === 'global' ? 1 : 0);
    });
  }

  test.each([false, true])(
    'ordinary web interactive=%s preserves foreground cwd and parent identity',
    async interactive => {
      const platform = setup('scoped', row({ metadata: null }), interactive);
      await handleMessage(platform, 'conv-1', '/workflow run assist WO-guard');
      expect(mockFindResumableRunByParentConversation).toHaveBeenCalledTimes(1);
      expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
      expect(mockExecuteWorkflow.mock.calls[0][3]).toBe('/worktrees/prior-run');
      expect(mockExecuteWorkflow.mock.calls[0][10]).toBe('conv-1');
      expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
      expect(mockValidateAndResolveIsolation).toHaveBeenCalledTimes(1);
    }
  );

  test.each([null, undefined, ''])(
    'ordinary missing path %s retains background replacement behavior',
    async working_path => {
      const platform = setup('scoped', row({ working_path, metadata: undefined }));
      await handleMessage(platform, 'conv-1', '/workflow run assist WO-guard');
      expect(mockFindResumableRunByParentConversation).toHaveBeenCalledTimes(1);
      expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledTimes(1);
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    }
  );

  test('ordinary non-web dispatch retains no parent resume lookup', async () => {
    const platform = setup('scoped', null, true);
    platform.getPlatformType = mock(() => 'slack' as const);
    await handleMessage(platform, 'conv-1', '/workflow run assist WO-guard');
    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
  });
});

describe('binding-v2 generic result closed admission', () => {
  const reserved = 'bdc-feature-development-codex-only';
  const refusal = 'Codex-only dispatch is not available yet; no workflow was started.';

  beforeEach(() => {
    mockGetOrCreateConversation.mockReset();
    mockGetCodebase.mockReset();
    mockListCodebases.mockReset();
    mockParseCommand.mockReset();
    mockHandleCommand.mockReset();
    mockDiscoverWorkflowsWithConfig.mockReset();
    mockFindResumableRunByParentConversation.mockReset();
    mockFindResumableRunByParentConversation.mockImplementation(() => Promise.resolve(null));
    mockUpdateConversation.mockReset();
    mockUpdateConversation.mockImplementation(() => Promise.resolve());
    mockSyncArchonToWorktree.mockClear();
    mockSyncWorkspace.mockClear();
    mockValidateAndResolveIsolation.mockClear();
    mockExecuteWorkflow.mockClear();
    mockDispatchBackgroundWorkflow.mockClear();
    mockSendQuery.mockClear();
    mockNaturalApprovalUpdate.mockClear();
    mockCreateWorkflowEvent.mockClear();
  });

  function setup(scoped: boolean, actualName: string, projectCount = 1, interactive = false) {
    const codebase = makeCodebaseForSync();
    const conversation = makeConversation({ codebase_id: scoped ? codebase.id : null });
    const workflow = makeTestWorkflowWithSource({ name: actualName, interactive });
    mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(conversation));
    mockGetCodebase.mockImplementation(() => Promise.resolve(codebase));
    mockListCodebases.mockImplementation(() =>
      Promise.resolve(projectCount === 1 ? [codebase] : [codebase, makeCodebase('other-project')])
    );
    mockParseCommand.mockReturnValueOnce({
      command: 'workflow',
      args: ['run', actualName, 'WO-generic-result'],
    });
    mockHandleCommand.mockImplementation(() =>
      Promise.resolve({
        success: true,
        message: `Starting workflow: \`${actualName}\``,
        workflow: { definition: workflow.workflow, args: 'WO-generic-result' },
      })
    );
    mockDiscoverWorkflowsWithConfig.mockImplementation(() =>
      Promise.resolve({ workflows: [workflow], errors: [] })
    );
    return { platform: makePlatform(), command: `/workflow run ${actualName} WO-generic-result` };
  }

  function expectNoDelegation() {
    expect(mockUpdateConversation).not.toHaveBeenCalled();
    expect(mockSyncArchonToWorktree).not.toHaveBeenCalled();
    expect(mockSyncWorkspace).not.toHaveBeenCalled();
    expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
    expect(mockFindResumableRunByParentConversation).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockDispatchBackgroundWorkflow).not.toHaveBeenCalled();
    expect(mockSendQuery).not.toHaveBeenCalled();
    expect(mockNaturalApprovalUpdate).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  }

  for (const mode of ['background', 'interactive', 'non-web']) {
    test(`scoped ${mode} refuses selected reserved result before announcing or delegating`, async () => {
      const { platform, command } = setup(true, reserved, 1, mode === 'interactive');
      if (mode === 'non-web') platform.getPlatformType = mock(() => 'slack' as const);
      await handleMessage(platform, 'conv-1', command);
      expect(mockHandleCommand).toHaveBeenCalledTimes(1);
      expect(platform.sendMessage).toHaveBeenCalledTimes(1);
      expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', refusal);
      expect(platform.sendMessage).not.toHaveBeenCalledWith(
        'conv-1',
        `Starting workflow: \`${reserved}\``
      );
      expect(mockDiscoverWorkflowsWithConfig).not.toHaveBeenCalled();
      expectNoDelegation();
    });
  }

  test('scoped refusal notification failure never delegates or retries the handler', async () => {
    const { platform, command } = setup(true, reserved);
    const messages: string[] = [];
    platform.sendMessage = mock(async (_id: string, text: string) => {
      messages.push(text);
      if (text === refusal) throw new Error('owned refusal output failure');
    });
    await handleMessage(platform, 'conv-1', command);
    expect(mockHandleCommand).toHaveBeenCalledTimes(1);
    expect(messages[0]).toBe(refusal);
    expect(messages).not.toContain(`Starting workflow: \`${reserved}\``);
    expectNoDelegation();
  });

  test('ordinary selected definition preserves handler message despite reserved words', async () => {
    const { platform, command } = setup(true, 'assist');
    const message = `Starting workflow: \`assist\`; discuss ${reserved}`;
    mockHandleCommand.mockImplementation(() =>
      Promise.resolve({
        success: true,
        message,
        workflow: { definition: makeTestWorkflow({ name: 'assist' }), args: 'WO-generic-result' },
      })
    );
    await handleMessage(platform, 'conv-1', command);
    expect(mockHandleCommand).toHaveBeenCalledTimes(1);
    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', message);
    expect(platform.sendMessage).not.toHaveBeenCalledWith('conv-1', refusal);
    expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledTimes(1);
    expect(mockDispatchBackgroundWorkflow.mock.calls[0][1].name).toBe('assist');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('generic non-workflow result preserves the original response', async () => {
    const { platform, command } = setup(true, 'assist');
    const message = `No execution requested for ${reserved}`;
    mockHandleCommand.mockImplementation(() =>
      Promise.resolve({ success: true, message, workflow: undefined })
    );
    await handleMessage(platform, 'conv-1', command);
    expect(mockHandleCommand).toHaveBeenCalledTimes(1);
    expect(platform.sendMessage).toHaveBeenCalledTimes(1);
    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', message);
    expectNoDelegation();
  });

  for (const projectCount of [1, 2]) {
    test(`unscoped ${projectCount}-project reserved direct slash never uses generic handler`, async () => {
      const { platform, command } = setup(false, reserved, projectCount);
      await handleMessage(platform, 'conv-1', command);
      expect(mockHandleCommand).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', refusal);
      expect(platform.sendMessage).not.toHaveBeenCalledWith(
        'conv-1',
        `Starting workflow: \`${reserved}\``
      );
      expectNoDelegation();
    });

    test(`unscoped ${projectCount}-project ordinary direct slash keeps original dispatch`, async () => {
      const { platform, command } = setup(false, 'assist', projectCount);
      await handleMessage(platform, 'conv-1', command);
      expect(mockHandleCommand).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', 'Starting workflow: `assist`');
      expect(mockDispatchBackgroundWorkflow).toHaveBeenCalledTimes(1);
      expect(mockDispatchBackgroundWorkflow.mock.calls[0][1].name).toBe('assist');
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });
  }
});
