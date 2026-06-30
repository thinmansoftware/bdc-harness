import type { CallModel, CallModelResult, TokenUsage } from './types';
import { EMPTY_USAGE } from './config';

interface OpenRouterChoice {
  message?: {
    content?: string;
  };
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenRouterResponse {
  model?: string;
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
  error?: {
    message?: string;
  };
}

function normalizeUsage(usage: OpenRouterUsage | undefined): TokenUsage {
  return {
    prompt_tokens: usage?.prompt_tokens ?? 0,
    completion_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
  };
}

export const callModel: CallModel = async ({
  role,
  modelId,
  prompt,
}): Promise<CallModelResult> => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      text: '',
      servedModelId: '',
      usage: EMPTY_USAGE,
      ok: false,
      error: 'OPENROUTER_API_KEY is not set',
    };
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/archon',
        'X-Title': 'Archon Fusion Review',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: 'system',
            content: `You are reviewing as ${role}.`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    const body = (await response.json()) as OpenRouterResponse;
    if (!response.ok) {
      return {
        text: '',
        servedModelId: body.model ?? '',
        usage: normalizeUsage(body.usage),
        ok: false,
        error: body.error?.message ?? `OpenRouter returned HTTP ${response.status}`,
      };
    }

    const text = body.choices?.[0]?.message?.content ?? '';
    return {
      text,
      servedModelId: body.model ?? modelId,
      usage: normalizeUsage(body.usage),
      ok: text.length > 0,
      error: text.length > 0 ? undefined : 'OpenRouter returned an empty response',
    };
  } catch (error) {
    return {
      text: '',
      servedModelId: '',
      usage: EMPTY_USAGE,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
