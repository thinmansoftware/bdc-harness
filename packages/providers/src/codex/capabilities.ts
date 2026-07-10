import type { ProviderCapabilities } from '../types';

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  execution: { text: true, repositoryRead: true, repositoryWrite: true, shell: true },
  sessionResume: true,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
