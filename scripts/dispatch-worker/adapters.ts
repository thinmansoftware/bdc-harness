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

export interface FusionReviewRequest {
  wo: string;
  diff: string;
  tests: string;
  manifest: string;
  ci?: boolean;
}

/**
 * Maximum prompt payload delivered over stdin to a prompt-kind agent child.
 *
 * WO-HARNESS-DISPATCH-STDIN-PROMPT-01 / M-126 disposition Q1 (RATIFIED 3-0,
 * 2026-08-04): cap at 1 MiB of UTF-8 bytes, checked before spawn. Oversize
 * prompts fail durably with the measured byte count instead of hanging or
 * truncating silently.
 */
export const MAX_PROMPT_STDIN_BYTES = 1_048_576;

/**
 * Pure, side-effect-free size guard for prompt-kind stdin delivery. Returns an
 * honest failure reason (including the measured byte count and the limit) when
 * the rendered prompt exceeds MAX_PROMPT_STDIN_BYTES.
 */
export function checkPromptStdinSize(
  byteLength: number
): { ok: true } | { ok: false; reason: string } {
  if (byteLength > MAX_PROMPT_STDIN_BYTES) {
    return {
      ok: false,
      reason:
        `prompt payload is ${byteLength} bytes, which exceeds the stdin ` +
        `delivery cap of ${MAX_PROMPT_STDIN_BYTES} bytes (1 MiB); refusing to spawn`,
    };
  }
  return { ok: true };
}

/**
 * Argv placeholder used by LEGACY argv-delivery seats: the rendered prompt is
 * substituted into this exact argv element. It is meaningful ONLY for seats
 * that are argv seats by identity (see STDIN_PROMPT_SEATS below). It is NOT a
 * transport switch -- its presence can never move an argv-hard-removed seat
 * back onto argv.
 */
export const PROMPT_ARGV_PLACEHOLDER = '{{prompt}}';

/**
 * Seats whose argv prompt delivery is HARD-REMOVED
 * (WO-HARNESS-DISPATCH-STDIN-PROMPT-01 / M-126 disposition Q2, Scope IN).
 *
 * Transport for these seats is a property of the SEAT IDENTITY, not of its
 * config. This is deliberate: `readConfig` merges operator config over the
 * defaults wholesale, so if transport were inferred from `args` content, a
 * config that re-added `{{prompt}}` to claude/codex would silently restore
 * argv delivery -- resurrecting the process-list leak and the Windows argv
 * size cliff via config drift. That opt-in is exactly what Q2 forbids, so a
 * stdin seat is stdin under every possible config.
 */
export const STDIN_PROMPT_SEATS: ReadonlySet<string> = new Set(['claude', 'codex']);

/**
 * Prompt delivery transport for a seat, decided purely by seat NAME:
 *  - 'stdin' -> claude/codex (Scope IN). The prompt is written to the child's
 *               stdin and never enters argv. Not config-overridable.
 *  - 'argv'  -> every other prompt-kind seat (grok/cursor and any
 *               operator-defined seat, Scope OUT). Their CLIs are not proven
 *               stdin-capable, so their transport is intentionally UNCHANGED
 *               from the pre-WO baseline (board Q3 residual).
 */
export function seatPromptDelivery(seat: string): 'argv' | 'stdin' {
  return STDIN_PROMPT_SEATS.has(seat) ? 'stdin' : 'argv';
}

/**
 * Fail-closed guard for config drift on argv-hard-removed seats.
 *
 * A stdin seat carrying `{{prompt}}` in its configured args is rejected loudly
 * rather than (a) silently restoring argv delivery or (b) passing the literal
 * `{{prompt}}` string through to the CLI as a real argument. Both of those are
 * regressions this WO exists to prevent, so the misconfiguration is surfaced to
 * the operator instead of being absorbed.
 */
export function assertNoLegacyPromptPlaceholder(seat: string, config: AgentConfig): void {
  if (!STDIN_PROMPT_SEATS.has(seat)) return;
  if (config.args.includes(PROMPT_ARGV_PLACEHOLDER)) {
    throw new Error(
      `agent seat "${seat}" delivers its prompt over stdin; remove the legacy ` +
        `"${PROMPT_ARGV_PLACEHOLDER}" element from its configured args ` +
        '(argv prompt delivery was removed for this seat and cannot be re-enabled by config)'
    );
  }
}

/**
 * Default seat configs, split by prompt-delivery transport
 * (WO-HARNESS-DISPATCH-STDIN-PROMPT-01 / M-126 disposition Q2):
 *
 *  - claude, codex (Scope IN): stdin delivery. Their `args` carry only flags --
 *    no `{{prompt}}` placeholder -- so the prompt never appears in argv or the
 *    process list. Argv delivery is hard-removed by seat identity: re-adding
 *    the placeholder in config does NOT restore it, it is rejected.
 *  - grok, cursor (Scope OUT): their CLIs are NOT proven stdin-capable, so this
 *    WO must NOT change their transport. They retain the `{{prompt}}`
 *    placeholder and stay argv-cliffed (explicit residual, board Q3). A future
 *    stdin conversion for them is a separate WO with its own tests.
 */
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
    args: ['--permission-mode', 'plan', '--no-subagents', '-p', PROMPT_ARGV_PLACEHOLDER],
  },
  cursor: {
    command: 'cursor-agent',
    args: ['--print', '--mode', 'ask', '--trust', PROMPT_ARGV_PLACEHOLDER],
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

/**
 * Builds the spawn command/args for a prompt-kind seat and reports how the
 * prompt is delivered (WO-HARNESS-DISPATCH-STDIN-PROMPT-01). Transport is
 * chosen by `seat` NAME via seatPromptDelivery -- never by args content:
 *
 *  - stdin seats (claude/codex): the returned `args` are the seat's static
 *    flags (a defensive copy so callers cannot mutate the shared config) and
 *    `delivery` is 'stdin'. The caller writes the prompt to the child's stdin;
 *    it never enters argv. A configured `{{prompt}}` here is rejected.
 *  - argv seats (grok/cursor and operator-defined seats): the placeholder
 *    element is replaced by `prompt` and `delivery` is 'argv'. `prompt` is
 *    required for these seats; omitting it is a programming error.
 */
export function buildAgentInvocation(
  seat: string,
  config: AgentConfig,
  prompt?: string
): { command: string; args: string[]; delivery: 'argv' | 'stdin' } {
  const delivery = seatPromptDelivery(seat);
  if (delivery === 'stdin') {
    assertNoLegacyPromptPlaceholder(seat, config);
    return { command: config.command, args: [...config.args], delivery };
  }
  if (prompt === undefined) {
    throw new Error('argv_delivery_seat_requires_prompt');
  }
  const rendered = config.args.map(argValue =>
    argValue === PROMPT_ARGV_PLACEHOLDER ? prompt : argValue
  );
  return { command: config.command, args: rendered, delivery };
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
