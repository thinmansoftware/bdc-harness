import type { ProviderCapabilities } from '../../types';

/**
 * GLM capabilities -- intentionally conservative. Declared flags must reflect
 * wired-up behavior, not potential support. The dag-executor uses these to
 * warn users when a workflow node specifies a feature the provider ignores.
 *
 * GLM-5.2 speaks the OpenAI chat completions wire protocol (stateless REST).
 * - sessionResume: false -- no session mechanism; each sendQuery is a fresh call.
 * - mcp: false -- no MCP support in the chat completions API.
 * - hooks: false -- no SDK hook callbacks.
 * - skills: false -- no skill loading.
 * - agents: false -- no inline sub-agent definitions.
 * - toolRestrictions: false -- no per-node tool allow/deny lists.
 * - structuredOutput: true -- best-effort (JSON instruction appended to prompt,
 *   parse on result), matching the Pi provider comment. Reliable on
 *   instruction-following models; parse failures degrade gracefully.
 * - envInjection: true -- env vars passed to subprocess contexts.
 * - costControl: false -- no maxBudgetUsd enforcement.
 * - effortControl: true -- accepted but no-op stub (field silently dropped,
 *   model default used). Declared true so the dag-executor does not warn
 *   when effort: is set in a workflow node.
 * - thinkingControl: false -- no chain-of-thought control.
 * - fallbackModel: false -- no fallback model support.
 * - sandbox: false -- no sandbox mode.
 */
export const GLM_CAPABILITIES: ProviderCapabilities = {
  execution: { text: true, repositoryRead: false, repositoryWrite: false, shell: false },
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
