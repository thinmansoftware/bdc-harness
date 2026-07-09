/**
 * GrokAgentProvider -- OpenRouter Grok with a LOCAL tool loop in the worktree.
 *
 * Chat-only GlmProvider/opr cannot implement WOs (no bash/files). This provider
 * calls OpenRouter chat completions with tools, executes tool calls under cwd,
 * and loops until the model stops calling tools or maxTurns is hit.
 *
 * Auth: reuses GLM_API_KEY (OpenRouter key; same as opr).
 * Default model: x-ai/grok-4.5
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
import { GROK_AGENT_CAPABILITIES } from './capabilities';
import { parseGrokAgentConfig } from './config';
import { executeGrokTool, GROK_AGENT_TOOLS } from './tools';

const DEFAULT_MODEL = 'x-ai/grok-4.5';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MAX_TURNS = 40;

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export class GrokAgentProvider implements IAgentProvider {
  private readonly model: string;
  private readonly baseURL: string;
  private readonly maxTurns: number;
  private readonly bashTimeoutMs: number;

  constructor(options?: { assistantConfig?: Record<string, unknown> }) {
    const config = parseGrokAgentConfig(options?.assistantConfig ?? {});
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    this.maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    this.bashTimeoutMs = config.bashTimeoutMs ?? 120_000;
  }

  getType(): string {
    return 'grok';
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
    const apiKey = process.env.GLM_API_KEY || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GLM_API_KEY or OPENROUTER_API_KEY required for provider:grok ' +
          '(OpenRouter key; same env as opr). Set in archon-app-1 env before firing implement.'
      );
    }
    if (!cwd) {
      throw new Error('provider:grok requires a non-empty cwd (worktree path)');
    }

    const client = new OpenAI({
      apiKey,
      baseURL: this.baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://bluedevilcollectibles.com',
        'X-Title': 'BDC Archon Grok Agent',
      },
    });

    const model = options?.model ?? this.model;
    const resolvedModel = model.includes('/') ? model : `x-ai/${model}`;

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

    let totalIn = 0;
    let totalOut = 0;
    let servedModelId: string | undefined;
    let finalText = '';

    for (let turn = 0; turn < this.maxTurns; turn++) {
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await client.chat.completions.create({
          model: resolvedModel,
          messages,
          tools: GROK_AGENT_TOOLS,
          tool_choice: 'auto',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Grok/OpenRouter request failed: ${msg}`);
      }

      if (typeof completion.model === 'string' && completion.model.length > 0) {
        servedModelId = completion.model;
      }
      if (completion.usage) {
        totalIn += completion.usage.prompt_tokens ?? 0;
        totalOut += completion.usage.completion_tokens ?? 0;
      }

      const choice = completion.choices[0];
      const msg = choice?.message;
      if (!msg) {
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

      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // Model finished without tools
        break;
      }

      for (const call of toolCalls) {
        if (call.type !== 'function') continue;
        const name = call.function.name;
        const args = call.function.arguments ?? '{}';
        yield {
          type: 'system',
          content: `[grok-agent tool] ${name} ${args.slice(0, 200)}`,
        };
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

    const tokens: TokenUsage | undefined =
      totalIn + totalOut > 0
        ? { input: totalIn, output: totalOut, total: totalIn + totalOut }
        : undefined;

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
      tokens,
      stopReason: 'stop',
      structuredOutput,
      ...(servedModelId !== undefined ? { servedModelId } : {}),
    };
  }
}
