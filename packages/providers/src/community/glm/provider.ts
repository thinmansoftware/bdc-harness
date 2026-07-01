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

const DEFAULT_MODEL = 'z-ai/glm-5.2';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Return true when the error is an AVAILABILITY failure (transport/5xx/timeout/
 * network) rather than a semantic rejection (auth, quota, model-not-found, etc.).
 * Only availability failures trigger failback; semantic rejections re-throw so the
 * operator sees a real error.
 *
 * Uses duck-typing on the `status` property (present on OpenAI.APIError and its
 * subclasses) rather than instanceof checks so this function works in both
 * production and test environments where openai may be mocked.
 */
function isAvailabilityError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const errObj = err as { status?: unknown; message?: string };
  // HTTP 5xx = server-side availability failure; 4xx = semantic rejection
  if (typeof errObj.status === 'number') {
    return errObj.status >= 500;
  }
  // Generic network/timeout errors from the fetch layer (no status code)
  const msg = (errObj.message ?? '').toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('network error') ||
    msg.includes('timeout') ||
    msg.includes('socket hang up')
  );
}

/**
 * GlmProvider -- community provider wrapping the OpenAI chat completions API
 * pointed at the OpenRouter endpoint (https://openrouter.ai/api/v1).
 * GLM models are accessed via OpenRouter using the z-ai/ model prefix.
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
 *
 * Failback (WO-HARNESS-SMART-CAULDRON-LANE-ROSTER-AND-RESILIENCE-01):
 * When a failbackProviderFactory is wired and an AVAILABILITY error occurs
 * (5xx, timeout, network), the call is delegated to the failback provider
 * with a [GLM FAILBACK] disclosure chunk. Non-availability errors (4xx,
 * auth, model-not-found) re-throw so the operator sees real failures.
 */
export class GlmProvider implements IAgentProvider {
  private readonly model: string;
  private readonly baseURL: string;
  private readonly failbackProviderFactory: (() => IAgentProvider) | null;

  constructor(options?: {
    failbackProviderFactory?: (() => IAgentProvider) | null;
    assistantConfig?: Record<string, unknown>;
  }) {
    const config = parseGlmConfig(options?.assistantConfig ?? {});
    this.model = config.model ?? DEFAULT_MODEL;
    this.baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    this.failbackProviderFactory = options?.failbackProviderFactory ?? null;
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
    // Normalize bare model ids to OpenRouter's z-ai/ namespace.
    // YAML workflows request "glm-5.2"; OpenRouter requires "z-ai/glm-5.2".
    // Already-prefixed ids (e.g. "z-ai/glm-4.6") pass through unchanged.
    const resolvedModel = model.includes('/') ? model : 'z-ai/' + model;

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

    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await client.chat.completions.create({
        model: resolvedModel,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      });
    } catch (err) {
      if (isAvailabilityError(err) && this.failbackProviderFactory) {
        yield {
          type: 'system',
          content:
            '[GLM FAILBACK] GLM/OpenRouter unavailable. Task delegated to Claude. ' +
            'Reduced cross-model adversarial value -- human review recommended.',
        };
        const failback = this.failbackProviderFactory();
        yield* failback.sendQuery(prompt, _cwd, undefined, options);
        return;
      }
      throw err;
    }

    try {
      let accumulatedContent = '';
      let usage: OpenAI.CompletionUsage | undefined;
      // Layer 1 served-model capture (WO-HARNESS-LAYER1-SERVED-MODEL-CAPTURE-01):
      // OpenRouter SSE chunks carry the served model on every chunk (per the
      // OpenAI wire protocol). Capture the LAST non-empty value -- in practice
      // every chunk repeats the same value, but reading the last one guards
      // against an early empty/placeholder chunk.
      let capturedServedModel: string | undefined;

      for await (const chunk of stream) {
        // Capture served model id from any chunk that carries it.
        if (typeof chunk.model === 'string' && chunk.model.length > 0) {
          capturedServedModel = chunk.model;
        }

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
        ...(capturedServedModel !== undefined ? { servedModelId: capturedServedModel } : {}),
      };
    } catch (err) {
      if (isAvailabilityError(err) && this.failbackProviderFactory) {
        yield {
          type: 'system',
          content:
            '[GLM FAILBACK] GLM/OpenRouter stream error. Task delegated to Claude. ' +
            'Reduced cross-model adversarial value -- human review recommended.',
        };
        const failback = this.failbackProviderFactory();
        yield* failback.sendQuery(prompt, _cwd, undefined, options);
        return;
      }
      throw err;
    }
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
