import type { ProviderCapabilities } from '../../types';

/**
 * Grok agent (OpenRouter + local tool loop) capabilities.
 *
 * Unlike chat-only GlmProvider/opr, this provider executes tools in the
 * worktree cwd (bash, read/write/edit files). That is the minimum required for
 * implement loops on fusion lanes when Codex/Claude seats are exhausted.
 *
 * Anchor: run 2ef0aa43 -- chat-only opr + x-ai/grok-4.5 reported
 * "no shell/filesystem tools" and never wrote files.
 */
export const GROK_AGENT_CAPABILITIES: ProviderCapabilities = {
  execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: true,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
