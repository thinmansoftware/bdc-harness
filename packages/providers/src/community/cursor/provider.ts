/**
 * CursorAgentProvider -- the operator's Cursor subscription as a build/review seat.
 *
 * Spawns the LOCAL `cursor-agent` CLI (the same binary the Overseer `cursor`
 * judge rung uses) inside the worktree instead of calling an HTTP API: the
 * point is to spend Cursor capacity, not an API key. cursor-agent reaches many
 * models on one account; the model is selected per call with `--model`.
 *
 * Flags (recorded against cursor-agent 2026.08.11-e8db854 in
 * scripts/dispatch-worker/adapters.ts, `cursor-build` entry):
 *  - `--print`  non-interactive; "Has access to all tools, including write and
 *               shell". No `--mode`: both `plan` and `ask` are READ-ONLY, which
 *               is right for the judge rung and wrong for a build seat.
 *  - `--force`  run commands without prompting.
 *  - `--trust`  suppress the Workspace Trust prompt; without it the CLI exits 0
 *               with EMPTY output, so empty output is treated as failure below.
 *  - `--workspace <cwd>` pin the workspace to the worktree.
 *
 * The prompt is delivered on stdin, never as an argv element (Linux
 * MAX_ARG_STRLEN 131,072 bytes per argument; bdc-harness #789).
 *
 * Auth: `cursor-agent login` state under ~/.cursor, or CURSOR_API_KEY in the
 * environment. Neither is read by this module; cursor-agent resolves it itself.
 */
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../../types';
import { CURSOR_AGENT_CAPABILITIES } from './capabilities';
import { parseCursorAgentConfig } from './config';

export const DEFAULT_CURSOR_AGENT_MODEL = 'grok-4.7-high';
export const DEFAULT_CURSOR_AGENT_BINARY = 'cursor-agent';

/** The subset of a spawned child this provider uses; a test supplies a double. */
export interface CursorAgentChild {
  stdin: unknown;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(): void;
}

export interface CursorAgentSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export type CursorAgentSpawn = (
  argv: string[],
  options: CursorAgentSpawnOptions
) => CursorAgentChild;

const defaultCursorAgentSpawn: CursorAgentSpawn = (argv, options) =>
  Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  }) as unknown as CursorAgentChild;

/** Exported for tests: the exact argv, with the prompt deliberately absent. */
export function buildCursorAgentArgv(binary: string, model: string, cwd: string): string[] {
  return [
    binary,
    '--print',
    '--output-format',
    'stream-json',
    '--force',
    '--trust',
    '--workspace',
    cwd,
    '--model',
    model,
  ];
}

export class CursorAgentProvider implements IAgentProvider {
  private readonly model: string;
  private readonly binaryPath: string;
  private readonly spawn: CursorAgentSpawn;

  constructor(options?: { assistantConfig?: Record<string, unknown>; spawn?: CursorAgentSpawn }) {
    const config = parseCursorAgentConfig(options?.assistantConfig ?? {});
    this.model = config.model ?? DEFAULT_CURSOR_AGENT_MODEL;
    this.binaryPath = config.binaryPath ?? DEFAULT_CURSOR_AGENT_BINARY;
    this.spawn = options?.spawn ?? defaultCursorAgentSpawn;
  }

  getType(): string {
    return 'cursor';
  }

  getCapabilities(): ProviderCapabilities {
    return CURSOR_AGENT_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    if (!cwd) {
      throw new Error('provider:cursor requires a non-empty cwd (worktree path)');
    }
    const model = options?.model ?? this.model;
    const argv = buildCursorAgentArgv(this.binaryPath, model, cwd);
    const child = this.spawn(argv, { cwd, env: { ...process.env, ...(options?.env ?? {}) } });
    const onAbort = (): void => {
      child.kill();
    };
    options?.abortSignal?.addEventListener('abort', onAbort, { once: true });

    // Drain stderr from the start so a chatty child can never block on a full pipe.
    const stderrText = child.stderr ? new Response(child.stderr).text() : Promise.resolve('');
    // Deliver the prompt WITHOUT awaiting it before reading stdout: the child
    // reads stdin to EOF before answering, so writing and reading must overlap.
    const delivery = deliverPrompt(child.stdin, buildCursorPrompt(prompt, options));

    let finalText = '';
    let resultResultText = '';
    let servedModelId: string | null = null;
    const diagnosticBuffer: string[] = [];
    let resultIsError = false;
    let resultSubtype: string | undefined;

    try {
      if (child.stdout) {
        const decoder = new TextDecoder();
        const reader = child.stdout.getReader();
        let incompleteLine = '';

        for (;;) {
          const { done, value } = await reader.read();
          const text = decoder.decode(value, { stream: true });
          if (text.length === 0 && !done) continue;

          // Combine with any incomplete line from previous read
          const fullData = incompleteLine + text;
          const lines = fullData.split('\n');
          // The last element may be an incomplete line
          incompleteLine = lines.pop() ?? '';

          for (const line of lines) {
            if (line.trim().length === 0) continue;

            try {
              const event = JSON.parse(line);
              const chunk = processStreamEvent(event, diagnosticBuffer, () => {
                // Capture model from init event
                if (typeof event === 'object' && event !== null && 'model' in event && typeof (event as { model?: string }).model === 'string') {
                  servedModelId = (event as { model: string }).model;
                }
              });
              if (chunk) {
                yield chunk;
                if (chunk.type === 'assistant') {
                  finalText += chunk.content;
                }
              }
              
              // Capture result event data for fallback and error checking
              if (event && typeof event === 'object' && 'type' in event && event.type === 'result') {
                const resultEvent = event as { result?: string; is_error?: boolean; subtype?: string };
                if (typeof resultEvent.result === 'string') {
                  resultResultText = resultEvent.result;
                }
                if (typeof resultEvent.is_error === 'boolean') {
                  resultIsError = resultEvent.is_error;
                }
                if (typeof resultEvent.subtype === 'string') {
                  resultSubtype = resultEvent.subtype;
                }
              }
            } catch (e) {
              diagnosticBuffer.push(`Invalid JSON line: ${line.slice(0, 200)}`);
            }
          }

          if (done) break;
        }

        // Process any remaining incomplete line at EOF
        if (incompleteLine.trim().length > 0) {
          try {
            const event = JSON.parse(incompleteLine);
            const chunk = processStreamEvent(event, diagnosticBuffer, () => {
              // Capture model from init event
              if (typeof event === 'object' && event !== null && 'model' in event && typeof (event as { model?: string }).model === 'string') {
                servedModelId = (event as { model: string }).model;
              }
            });
            if (chunk) {
              yield chunk;
              if (chunk.type === 'assistant') {
                finalText += chunk.content;
              }
            }
            
            // Capture result event data for fallback and error checking
            if (event && typeof event === 'object' && 'type' in event && event.type === 'result') {
              const resultEvent = event as { result?: string; is_error?: boolean; subtype?: string };
              if (typeof resultEvent.result === 'string') {
                resultResultText = resultEvent.result;
              }
              if (typeof resultEvent.is_error === 'boolean') {
                resultIsError = resultEvent.is_error;
              }
              if (typeof resultEvent.subtype === 'string') {
                resultSubtype = resultEvent.subtype;
              }
            }
          } catch {
            diagnosticBuffer.push(`Invalid JSON line at EOF: ${incompleteLine.slice(0, 200)}`);
          }
        }
      }
      const [exitCode, stderr] = await Promise.all([child.exited, stderrText]);
      await delivery;
      if (exitCode !== 0) {
        const detail = stderr.trim().slice(-400) || 'no stderr';
        const diagnostics = diagnosticBuffer.length > 0 ? `; ${diagnosticBuffer.join(' ')}` : '';
        throw new Error(`cursor-agent exited ${exitCode} (model ${model}): ${detail}${diagnostics}`);
      }
    } finally {
      options?.abortSignal?.removeEventListener('abort', onAbort);
    }

    // Handle result event error check
    if (resultIsError || (resultSubtype !== undefined && resultSubtype !== 'success')) {
      const last400 = resultResultText.slice(-400);
      const diagnostics = diagnosticBuffer.length > 0 ? `; ${diagnosticBuffer.join(' ')}` : '';
      throw new Error(last400 + diagnostics);
    }

    // Use result.result as fallback if no assistant text was seen
    if (finalText.trim().length === 0) {
      finalText = resultResultText;
    }

    // finalText contains only assistant text (no thinking/tool text)
    if (finalText.trim().length === 0) {
      // rc 0 with no output is the Workspace Trust / auth no-op
      // (scripts/dispatch-worker/seat-preflight.ts cursorBuildResultIsEmpty).
      // Never report it as success.
      throw new Error(
        'cursor-agent exited 0 with empty output (workspace trust or authentication not granted)'
      );
    }

    let structuredOutput: unknown;
    if (options?.outputFormat?.type === 'json_schema') {
      structuredOutput = parseJsonBestEffort(finalText);
    }

    yield {
      type: 'result',
      stopReason: 'stop',
      structuredOutput,
      servedModelId,
      servedModelMissingReason: servedModelId === null ? 'cursor-agent init event did not include model field' : undefined,
    };
  }
}

/**
 * Process a single stream-json event and return a provider chunk if one should be yielded.
 * Returns null for events that don't need to be yielded (system/init).
 */
function processStreamEvent(
  event: unknown,
  diagnosticBuffer: string[],
  onInit?: () => void
): MessageChunk | null {
  if (typeof event !== 'object' || event === null) {
    diagnosticBuffer.push('Event is not an object');
    return null;
  }

  const { type, subtype } = event as { type?: string; subtype?: string };

  switch (type) {
    case 'system':
      // system/init events carry the served model; capture it but don't yield
      if (subtype === 'init') {
        onInit?.();
        return null;
      }
      return null;

    case 'assistant':
      // Join text parts from assistant messages
      const { message } = event as { message?: { content?: { type?: string; text?: string }[] } };
      const content = message?.content;
      if (Array.isArray(content)) {
        const textParts = content
          .filter((c): c is { type: string; text: string } => c.type === 'text' && typeof c.text === 'string')
          .map(c => c.text)
          .join('');
        if (textParts.length > 0) {
          return { type: 'assistant', content: textParts };
        }
      }
      return null;

    case 'thinking':
      // thinking events reset the idle timer but don't contribute to node output
      const { text } = event as { text?: string };
      if (typeof text === 'string' && text.length > 0) {
        return { type: 'thinking', content: text };
      }
      // Yield an empty progress chunk if no text
      return { type: 'thinking', content: '' };

    case 'tool_call':
      // tool_call events reset the idle timer; represent as tool/tool_result chunks
      const { subtype: toolSubtype, call_id } = event as { subtype?: string; call_id?: string };
      if (toolSubtype === 'started') {
        const toolCall = (event as { tool_call?: unknown }).tool_call;
        if (toolCall && typeof toolCall === 'object') {
          const toolName = detectToolName(toolCall);
          return { type: 'tool', toolName, toolCallId: typeof call_id === 'string' ? call_id : undefined };
        }
        return { type: 'tool', toolName: 'unknown_tool', toolCallId: typeof call_id === 'string' ? call_id : undefined };
      } else if (toolSubtype === 'completed') {
        const toolCall = (event as { tool_call?: unknown }).tool_call;
        if (toolCall && typeof toolCall === 'object') {
          const toolName = detectToolName(toolCall);
          const toolOutput = formatToolOutput(toolCall);
          return { type: 'tool_result', toolName, toolOutput, toolCallId: typeof call_id === 'string' ? call_id : undefined };
        }
        return { type: 'tool_result', toolName: 'unknown_tool', toolOutput: '' };
      }
      return null;

    case 'result':
      // result events are handled after the stream ends
      return null;

    default:
      // Unsupported event types are logged but don't fail the run
      diagnosticBuffer.push(`Unknown event type: ${String(type)}`);
      return null;
  }
}

/**
 * Detect the tool name from a tool_call object.
 */
function detectToolName(toolCall: unknown): string {
  if (typeof toolCall !== 'object' || toolCall === null) return 'unknown_tool';

  // Check for shellToolCall, editToolCall, etc.
  for (const key of Object.keys(toolCall as object)) {
    if (key.endsWith('ToolCall') && typeof (toolCall as Record<string, unknown>)[key] === 'object') {
      const inner = (toolCall as Record<string, unknown>)[key];
      if (inner && typeof inner === 'object') {
        // Return the base name without 'ToolCall' suffix
        return key.slice(0, -'ToolCall'.length).toLowerCase();
      }
    }
  }

  // Fallback: return the first property name
  for (const key of Object.keys(toolCall as object)) {
    return key;
  }
  return 'unknown_tool';
}

/**
 * Format tool output from a tool_call object.
 */
function formatToolOutput(toolCall: unknown): string {
  if (typeof toolCall !== 'object' || toolCall === null) return '';

  // For shell tool calls, include the command
  if ('shellToolCall' in toolCall && typeof (toolCall as { shellToolCall?: unknown }).shellToolCall === 'object') {
    const shell = (toolCall as { shellToolCall?: unknown }).shellToolCall;
    if (shell && typeof shell === 'object' && 'args' in shell && typeof (shell as { args?: unknown }).args === 'object') {
      const args = (shell as { args?: unknown }).args;
      if (args && typeof args === 'object' && 'command' in args && typeof (args as { command?: string }).command === 'string') {
        return (args as { command: string }).command;
      }
    }
  }

  // Fallback: JSON-serialize the tool_call
  try {
    return JSON.stringify(toolCall);
  } catch {
    return '';
  }
}

function buildCursorPrompt(prompt: string, options?: SendQueryOptions): string {
  const parts: string[] = [];
  if (options?.systemPrompt) parts.push(options.systemPrompt, '');
  parts.push(prompt);
  if (options?.outputFormat?.type === 'json_schema') {
    parts.push(
      '',
      'Respond with valid JSON only matching this schema:',
      JSON.stringify(options.outputFormat.schema)
    );
  }
  return parts.join('\n');
}

/**
 * Write the prompt and close the pipe so the child sees EOF. Rejections are
 * swallowed: a child that exits early (auth failure, bad flag) tears the pipe
 * down and the exit code, not the EPIPE, is the error that matters.
 */
async function deliverPrompt(stdin: unknown, prompt: string): Promise<void> {
  const writer = stdin as { write(chunk: string): unknown; end(): unknown } | null;
  if (!writer) return;
  try {
    await writer.write(prompt);
    await writer.end();
  } catch {
    // Child gone or pipe torn down -- see above.
  }
}

function parseJsonBestEffort(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
