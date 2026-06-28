import OpenAI from 'openai';

import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
  TokenUsage,
} from '../../types';

import { GLM_CAPABILITIES } from './capabilities';
import { parseGlmConfig } from './config';

const DEFAULT_MODEL = 'glm-5.2';
const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

/**
 * GlmProvider -- community provider wrapping the OpenAI chat completions API
 * pointed at the Z.ai (Zhipu) endpoint.
 *
 * GLM-5.2 speaks the OpenAI wire protocol, so this provider reuses the
 * `openai` npm package (already a dep for community/pi transitive usage)
 * with a custom baseURL and GLM_API_KEY.
 *
 * Design notes:
 * - Static imports only. No dynamic import risk (openai has no binary crash
 *   path unlike Pi's compiled-binary issue).
 * - API key is read at sendQuery time so tests can manipulate process.env
 *   before invocation.
 * - resumeSessionId is accepted but ignored (stateless REST endpoint).
 * - effortControl is declared true in capabilities but is a no-op stub:
 *   the effort field is silently dropped and the model default is used.
 */
export class GlmProvider implements IAgentProvider {
  private readonly model: string;
  private readonly baseURL: string;

  constructor(assistantConfig?: Record<string, unknown>) {
    const config = parseGlmConfig(assistantConfig ?? {});
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseURL = config.baseURL ?? DEFAULT_BASE_URL;
  }

  getType(): string {
    return 'glm';
  }

  getCapabilities(): ProviderCapabilities {
    return GLM_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    _cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const apiKey = process.env.GLM_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GLM_API_KEY env var required -- set in Hetzner container env before firing.'
      );
    }

    const client = new OpenAI({
      apiKey,
      baseURL: this.baseURL,
    });

    const model = options?.model ?? this.model;

    // Build messages array from prompt. systemPrompt is prepended when present.
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (options?.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    // structuredOutput: best-effort -- append JSON instruction to prompt
    let userContent = prompt;
    if (options?.outputFormat?.type === 'json_schema') {
      const schema = JSON.stringify(options.outputFormat.schema);
      userContent =
        prompt +
        '\n\nRespond with valid JSON only. The JSON must conform to this schema:\n' +
        schema;
    }
    messages.push({ role: 'user', content: userContent });

    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let accumulatedContent = '';
    let usage: OpenAI.CompletionUsage | undefined;

    for await (const chunk of stream) {
      // Capture usage from final chunk (present when include_usage: true)
      if (chunk.usage) {
        usage = chunk.usage;
      }

      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        accumulatedContent += delta.content;
        yield {
          type: 'assistant',
          content: delta.content,
        };
      }
    }

    // Emit result chunk with token usage
    const tokenUsage: TokenUsage | undefined = usage
      ? {
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
          total: usage.total_tokens ?? 0,
        }
      : undefined;

    yield {
      type: 'result',
      tokens: tokenUsage,
      stopReason: 'stop',
      structuredOutput:
        options?.outputFormat?.type === 'json_schema'
          ? tryParseJson(accumulatedContent)
          : undefined,
    };
  }
}

/**
 * Attempt to parse accumulated content as JSON for structuredOutput.
 * Returns undefined on parse failure so the dag-executor's existing
 * dag.structured_output_missing path handles degradation gracefully.
 */
function tryParseJson(content: string): unknown {
  try {
    // Strip markdown code fences if present
    const stripped = content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}
