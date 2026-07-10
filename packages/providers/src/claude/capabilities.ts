import type { ProviderCapabilities } from '../types';

export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: true,
  envInjection: true,
  costControl: true,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: true,
  sandbox: true,
};
