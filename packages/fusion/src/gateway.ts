/**
 * gateway.ts -- OpenRouter model gateway seam for Cauldron Fusion v0.1
 *
 * This module is the SINGLE place in the codebase that knows about OpenRouter.
 * All model calls funnel through callModel(). The ModelGateway type in types.ts
 * is the abstraction contract -- tests inject a stub, production uses callModel.
 *
 * OpenRouter uses the OpenAI wire protocol. We mirror the GlmProvider pattern
 * from packages/providers/src/community/glm/provider.ts exactly:
 *   - openai npm package, custom baseURL
 *   - GLM_API_KEY read from process.env at call time (never at import time)
 *   - served model captured from chunk.model in SSE stream
 *
 * SECRET BOUNDARY: Never hardcode keys or expose them in logs.
 */

import OpenAI from 'openai';
import type { ModelCallRequest, ModelCallResult } from './types.js';

// The OpenRouter base URL lives ONLY here. No other file may import or
// reference this string. Tests and other modules use the ModelGateway seam.
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * callModel -- default gateway implementation backed by OpenRouter.
 *
 * Reads GLM_API_KEY from process.env at call time (same pattern as GlmProvider).
 * Returns a ModelCallResult with ok=false and error set on any failure.
 */
export async function callModel(req: ModelCallRequest): Promise<ModelCallResult> {
  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) {
    return {
      text: '',
      servedModelId: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ok: false,
      error: 'GLM_API_KEY env var required -- set before running fusion review.',
    };
  }

  const client = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });

  try {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'user', content: req.prompt },
    ];

    const stream = await client.chat.completions.create({
      model: req.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });

    let accumulatedText = '';
    let capturedServedModel: string | null = null;
    let rawUsage: OpenAI.CompletionUsage | undefined;

    for await (const chunk of stream) {
      // Capture served model from the first chunk that has it
      if (
        capturedServedModel === null &&
        typeof chunk.model === 'string' &&
        chunk.model.length > 0
      ) {
        capturedServedModel = chunk.model;
      }

      if (chunk.usage) {
        rawUsage = chunk.usage;
      }

      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        accumulatedText += delta.content;
      }
    }

    const usage = {
      inputTokens: rawUsage?.prompt_tokens ?? 0,
      outputTokens: rawUsage?.completion_tokens ?? 0,
      totalTokens: rawUsage?.total_tokens ?? 0,
    };

    return {
      text: accumulatedText,
      servedModelId: capturedServedModel,
      usage,
      ok: accumulatedText.length > 0,
      error: accumulatedText.length === 0 ? 'Empty response from model' : null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text: '',
      servedModelId: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ok: false,
      error: msg,
    };
  }
}
