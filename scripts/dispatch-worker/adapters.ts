export type AgentKind = 'prompt' | 'fusion' | 'acp';

export interface AgentConfig {
  kind?: AgentKind;
  command: string;
  args: string[];
  /**
   * ACP-only (kind: 'acp'), all optional with safe defaults.
   *
   * WO-HARNESS-ACP-DISPATCH-SLICE-01 / M-118: an ACP agent is spawned once per
   * dispatch message and driven over a live stdio session instead of a
   * one-shot CLI call. The `prompt` kind remains the compatibility fallback
   * the ruling requires us to keep (order 5).
   */
  acp?: {
    /** authMethodId sent in `authenticate`; omit to skip the call entirely. */
    authMethodId?: string;
    /** No session/update for this long -> cancel. */
    idleTimeoutMs?: number;
    /** Total run longer than this -> cancel. */
    wallClockMs?: number;
    /** Grace between session/cancel and the process-tree kill. */
    killGraceMs?: number;
  };
}

export const ACP_DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const ACP_DEFAULT_WALL_CLOCK_MS = 1_800_000;
export const ACP_DEFAULT_KILL_GRACE_MS = 5_000;
export const MAX_PROMPT_STDIN_BYTES = 1_048_576;

export interface FusionReviewRequest {
  wo: string;
  diff: string;
  tests: string;
  manifest: string;
  ci?: boolean;
}

export const defaultAgentConfigs: Record<string, AgentConfig> = {
  claude: {
    command: 'claude',
    args: ['--permission-mode', 'plan', '-p'],
  },
  codex: {
    command: 'codex',
    args: [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--ignore-user-config',
    ],
  },
  grok: {
    command: 'grok',
    args: ['--permission-mode', 'plan', '--no-subagents', '-p'],
  },
  cursor: {
    command: 'cursor-agent',
    args: ['--print', '--mode', 'ask', '--trust'],
  },
  fusion: {
    kind: 'fusion',
    command: 'bun',
    args: [],
  },
  /**
   * ACP seats (M-118 vertical slice). Registered alongside -- not instead of --
   * the CLI entries above, which remain the ruling-mandated fallback.
   *
   * grok-acp: proven live on this machine (grok 0.2.118, cached_token auth,
   * full initialize/authenticate/session-new/session-prompt handshake) per
   * M-20260802-118.acp-compatibility-proof.md.
   *
   * claude-acp: @zed-industries/claude-code-acp, run via npx so the wrapper
   * does not have to be globally installed. Rides the existing Claude Code
   * login; if it ever demands a raw API key that is a finding to report, not
   * something to work around (WO scope wall).
   */
  'grok-acp': {
    kind: 'acp',
    command: 'grok',
    args: ['agent', 'stdio'],
    acp: { authMethodId: 'cached_token' },
  },
  'claude-acp': {
    kind: 'acp',
    command: 'npx',
    args: ['-y', '@zed-industries/claude-code-acp'],
    acp: {},
  },
};

export function buildAgentInvocation(
  config: AgentConfig,
  // Retained for call-site/test compatibility; no longer used for argv substitution.
  _prompt: string
): { command: string; args: string[] } {
  return {
    command: config.command,
    args: [...config.args],
  };
}

export function parseFusionReviewBody(body: string): FusionReviewRequest {
  try {
    const value = JSON.parse(body) as Partial<FusionReviewRequest>;
    if (
      !value ||
      typeof value.wo !== 'string' ||
      typeof value.diff !== 'string' ||
      typeof value.tests !== 'string' ||
      typeof value.manifest !== 'string'
    ) {
      throw new Error('invalid shape');
    }
    return {
      wo: value.wo,
      diff: value.diff,
      tests: value.tests,
      manifest: value.manifest,
      ...(value.ci === true ? { ci: true } : {}),
    };
  } catch {
    throw new Error('fusion_review_body_invalid');
  }
}
