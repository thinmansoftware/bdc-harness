/**
 * GrokAgentProvider -- OpenRouter chat completions with a LOCAL tool loop.
 *
 * Chat-only GlmProvider/opr cannot implement WOs (no bash/files). This provider
 * calls OpenRouter chat completions with tools, executes tool calls under cwd,
 * and loops until the model stops calling tools or maxTurns is hit.
 *
 * Auth: reuses GLM_API_KEY (OpenRouter key; same as opr).
 * Model: required. Pass an explicit vendor/model id (for example
 * deepseek/deepseek-v4.1-flash). xAI ids are refused.
 *
 * Anchor: run 2ef0aa43 -- chat-only Grok claimed COMPLETE with no tools.
 */
import OpenAI from 'openai';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
  TokenUsage,
} from '../../types';
import { getOpenRouterXaiRefusal } from '../../openrouter-guard';
import { GROK_AGENT_CAPABILITIES } from './capabilities';
import { parseGrokAgentConfig } from './config';
import { executeGrokTool, GROK_AGENT_TOOLS } from './tools';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MAX_TURNS = 40;

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
type GrokTool = (typeof GROK_AGENT_TOOLS)[number];

function resolveCallBudgetUsd(options: SendQueryOptions | undefined): number | undefined {
  const raw = options?.nodeConfig?.maxBudgetUsd ?? options?.maxBudgetUsd;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  return raw;
}

/** Finite zero is a real cost. Missing, non-numeric, and negative costs are not. */
function readOpenRouterUsageCost(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const cost = (usage as { cost?: unknown }).cost;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return undefined;
  return cost;
}

function advertisedGrokTools(options: SendQueryOptions | undefined): GrokTool[] {
  const allowed = options?.nodeConfig?.allowed_tools;
  const denied = options?.nodeConfig?.denied_tools;
  let tools: GrokTool[] = [...GROK_AGENT_TOOLS];
  if (allowed !== undefined) {
    const allow = new Set(allowed);
    tools = tools.filter(tool => allow.has(tool.function.name));
  }
  if (denied !== undefined && denied.length > 0) {
    const deny = new Set(denied);
    tools = tools.filter(tool => !deny.has(tool.function.name));
  }
  return tools;
}

export class GrokAgentProvider implements IAgentProvider {
  private readonly model: string | undefined;
  private readonly baseURL: string;
  private readonly maxTurns: number;
  private readonly bashTimeoutMs: number;

  constructor(options?: { assistantConfig?: Record<string, unknown> }) {
    const config = parseGrokAgentConfig(options?.assistantConfig ?? {});
    this.model = config.model;
    this.baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    this.maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    this.bashTimeoutMs = config.bashTimeoutMs ?? 120_000;
  }

  getType(): string {
    return 'openrouter';
  }

  getCapabilities(): ProviderCapabilities {
    return GROK_AGENT_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const resolvedModel = (options?.model ?? this.model ?? '').trim();
    if (!resolvedModel) {
      throw new Error(
        'openrouter_model_required: provider openrouter needs an explicit vendor/model id'
      );
    }
    const refusal = getOpenRouterXaiRefusal('openrouter', resolvedModel);
    if (refusal) {
      throw new Error(refusal);
    }

    const apiKey = process.env.GLM_API_KEY || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GLM_API_KEY or OPENROUTER_API_KEY required for provider:openrouter ' +
          '(OpenRouter key; same env as opr). Set in archon-app-1 env before firing implement.'
      );
    }
    if (!cwd) {
      throw new Error('provider:openrouter requires a non-empty cwd (worktree path)');
    }

    const client = new OpenAI({
      apiKey,
      baseURL: this.baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://bluedevilcollectibles.com',
        'X-Title': 'BDC Archon Grok Agent',
      },
    });

    const messages: ChatMessage[] = [];
    const systemParts: string[] = [
      'You are a coding agent with tools (bash, read_file, write_file, edit_file, list_dir).',
      'You MUST use tools to inspect and modify the worktree. Do not claim you lack shell access.',
      `Working directory: ${cwd}`,
      'Prefer small surgical edits. Use ASCII only in source files.',
      'When the task is done, stop calling tools and print a short summary plus any required sentinels (e.g. COMPLETE).',
    ];
    if (options?.systemPrompt) {
      systemParts.push(options.systemPrompt);
    }
    messages.push({ role: 'system', content: systemParts.join('\n') });

    let userContent = prompt;
    if (options?.outputFormat?.type === 'json_schema') {
      userContent =
        prompt +
        '\n\nRespond with valid JSON only matching this schema:\n' +
        JSON.stringify(options.outputFormat.schema);
    }
    messages.push({ role: 'user', content: userContent });

    const cap = resolveCallBudgetUsd(options);
    const tools = advertisedGrokTools(options);
    const advertisedNames = new Set(tools.map(tool => tool.function.name));

    let totalIn = 0;
    let totalOut = 0;
    let totalCost: number | undefined;
    let servedModelId: string | undefined;
    let finalText = '';

    const buildTokens = (): TokenUsage | undefined =>
      totalIn + totalOut > 0
        ? {
            input: totalIn,
            output: totalOut,
            total: totalIn + totalOut,
            ...(totalCost !== undefined ? { cost: totalCost } : {}),
          }
        : undefined;

    const yieldKnownCostError = (errorSubtype: string, errors: string[]): MessageChunk => ({
      type: 'result',
      isError: true,
      errorSubtype,
      errors,
      ...(totalCost !== undefined ? { cost: totalCost } : {}),
      ...(buildTokens() !== undefined ? { tokens: buildTokens() } : {}),
      ...(servedModelId !== undefined ? { servedModelId } : {}),
    });

    for (let turn = 0; turn < this.maxTurns; turn++) {
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await client.chat.completions.create(
          {
            model: resolvedModel,
            messages,
            ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
          },
          { signal: options?.abortSignal }
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (totalCost !== undefined) {
          yield yieldKnownCostError('openrouter_request_failed', [msg]);
        }
        throw new Error(`Grok/OpenRouter request failed: ${msg}`);
      }

      if (typeof completion.model === 'string' && completion.model.length > 0) {
        servedModelId = completion.model;
      }
      if (completion.usage) {
        totalIn += completion.usage.prompt_tokens ?? 0;
        totalOut += completion.usage.completion_tokens ?? 0;
      }

      const turnCost = readOpenRouterUsageCost(completion.usage);
      if (turnCost === undefined) {
        yield yieldKnownCostError('openrouter_cost_missing', ['openrouter_cost_missing']);
        return;
      }
      totalCost = (totalCost ?? 0) + turnCost;

      const choice = completion.choices[0];
      const msg = choice?.message;
      if (!msg) {
        yield yieldKnownCostError('openrouter_empty_message', [
          'Grok/OpenRouter returned empty message',
        ]);
        throw new Error('Grok/OpenRouter returned empty message');
      }

      // Append assistant message (including tool_calls) for next turn
      messages.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      } as ChatMessage);

      if (msg.content) {
        finalText += msg.content;
        yield { type: 'assistant', content: msg.content };
      }

      const toolCalls = (msg.tool_calls ?? []).filter(call => call.type === 'function');
      const overCap =
        cap !== undefined && totalCost >= cap && (toolCalls.length > 0 || totalCost > cap);
      if (overCap) {
        yield yieldKnownCostError('error_max_budget_usd', ['error_max_budget_usd']);
        return;
      }
      if (toolCalls.length === 0) {
        break;
      }

      for (const call of toolCalls) {
        if (call.type !== 'function') continue;
        const name = call.function.name;
        const args = call.function.arguments ?? '{}';
        let toolInput: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(args);
          toolInput =
            parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : { raw: args };
        } catch {
          toolInput = { raw: args };
        }
        yield {
          type: 'tool',
          toolName: name,
          toolInput,
          toolCallId: call.id,
        };
        if (!advertisedNames.has(name)) {
          const rejection = `ERROR: tool '${name}' is not allowed`;
          yield {
            type: 'tool_result',
            toolName: name,
            toolOutput: rejection,
            toolCallId: call.id,
          };
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: rejection,
          });
          continue;
        }
        const result = await executeGrokTool(cwd, name, args, {
          bashTimeoutMs: this.bashTimeoutMs,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        });
      }
    }

    const tokens = buildTokens();

    let structuredOutput: unknown;
    if (options?.outputFormat?.type === 'json_schema' && finalText) {
      try {
        structuredOutput = JSON.parse(finalText);
      } catch {
        structuredOutput = undefined;
      }
    }

    yield {
      type: 'result',
      ...(tokens !== undefined ? { tokens } : {}),
      ...(totalCost !== undefined ? { cost: totalCost } : {}),
      stopReason: 'stop',
      structuredOutput,
      ...(servedModelId !== undefined ? { servedModelId } : {}),
    };
  }
}
