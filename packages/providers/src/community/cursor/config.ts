export interface CursorAgentProviderDefaults {
  [key: string]: unknown;
  /** cursor-agent model id as listed by `cursor-agent --list-models`. */
  model?: string;
  /** Path to the cursor-agent binary. Defaults to `cursor-agent` on PATH. */
  binaryPath?: string;
}

export function parseCursorAgentConfig(raw: Record<string, unknown>): CursorAgentProviderDefaults {
  const result: CursorAgentProviderDefaults = {};
  if (typeof raw.model === 'string' && raw.model.trim().length > 0) result.model = raw.model.trim();
  if (typeof raw.binaryPath === 'string' && raw.binaryPath.trim().length > 0) {
    result.binaryPath = raw.binaryPath.trim();
  }
  return result;
}
