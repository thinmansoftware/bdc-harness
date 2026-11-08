/**
 * OpenRouter chat request assembly (WO-HARNESS-OPENROUTER-REVIEW-DIFF-SCAN-01).
 *
 * Single source of truth for the message content an OpenRouter text seat
 * (GlmProvider: glm, opr, opr-zero, and the codex-opr failback) transmits:
 * the system / persona prompt, the user prompt, and -- for structured output --
 * the JSON instruction plus the serialized outputFormat.schema appended to the
 * user message. GlmProvider builds its request with this function, and the
 * executor's review fence scans the output of this same function BEFORE the
 * provider is invoked, so the fence always sees exactly what would be sent
 * (Overseer major on PRs 1426/1428: the fence scanned finalPrompt only).
 */

export interface OpenRouterChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface OpenRouterRequestContentOptions {
  systemPrompt?: string;
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
}

/** Build the chat messages exactly as GlmProvider transmits them. */
export function buildOpenRouterChatMessages(
  prompt: string,
  options?: OpenRouterRequestContentOptions
): OpenRouterChatMessage[] {
  const messages: OpenRouterChatMessage[] = [];
  if (options?.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }
  // structuredOutput: best-effort -- append JSON instruction to prompt
  let userContent = prompt;
  if (options?.outputFormat?.type === 'json_schema') {
    const schema = JSON.stringify(options.outputFormat.schema);
    userContent =
      prompt + '\n\nRespond with valid JSON only. The JSON must conform to this schema:\n' + schema;
  }
  messages.push({ role: 'user', content: userContent });
  return messages;
}

/**
 * The complete outgoing text of an OpenRouter chat request: every message's
 * content, in transmission order. This is what the review fence scans.
 */
export function serializeOpenRouterRequestContent(
  prompt: string,
  options?: OpenRouterRequestContentOptions
): string {
  return buildOpenRouterChatMessages(prompt, options)
    .map(m => m.content)
    .join('\n\n');
}
