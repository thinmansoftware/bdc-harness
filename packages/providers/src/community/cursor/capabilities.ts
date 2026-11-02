import type { ProviderCapabilities } from '../../types';

/**
 * Cursor agent (local `cursor-agent` CLI) capabilities.
 *
 * `--print --force --trust` runs with "access to all tools, including write and
 * shell" (cursor-agent --help, recorded in scripts/dispatch-worker/adapters.ts
 * `cursor-build`), so the provider satisfies the repository-write + shell
 * requirements that implement / repair seats derive. Sessions are not resumed
 * (each call is a fresh --print run); structured output is best-effort via
 * prompt augmentation + JSON extraction, like Pi and Grok.
 */
export const CURSOR_AGENT_CAPABILITIES: ProviderCapabilities = {
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
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
