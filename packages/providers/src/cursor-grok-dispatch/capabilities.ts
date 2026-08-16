import type { ProviderCapabilities } from '../types';

export const CURSOR_GROK_DISPATCH_CAPABILITIES: ProviderCapabilities = {
  execution: {
    text: true,
    repositoryRead: true,
    repositoryWrite: true,
    shell: true,
  },
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: false,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
