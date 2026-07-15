export type AgentKind = 'prompt' | 'fusion';

export interface AgentConfig {
  kind?: AgentKind;
  command: string;
  args: string[];
}

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
    args: ['--permission-mode', 'plan', '-p', '{{prompt}}'],
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
      '{{prompt}}',
    ],
  },
  grok: {
    command: 'grok',
    args: ['--permission-mode', 'plan', '--no-subagents', '-p', '{{prompt}}'],
  },
  cursor: {
    command: 'cursor-agent',
    args: ['--print', '--mode', 'ask', '--trust', '{{prompt}}'],
  },
  fusion: {
    kind: 'fusion',
    command: 'bun',
    args: [],
  },
};

export function buildAgentInvocation(
  config: AgentConfig,
  prompt: string
): { command: string; args: string[] } {
  return {
    command: config.command,
    args: config.args.map(arg => (arg === '{{prompt}}' ? prompt : arg)),
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
