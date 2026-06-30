/**
 * Codex SDK wrapper
 * Provides async generator interface for streaming Codex responses
 *
 * ASCII-clean as of WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01 (2026-06-10).
 * Per Code Standards v1.2, this file contains only ASCII bytes (0x00-0x7F).
 * The Cauldron ascii-gate scans every changed source file end-to-end; any
 * non-ASCII byte fails the build. Replace em-dash with --, smart quotes with
 * '/", ellipsis with ..., section sign with section, and emoji glyphs with
 * bracketed ASCII tags like [SEARCH], [MCP], [WARNING], [ERROR], [OK], [X],
 * [+], [-], [M], [TASKS], [x], [ ].
 */
import {
  Codex,
  type ThreadOptions,
  type TurnOptions,
  type TurnCompletedEvent,
} from '@openai/codex-sdk';
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  TokenUsage,
  ProviderCapabilities,
} from '../types';
import { parseCodexConfig } from './config';
import { CODEX_CAPABILITIES } from './capabilities';
import { resolveCodexBinaryPath } from './binary-resolver';
import {
  AUTH_PATTERNS,
  buildReauthMessage,
  ensureFreshAuth,
  isTerminalRefreshReason,
  refreshIfAuthFailed,
} from '../auth-refresh/index.js';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.codex');
  return cachedLog;
}

// Singleton Codex instance (async because binary path resolution is async)
let codexInstance: Codex | null = null;
let codexInitPromise: Promise<Codex> | null = null;

/** Reset singleton state. Exported for tests only. */
export function resetCodexSingleton(): void {
  codexInstance = null;
  codexInitPromise = null;
}

/**
 * Get or create Codex SDK instance.
 */
async function getCodex(configCodexBinaryPath?: string): Promise<Codex> {
  if (codexInstance) return codexInstance;

  if (!codexInitPromise) {
    codexInitPromise = (async (): Promise<Codex> => {
      const codexPathOverride = await resolveCodexBinaryPath(configCodexBinaryPath);
      const instance = new Codex({ codexPathOverride });
      codexInstance = instance;
      return instance;
    })().catch(err => {
      codexInitPromise = null;
      throw err;
    });
  }
  return codexInitPromise;
}

/**
 * Anthropic model aliases that must never reach the Codex SDK.
 * If a caller passes one of these (e.g. via node.model or assistantConfig.model),
 * it is silently dropped -- Codex authenticates via its own account and resolves
 * the model internally.  Non-Anthropic models (gpt-5-codex, o3, etc.) are passed through.
 */
// The live, API-supported Codex frontier model. Used as the explicit default when
// no model is resolved from the node/config, so the Codex SDK never falls back to its
// own stale account default (gpt-5.3-codex), which the ChatGPT-account API rejects (400).
// Verified live against the container's models_cache.json 2026-06-02 (slug "gpt-5.5",
// supported_in_api: true). Update this one constant if the account's frontier model changes.
const CODEX_DEFAULT_MODEL = 'gpt-5.5';

const ANTHROPIC_MODEL_ALIASES: ReadonlySet<string> = new Set([
  'sonnet',
  'opus',
  'haiku',
  'opus[1m]',
  'sonnet[1m]',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);

function isAnthropicAlias(model: string): boolean {
  // Also catch any full claude-* IDs not yet in the set
  return ANTHROPIC_MODEL_ALIASES.has(model) || model.startsWith('claude-');
}

/**
 * Build thread options for Codex SDK.
 * Anthropic model aliases are dropped -- the Codex SDK rejects them and resolves
 * the model via the user's OpenAI/Codex account configuration.
 */
function buildThreadOptions(
  cwd: string,
  model?: string,
  assistantConfig?: Record<string, unknown>
): ThreadOptions {
  const config = parseCodexConfig(assistantConfig ?? {});
  // Resolve the candidate model from caller arg or assistantConfig, then drop
  // it if it is an Anthropic alias.  This closes the SDK-boundary leak where a
  // codex node could still receive an Anthropic model from node.model or
  // assistantConfig.model even though resolveAgentPersona returned undefined.
  const candidateModel = model ?? config.model;
  const candidateAfterAliasDrop =
    candidateModel !== undefined && isAnthropicAlias(candidateModel) ? undefined : candidateModel;
  // When no usable model is resolved (no pin, or an Anthropic alias was dropped),
  // pin a known-good live Codex model EXPLICITLY rather than letting the Codex SDK
  // fall back to its own account default -- that default is the stale `gpt-5.3-codex`,
  // which the ChatGPT-account API now rejects with HTTP 400 ("model is not supported").
  // CODEX_DEFAULT_MODEL is the live, API-supported frontier model (verified against the
  // container's models_cache.json 2026-06-02). This is the single chokepoint every
  // codex call flows through, so fixing it here fixes every workflow lane at once --
  // no per-node/per-YAML model pin required.
  const resolvedModel = candidateAfterAliasDrop ?? CODEX_DEFAULT_MODEL;
  return {
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access',
    networkAccessEnabled: true,
    approvalPolicy: 'never',
    ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
    modelReasoningEffort: config.modelReasoningEffort,
    webSearchMode: config.webSearchMode,
    additionalDirectories: config.additionalDirectories,
  };
}

function buildCodexEnv(requestEnv: Record<string, string>): Record<string, string> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  // Managed project env intentionally overrides inherited process env for project-scoped execution.
  return { ...baseEnv, ...requestEnv };
}

// Maps stale/dead model slugs to the live default for the human-readable
// "model not available" help message. Both gpt-5.3-codex and gpt-5.2-codex are
// dead (not in the account's models_cache.json); point them at the live default.
const CODEX_MODEL_FALLBACKS: Record<string, string> = {
  'gpt-5.3-codex': CODEX_DEFAULT_MODEL,
  'gpt-5.2-codex': CODEX_DEFAULT_MODEL,
};

function isModelAccessError(errorMessage: string): boolean {
  const m = errorMessage.toLowerCase();
  const hasModel = m.includes('model');
  const hasAvailabilitySignal =
    m.includes('not available') || m.includes('not found') || m.includes('access denied');
  return hasModel && hasAvailabilitySignal;
}

function buildModelAccessMessage(model?: string): string {
  const normalizedModel = model?.trim();
  const selectedModel = normalizedModel || 'the configured model';
  const suggested = normalizedModel ? CODEX_MODEL_FALLBACKS[normalizedModel] : undefined;

  const fixLine = suggested
    ? `To fix: update your model in ~/.archon/config.yaml:\n  assistants:\n    codex:\n      model: ${suggested}`
    : 'To fix: update your model in ~/.archon/config.yaml to one your account can access.';

  const workflowLine = suggested
    ? `Or set it per-workflow with \`model: ${suggested}\` in workflow YAML.`
    : 'Or set it per-workflow with a valid `model:` in workflow YAML.';

  return `[ERROR] Model "${selectedModel}" is not available for your account.\n\n${fixLine}\n\n${workflowLine}`;
}

const MAX_SUBPROCESS_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;
const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
// AUTH_PATTERNS is shared with claude/provider.ts and orchestrator-agent.ts via
// packages/providers/src/auth-refresh/auth-patterns.ts. Edit that file (not here)
// to add new auth-error markers.
const SUBPROCESS_CRASH_PATTERNS = ['exited with code', 'killed', 'signal', 'codex exec'];

// WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01 (2026-06-10):
// Codex resume of a missing rollout surfaces as a runtime subprocess failure
// (the codex binary writes "thread/resume failed: no rollout found for thread id X"
// to stderr and exits non-zero). These tokens MUST classify as crash (retryable
// with a fresh thread), NOT as auth, regardless of how AUTH_PATTERNS evolves.
// The classifier checks this list BEFORE AUTH_PATTERNS as defense-in-depth so a
// future broadening of the auth list can never spuriously catch a resume failure.
// The runtime restart path (sendQuery streaming loop) also uses this list to
// decide when to start a fresh thread mid-stream once per call.
const ROLLOUT_MISSING_PATTERNS = ['no rollout found', 'thread/resume failed', 'rollout not found'];

/** True when the message indicates a Codex thread-resume failure due to missing rollout. */
function isRolloutMissingError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const m = errorMessage.toLowerCase();
  return ROLLOUT_MISSING_PATTERNS.some(p => m.includes(p));
}

// WO-HARNESS-CODEX-AUTH-FAILBACK-01 (2026-06-29): token rotation-collision patterns.
// These match the SPECIFIC "refresh token already used" failure class --
// a transient credential-sync issue, NOT a persistent "operator must re-login" state.
// Derived from the anchor incident error (2026-06-11 run 7a442b5c) and codex-sdk
// auth error surfaces. Do NOT add patterns that could match a successful login check,
// "not logged in", or "unauthorized" -- those belong in AUTH_PATTERNS and must surface.
// Do NOT add rollout/resume markers (those belong in ROLLOUT_MISSING_PATTERNS).
// Note: @openai/codex-sdk@0.125.0 does not define error message strings -- it passes
// through the codex binary's stderr verbatim. Patterns here come from the anchor
// incident error text only.
//
// IMPORTANT: ALL patterns must be present (use .every(), not .some()).
// The generic reauth message "Your access token could not be refreshed. Please log out
// and sign in again." contains only the second pattern and must NOT trigger failback --
// it routes through the existing refreshIfAuthFailed path (AUTH_PATTERNS). Only the
// rotation-collision message contains both substrings simultaneously.
const AUTH_FAILBACK_PATTERNS = [
  'refresh token was already used',
  'access token could not be refreshed',
];

/** True when the message indicates a Codex token rotation collision
 * that is degradable to the Claude failback path rather than requiring
 * operator re-login. Requires ALL AUTH_FAILBACK_PATTERNS to be present --
 * the rotation-collision message contains both substrings; the generic
 * "please log out" reauth message contains only 'access token could not be
 * refreshed' and must fall through to the existing refreshIfAuthFailed path. */
function isAuthFailureError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const m = errorMessage.toLowerCase();
  return AUTH_FAILBACK_PATTERNS.every(p => m.includes(p));
}

function classifyCodexError(
  errorMessage: string
): 'rate_limit' | 'auth' | 'crash' | 'model_access' | 'unknown' {
  if (isModelAccessError(errorMessage)) return 'model_access';
  const m = errorMessage.toLowerCase();
  // Rollout/resume failures are crash-class (retryable with a fresh thread).
  // Check BEFORE AUTH_PATTERNS so a future auth-pattern broadening cannot
  // spuriously misclassify a thread-resume failure as auth.
  if (ROLLOUT_MISSING_PATTERNS.some(p => m.includes(p))) return 'crash';
  if (RATE_LIMIT_PATTERNS.some(p => m.includes(p))) return 'rate_limit';
  if (AUTH_PATTERNS.some(p => m.includes(p))) return 'auth';
  if (SUBPROCESS_CRASH_PATTERNS.some(p => m.includes(p))) return 'crash';
  return 'unknown';
}

/**
 * Build sanitized SendQueryOptions for the Claude failback path.
 *
 * WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01 contract fix (2026-06-10,
 * Codex review: needs_revision -> resolved): when Codex delegates to the
 * Claude failback provider after terminal failure, the original Codex
 * `requestOptions` must NOT be forwarded unchanged. Provider-specific
 * fields would immediately fail Claude:
 *
 *   - `model`           Codex/OpenAI model id (e.g. `gpt-5.3-codex`,
 *                       `gpt-5.5`). Claude's option builder uses
 *                       `requestOptions?.model ?? assistantDefaults.model`
 *                       directly, so a Codex model name would be passed
 *                       to the Claude SDK and rejected -- collapsing the
 *                       failback into an immediate error and defeating
 *                       the entire "keep the review gate alive" purpose.
 *   - `fallbackModel`   Same hazard: a Codex/OpenAI fallback model would
 *                       reach the Claude SDK as its fallback.
 *   - `assistantConfig` Raw Codex section of `.archon/config.yaml` (with
 *                       `modelReasoningEffort`, `webSearchMode`,
 *                       `codexBinaryPath`, etc.). Claude's
 *                       `parseClaudeConfig` is defensive about unknown
 *                       fields but, critically, it ALSO reads `model`
 *                       from `assistantConfig` -- so even after dropping
 *                       the top-level `model`, leaving `assistantConfig`
 *                       intact would let a `codex.model: 'gpt-5.5'` leak
 *                       back in via the Codex config bag. Drop the whole
 *                       config bag so Claude resolves its own defaults
 *                       from its own config section.
 *
 * Universal-ish fields (abortSignal, outputFormat, env, systemPrompt,
 * maxBudgetUsd, forkSession, persistSession, nodeConfig) are preserved
 * -- Claude understands them, and dropping them would degrade the
 * failback further than necessary. EXCEPTION: nodeConfig's own model
 * fields (nodeConfig.fallbackModel, nodeConfig.agents[*].model) are
 * stripped, since those carry Codex (gpt-*) ids that ClaudeProvider
 * would otherwise feed back into the Claude SDK on failback.
 *
 * Returns undefined when no original options were provided, preserving
 * the existing call-shape for `sendQuery(prompt, cwd, undefined, undefined)`.
 */
function buildFailbackOptions(original?: SendQueryOptions): SendQueryOptions | undefined {
  if (!original) return undefined;
  const { model, fallbackModel, assistantConfig, ...rest } = original;
  // Reference the destructured locals so the compiler/lint see them as
  // intentionally discarded (drop-from-payload), not accidentally unused.
  void model;
  void fallbackModel;
  void assistantConfig;
  // Strip nested nodeConfig model fields too. nodeConfig.fallbackModel and
  // nodeConfig.agents[*].model are Codex (gpt-*) ids; ClaudeProvider's
  // applyNodeConfig would otherwise read them straight back into the Claude
  // SDK on failback -- the exact model-leak the top-level strip closes.
  // Preserve the rest of nodeConfig (prompts, tools, skills, effort, etc).
  if (rest.nodeConfig) {
    const { fallbackModel: nodeFallbackModel, agents, ...nodeRest } = rest.nodeConfig;
    void nodeFallbackModel;
    rest.nodeConfig = {
      ...nodeRest,
      ...(agents
        ? {
            agents: Object.fromEntries(
              Object.entries(agents).map(([id, def]) => {
                const { model: agentModel, ...defRest } = def;
                void agentModel;
                return [id, defRest];
              })
            ),
          }
        : {}),
    };
  }
  return rest;
}

function extractUsageFromCodexEvent(event: TurnCompletedEvent): TokenUsage {
  if (!event.usage) {
    getLog().warn({ eventType: event.type }, 'codex.usage_null_on_turn_completed');
    return { input: 0, output: 0 };
  }
  return {
    input: event.usage.input_tokens,
    output: event.usage.output_tokens,
  };
}

// --- Turn Options Builder ------------------------------------------------

/**
 * Build turn options for a single Codex turn.
 * Handles output schema from both requestOptions and nodeConfig (workflow path).
 */
function buildTurnOptions(requestOptions?: SendQueryOptions): {
  turnOptions: TurnOptions;
  hasOutputFormat: boolean;
} {
  const turnOptions: TurnOptions = {};
  const hasOutputFormat = !!(
    requestOptions?.outputFormat ?? requestOptions?.nodeConfig?.output_format
  );
  if (requestOptions?.outputFormat) {
    turnOptions.outputSchema = requestOptions.outputFormat.schema;
  }
  if (requestOptions?.nodeConfig?.output_format && !requestOptions?.outputFormat) {
    turnOptions.outputSchema = requestOptions.nodeConfig.output_format;
  }
  if (requestOptions?.abortSignal) {
    turnOptions.signal = requestOptions.abortSignal;
  }
  return { turnOptions, hasOutputFormat };
}

// --- Stream Normalizer ---------------------------------------------------

/** State maintained across Codex event stream normalization. */
interface CodexStreamState {
  lastTodoListSignature?: string;
}

/**
 * Normalize raw Codex SDK events into Archon MessageChunks.
 * Handles structured output normalization (Codex returns JSON inline in text).
 */
async function* streamCodexEvents(
  events: AsyncIterable<Record<string, unknown>>,
  hasOutputFormat: boolean,
  threadId: string | null | undefined,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  const state: CodexStreamState = {};
  let accumulatedText = '';

  // If the iterator closes without a terminal event (e.g. the model was
  // rejected before the turn even started), we synthesize a fail-stop result
  // after the loop so the dag-executor's `msg.isError` branch catches it
  // -- matching Claude's contract. Both terminal branches below `return`,
  // so reaching the post-loop block can only mean no terminal fired.
  let lastNonMcpError: string | undefined;

  for await (const event of events) {
    if (abortSignal?.aborted) {
      getLog().info('query_aborted_between_events');
      throw new Error('Query aborted');
    }

    if (event.type === 'item.started') {
      const item = event.item as { type: string; id: string };
      getLog().debug(
        { eventType: event.type, itemType: item.type, itemId: item.id },
        'item_started'
      );
    }

    if (event.type === 'error') {
      const errorEvent = event as { message: string };
      getLog().error({ message: errorEvent.message }, 'stream_error');
      // MCP client errors are non-fatal -- Codex retries internally and may
      // still reach turn.completed. Other errors are captured; whether they
      // are fatal is decided when the stream terminates: turn.completed
      // means the SDK recovered, so the captured error is dropped; loop
      // closure without a terminal means the captured error caused the
      // stream to abort and is surfaced as the failure cause.
      if (!errorEvent.message.includes('MCP client')) {
        lastNonMcpError = errorEvent.message;
      }
      continue;
    }

    if (event.type === 'turn.failed') {
      const errorObj = (event as { error?: { message?: string } }).error;
      const errorMessage = errorObj?.message ?? 'Unknown error';
      getLog().error({ errorMessage }, 'turn_failed');
      // BDF Fix A (WO-HARNESS-BDF-RESILIENCE-FIXES-01): throw so the sendQuery
      // catch block receives the error and can fire the failback provider
      // (e.g. usage-limit turn.failed -> 'unknown' error class -> failback).
      // Previously this yielded an error-result chunk and returned normally,
      // which caused the try block in sendQuery to succeed and bypass failback.
      throw new Error(errorMessage);
    }

    if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown>;
      const itemType = item.type as string;

      const logContext: Record<string, unknown> = {
        eventType: event.type,
        itemType,
        itemId: item.id,
      };
      if (itemType === 'command_execution' && item.command) {
        logContext.command = item.command;
      }
      getLog().debug(logContext, 'item_completed');

      switch (itemType) {
        case 'agent_message':
          if (item.text) {
            if (hasOutputFormat) accumulatedText += item.text as string;
            yield { type: 'assistant', content: item.text as string };
          }
          break;

        case 'command_execution':
          if (item.command) {
            const cmd = item.command as string;
            yield { type: 'tool', toolName: cmd };
            const exitCode = item.exit_code as number | null | undefined;
            const exitSuffix =
              exitCode != null && exitCode !== 0 ? `\n[exit code: ${String(exitCode)}]` : '';
            yield {
              type: 'tool_result',
              toolName: cmd,
              toolOutput: ((item.aggregated_output as string) ?? '') + exitSuffix,
            };
          } else {
            getLog().warn({ itemId: item.id }, 'command_execution_missing_command');
          }
          break;

        case 'reasoning':
          if (item.text) {
            yield { type: 'thinking', content: item.text as string };
          }
          break;

        case 'web_search':
          if (item.query) {
            const searchToolName = `[SEARCH] Searching: ${item.query as string}`;
            yield { type: 'tool', toolName: searchToolName };
            yield { type: 'tool_result', toolName: searchToolName, toolOutput: '' };
          } else {
            getLog().debug({ itemId: item.id }, 'web_search_missing_query');
          }
          break;

        case 'todo_list': {
          const items = item.items as { text?: string; completed?: boolean }[] | undefined;
          if (Array.isArray(items) && items.length > 0) {
            const normalizedItems = items.map(t => ({
              text: typeof t.text === 'string' ? t.text : '(unnamed task)',
              completed: t.completed ?? false,
            }));
            const signature = JSON.stringify(normalizedItems);
            if (signature !== state.lastTodoListSignature) {
              state.lastTodoListSignature = signature;
              const taskList = normalizedItems
                .map(t => `${t.completed ? '[x]' : '[ ]'} ${t.text}`)
                .join('\n');
              yield { type: 'system', content: `[TASKS] Tasks:\n${taskList}` };
            }
          } else {
            getLog().debug({ itemId: item.id }, 'todo_list_empty_or_invalid');
          }
          break;
        }

        case 'file_change': {
          const statusIcon = (item.status as string) === 'failed' ? '[X]' : '[OK]';
          const rawError = 'error' in item ? (item as { error?: unknown }).error : undefined;
          const fileErrorMessage =
            typeof rawError === 'string'
              ? rawError
              : typeof rawError === 'object' && rawError !== null && 'message' in rawError
                ? String((rawError as { message: unknown }).message)
                : undefined;

          const changes = item.changes as { kind: string; path?: string }[] | undefined;
          if (Array.isArray(changes) && changes.length > 0) {
            const changeList = changes
              .map(c => {
                const icon = c.kind === 'add' ? '[+]' : c.kind === 'delete' ? '[-]' : '[M]';
                return `${icon} ${c.path ?? '(unknown file)'}`;
              })
              .join('\n');
            const errorSuffix =
              (item.status as string) === 'failed' && fileErrorMessage
                ? `\n${fileErrorMessage}`
                : '';
            yield {
              type: 'system',
              content: `${statusIcon} File changes:\n${changeList}${errorSuffix}`,
            };
          } else if ((item.status as string) === 'failed') {
            getLog().warn(
              { itemId: item.id, status: item.status },
              'file_change_failed_no_changes'
            );
            const failMsg = fileErrorMessage
              ? `[X] File change failed: ${fileErrorMessage}`
              : '[X] File change failed';
            yield { type: 'system', content: failMsg };
          } else {
            getLog().debug({ itemId: item.id, status: item.status }, 'file_change_no_changes');
          }
          break;
        }

        case 'mcp_tool_call': {
          const server = item.server as string | undefined;
          const tool = item.tool as string | undefined;
          const toolInfo = server && tool ? `${server}/${tool}` : (tool ?? server ?? 'MCP tool');
          const mcpToolName = `[MCP] ${toolInfo}`;

          yield { type: 'tool', toolName: mcpToolName };

          if ((item.status as string) === 'failed') {
            getLog().warn(
              { server, tool, error: item.error, itemId: item.id },
              'mcp_tool_call_failed'
            );
            const mcpError = item.error as { message?: string } | undefined;
            const errMsg = mcpError?.message
              ? `[ERROR]: ${mcpError.message}`
              : '[ERROR]: MCP tool failed';
            yield { type: 'tool_result', toolName: mcpToolName, toolOutput: errMsg };
          } else {
            let toolOutput = '';
            const mcpResult = item.result as { content?: unknown } | undefined;
            if (mcpResult?.content) {
              if (Array.isArray(mcpResult.content)) {
                toolOutput = JSON.stringify(mcpResult.content);
              } else {
                getLog().warn(
                  {
                    itemId: item.id,
                    server,
                    tool,
                    resultType: typeof mcpResult.content,
                  },
                  'mcp_tool_call_unexpected_result_shape'
                );
              }
            }
            yield { type: 'tool_result', toolName: mcpToolName, toolOutput };
          }
          break;
        }
      }
    }

    if (event.type === 'turn.completed') {
      getLog().debug('turn_completed');
      const usage = extractUsageFromCodexEvent(event as TurnCompletedEvent);

      // Codex returns structured output inline in agent_message text.
      // Normalize: parse as JSON and put on structuredOutput so the
      // dag-executor can handle all providers uniformly.
      let structuredOutput: unknown;
      if (hasOutputFormat && accumulatedText) {
        try {
          structuredOutput = JSON.parse(accumulatedText);
          getLog().debug('codex.structured_output_parsed');
        } catch {
          getLog().warn(
            { outputPreview: accumulatedText.slice(0, 200) },
            'codex.structured_output_not_json'
          );
          yield {
            type: 'system',
            content:
              '[WARNING] Structured output requested but Codex returned non-JSON text. ' +
              'Downstream $nodeId.output.field references may not evaluate correctly.',
          };
        }
      }

      // Layer 1 served-model capture (WO-HARNESS-LAYER1-SERVED-MODEL-CAPTURE-01):
      // TurnCompletedEvent in @openai/codex-sdk@0.125.0 carries no `model`
      // field, and neither do Thread/ThreadOptions/TurnOptions. Emit explicit
      // null + machine-readable reason so the dag-executor can persist
      // "provider could not tell us" without fabricating a value.
      yield {
        type: 'result',
        sessionId: threadId ?? undefined,
        tokens: usage,
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
        servedModelId: null,
        servedModelMissingReason: 'codex_sdk_does_not_expose_served_model',
      };
      return;
    }
  }

  // Reaching here means the iterator closed without yielding turn.completed
  // or turn.failed (both branches `return` immediately). Common cause: model
  // rejected by the API (model not supported, auth refused) before the turn
  // started. Surface as a fail-stop. The dag-executor's `msg.isError` branch
  // (dag-executor.ts: throws `Node '<id>' failed: SDK returned <subtype>`)
  // turns this into a thrown node failure -- distinct from the empty-output
  // guard further down, which returns `{ state: 'failed' }` for AI nodes
  // that streamed nothing but never raised an isError.
  const message = lastNonMcpError ?? 'Codex stream closed without turn.completed or turn.failed';
  getLog().error({ message }, 'stream_incomplete');
  yield {
    type: 'result',
    sessionId: threadId ?? undefined,
    isError: true,
    errorSubtype: 'codex_stream_incomplete',
    errors: [message],
  };
}

// --- Error Classification & Retry ----------------------------------------

/**
 * Classify a Codex error and determine retry eligibility.
 */
function classifyAndEnrichCodexError(
  error: Error,
  model?: string
): { enrichedError: Error; errorClass: string; shouldRetry: boolean } {
  const errorClass = classifyCodexError(error.message);

  if (errorClass === 'model_access') {
    return {
      enrichedError: new Error(buildModelAccessMessage(model)),
      errorClass,
      shouldRetry: false,
    };
  }

  if (errorClass === 'auth') {
    const enrichedError = new Error(`Codex auth error: ${error.message}`);
    enrichedError.cause = error;
    return { enrichedError, errorClass, shouldRetry: false };
  }

  const enrichedError = new Error(`Codex ${errorClass}: ${error.message}`);
  enrichedError.cause = error;
  const shouldRetry = errorClass === 'rate_limit' || errorClass === 'crash';
  return { enrichedError, errorClass, shouldRetry };
}

// --- Codex Provider ------------------------------------------------------

/**
 * Codex AI agent provider.
 * Implements IAgentProvider with Codex SDK integration.
 *
 * sendQuery orchestrates the following internal helpers:
 * - buildThreadOptions: SDK thread configuration
 * - buildTurnOptions: per-turn configuration (output schema, abort signal)
 * - streamCodexEvents: raw SDK event normalization into MessageChunks
 * - classifyAndEnrichCodexError: error classification for retry decisions
 *
 * WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01 (2026-06-10) adds:
 * - A runtime rollout-missing self-heal: when a resume of a missing rollout
 *   blows up mid-stream, restart the turn ONCE with a fresh thread.
 * - A Claude failback path: when Codex is terminally unavailable after
 *   retries exhaust, delegate the query to an injected failback provider
 *   (registry wires ClaudeProvider) and emit a disclosure chunk noting the
 *   reduced cross-model adversarial value.
 */
export class CodexProvider implements IAgentProvider {
  private readonly retryBaseDelayMs: number;
  private readonly failbackProviderFactory: (() => IAgentProvider) | null;

  constructor(options?: {
    retryBaseDelayMs?: number;
    /**
     * Optional factory that produces a fallback IAgentProvider for the
     * Claude failback path. When undefined or null, terminal Codex failures
     * throw as before (no silent degradation without explicit wiring). The
     * registry wires ClaudeProvider here in production; tests inject a mock.
     */
    failbackProviderFactory?: (() => IAgentProvider) | null;
  }) {
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;
    this.failbackProviderFactory = options?.failbackProviderFactory ?? null;
  }

  private async createCodexClient(
    configCodexBinaryPath: string | undefined,
    requestEnv?: Record<string, string>
  ): Promise<Codex> {
    if (!requestEnv || Object.keys(requestEnv).length === 0) {
      return getCodex(configCodexBinaryPath);
    }

    try {
      return new Codex({
        codexPathOverride: await resolveCodexBinaryPath(configCodexBinaryPath),
        env: buildCodexEnv(requestEnv),
      });
    } catch (error) {
      const err = error as Error;
      if (isModelAccessError(err.message)) {
        throw new Error(buildModelAccessMessage());
      }
      throw new Error(`Codex query failed: ${err.message}`);
    }
  }

  getCapabilities(): ProviderCapabilities {
    return CODEX_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    requestOptions?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    // BDC fork: Layer 2 -- proactive auth freshness check.
    // For Codex, ensureFreshAuth first attempts a "soft refresh" via the
    // binary's own OAuth path (OpenAI's documented approach per
    // developers.openai.com/codex/auth/ci-cd-auth) and only falls back to a
    // direct refresh-endpoint POST if that path doesn't advance auth.json.
    // Behavior spec v2 invariant I-1; research doc section Design recommendation L2 + L4.
    await ensureFreshAuth('codex');

    const assistantConfig = requestOptions?.assistantConfig ?? {};
    const codexConfig = parseCodexConfig(assistantConfig);

    // 1. Initialize SDK and build thread options
    const codex = await this.createCodexClient(codexConfig.codexBinaryPath, requestOptions?.env);
    const threadOptions = buildThreadOptions(cwd, requestOptions?.model, assistantConfig);

    if (requestOptions?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    // 2. Create or resume thread
    let sessionResumeFailed = false;
    let thread;
    if (resumeSessionId) {
      getLog().debug({ sessionId: resumeSessionId }, 'resuming_thread');
      try {
        thread = codex.resumeThread(resumeSessionId, threadOptions);
      } catch (error) {
        getLog().error({ err: error, sessionId: resumeSessionId }, 'resume_thread_failed');
        try {
          thread = codex.startThread(threadOptions);
        } catch (startError) {
          const err = startError as Error;
          if (isModelAccessError(err.message)) {
            throw new Error(buildModelAccessMessage(requestOptions?.model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
        sessionResumeFailed = true;
      }
    } else {
      getLog().debug({ cwd }, 'starting_new_thread');
      try {
        thread = codex.startThread(threadOptions);
      } catch (error) {
        const err = error as Error;
        if (isModelAccessError(err.message)) {
          throw new Error(buildModelAccessMessage(requestOptions?.model));
        }
        throw new Error(`Codex query failed: ${err.message}`);
      }
    }

    if (sessionResumeFailed) {
      yield {
        type: 'system',
        content: '[WARNING] Could not resume previous session. Starting fresh conversation.',
      };
    }

    // 3. Build turn options
    const { turnOptions, hasOutputFormat } = buildTurnOptions(requestOptions);
    let lastError: Error | undefined;
    // Runtime rollout-missing self-heal flag. Fires at most ONCE per sendQuery
    // call -- prevents an infinite resume loop if the rollout-missing error
    // somehow recurs after a fresh-thread restart.
    let rolloutRestartUsed = false;
    // WO-HARNESS-CODEX-AUTH-FAILBACK-01: single-shot guard for auth-class failback.
    // Mirrors rolloutRestartUsed -- fires at most once per sendQuery.
    let authFailbackUsed = false;

    for (let attempt = 0; attempt <= MAX_SUBPROCESS_RETRIES; attempt++) {
      if (requestOptions?.abortSignal?.aborted) {
        throw new Error('Query aborted');
      }

      if (attempt > 0) {
        getLog().debug({ cwd, attempt }, 'starting_new_thread');
        try {
          thread = codex.startThread(threadOptions);
        } catch (startError) {
          const err = startError as Error;
          if (isModelAccessError(err.message)) {
            throw new Error(buildModelAccessMessage(requestOptions?.model));
          }
          throw new Error(`Codex query failed: ${err.message}`);
        }
      }

      try {
        // 4. Run streamed turn
        const result = await thread.runStreamed(prompt, turnOptions);

        // 5. Stream normalized events (fresh state per attempt to avoid dedup leaks)
        yield* streamCodexEvents(
          result.events as AsyncIterable<Record<string, unknown>>,
          hasOutputFormat,
          thread.id,
          requestOptions?.abortSignal
        );
        return;
      } catch (error) {
        const err = error as Error;

        if (requestOptions?.abortSignal?.aborted) {
          throw new Error('Query aborted');
        }

        // WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01: runtime rollout-missing
        // self-heal. When a resume attempt fails at RUNTIME (the codex binary
        // emits "thread/resume failed: no rollout found" mid-stream and exits),
        // restart the turn ONCE with a fresh thread. Fires at most once per
        // sendQuery via the rolloutRestartUsed flag; the second occurrence
        // falls through to the regular retry/failback path. The disclosure
        // chunk informs the consumer that the resumed history is unavailable.
        if (
          isRolloutMissingError(err.message) &&
          !rolloutRestartUsed &&
          attempt === 0 &&
          resumeSessionId
        ) {
          getLog().warn(
            { sessionId: resumeSessionId, err: err.message },
            'rollout_missing_restart'
          );
          yield {
            type: 'system',
            content:
              '[WARNING] Could not resume previous session (rollout missing). Starting fresh conversation.',
          };
          // NOTE: rollout persistence (CODEX_HOME pin) is deferred to
          // WO-HARNESS-CODEX-ROLLOUT-PERSISTENCE-01; until then every resume
          // against an empty rollout store self-heals to a fresh thread
          // (context-loss is logged via the [WARNING] chunk above).
          rolloutRestartUsed = true;
          try {
            thread = codex.startThread(threadOptions);
          } catch (startError) {
            const startErr = startError as Error;
            if (isModelAccessError(startErr.message)) {
              throw new Error(buildModelAccessMessage(requestOptions?.model));
            }
            throw new Error(`Codex query failed: ${startErr.message}`);
          }
          // Restart the loop at attempt 0 without consuming a retry slot --
          // the rollout restart is a single-shot self-heal, distinct from
          // the crash-retry budget.
          attempt = -1; // for-loop will increment to 0
          continue;
        }

        // WO-HARNESS-CODEX-AUTH-FAILBACK-01: single-shot auth-class failback.
        // Codex token rotation collisions (refresh token already used) classify
        // as auth but are transient -- the run's work is intact; only the
        // credential sync failed. Delegate to Claude rather than dying.
        // Fires at most ONCE per sendQuery (authFailbackUsed guard). Without a
        // factory, falls through to the existing auth-refresh / throw path so
        // the original error always surfaces (no silent swallowing).
        if (isAuthFailureError(err.message) && this.failbackProviderFactory && !authFailbackUsed) {
          authFailbackUsed = true;
          getLog().warn({ err: err.message }, 'auth_failure_codex_failback');
          yield {
            type: 'system',
            content:
              '[CODEX FAILBACK] Codex auth failed (credential rotation). Review delegated to ' +
              'Claude. Reduced cross-model adversarial value -- human review recommended.',
          };
          const failbackProvider = this.failbackProviderFactory();
          yield* failbackProvider.sendQuery(
            prompt,
            cwd,
            undefined,
            buildFailbackOptions(requestOptions)
          );
          return;
        }

        const { enrichedError, errorClass, shouldRetry } = classifyAndEnrichCodexError(
          err,
          requestOptions?.model
        );

        getLog().error(
          { err, errorClass, attempt, maxRetries: MAX_SUBPROCESS_RETRIES },
          'query_error'
        );

        // BDC fork: subscription auth must self-heal; API-key fallback is forbidden.
        if (errorClass === 'auth' && attempt === 0) {
          try {
            const result = await refreshIfAuthFailed('codex');
            if (result.refreshed) {
              getLog().info(
                { provider: 'codex', newExpiresAt: new Date(result.expiresAt).toISOString() },
                'token_refreshed_retrying'
              );
              lastError = enrichedError;
              continue;
            }
            getLog().error(
              { provider: 'codex', reason: result.reason, err: result.error },
              'token_refresh_failed'
            );
            if (isTerminalRefreshReason(result.reason)) {
              throw new Error(buildReauthMessage('codex', result.reason));
            }
          } catch (refreshErr) {
            getLog().error({ provider: 'codex', err: refreshErr }, 'token_refresh_threw');
            throw refreshErr;
          }
        }

        if (!shouldRetry || attempt >= MAX_SUBPROCESS_RETRIES) {
          // WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01: Claude failback.
          // When Codex is terminally unavailable AND a failback provider is
          // wired, delegate the query to it rather than throwing. The
          // disclosure chunk informs the consumer that cross-model adversarial
          // value is reduced -- this path is degraded-with-disclosure, never
          // the silent default.
          //
          // Auth-class handling: the rotation-collision case (isAuthFailureError
          // true) is already handled above with its own disclosure. A residual
          // auth error that reaches here still degrades to the general failback
          // WHEN a factory is wired -- a wired factory signals the caller accepts
          // delegation. With NO factory, the auth error throws so a real
          // re-login surfaces to the operator (see the null-factory tests).
          if (this.failbackProviderFactory) {
            getLog().warn(
              { errorClass, attempt, originalError: err.message },
              'codex_failback_to_claude'
            );
            yield {
              type: 'system',
              content:
                '[CODEX FAILBACK] Codex unavailable after retries. Review delegated to ' +
                'Claude. Reduced cross-model adversarial value -- human review recommended.',
            };
            const failbackProvider = this.failbackProviderFactory();
            // Fresh session for the failback (no resume id; failback runs a
            // brand-new conversation against the same prompt/cwd).
            // requestOptions is sanitized: Codex-specific fields (model,
            // fallbackModel, assistantConfig) are stripped so Claude resolves
            // its own model defaults rather than receiving a Codex model id.
            // See buildFailbackOptions() for rationale.
            yield* failbackProvider.sendQuery(
              prompt,
              cwd,
              undefined,
              buildFailbackOptions(requestOptions)
            );
            return;
          }
          throw enrichedError;
        }

        const delayMs = this.retryBaseDelayMs * Math.pow(2, attempt);
        getLog().info({ attempt, delayMs, errorClass }, 'retrying_query');
        await new Promise(resolve => setTimeout(resolve, delayMs));
        lastError = enrichedError;
      }
    }

    // Retry budget exhausted without a thrown error -- also a failback candidate.
    if (this.failbackProviderFactory) {
      getLog().warn({ lastError: lastError?.message }, 'codex_failback_to_claude_after_loop_exit');
      yield {
        type: 'system',
        content:
          '[CODEX FAILBACK] Codex unavailable after retries. Review delegated to ' +
          'Claude. Reduced cross-model adversarial value -- human review recommended.',
      };
      const failbackProvider = this.failbackProviderFactory();
      // Same sanitization rationale as the in-loop failback above:
      // strip Codex-specific model/fallbackModel/assistantConfig so Claude
      // does not receive a Codex model id from requestOptions.
      yield* failbackProvider.sendQuery(
        prompt,
        cwd,
        undefined,
        buildFailbackOptions(requestOptions)
      );
      return;
    }
    throw lastError ?? new Error('Codex query failed after retries');
  }

  getType(): string {
    return 'codex';
  }
}
