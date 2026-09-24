import { registerProvider, registerProviderAlias, resolveProviderId } from '../../registry';
import { setOpenRouterProviderIdResolver } from '../../openrouter-guard';
import { GROK_AGENT_CAPABILITIES } from './capabilities';
import { GrokAgentProvider } from './provider';

/**
 * Register the tool-loop OpenRouter agent (open models + local tool loop).
 * Idempotent. Id: `openrouter`. `grok` remains a deprecated alias.
 *
 * Use for implement/repair seats. Do not confuse with chat-only `opr`.
 *
 * Idempotency is a local flag, not isRegisteredProvider('openrouter'). A caller
 * that stubs isRegisteredProvider to true (the /run route tests do) would
 * otherwise skip the grok alias and leave xAI checks blind to that id.
 */
let grokAgentRegistered = false;

/** @internal Test-only -- clearRegistry calls this so a later register is not a no-op. */
export function resetGrokAgentProviderRegistration(): void {
  grokAgentRegistered = false;
}

export function registerGrokAgentProvider(): void {
  setOpenRouterProviderIdResolver(resolveProviderId);
  if (grokAgentRegistered) return;
  registerProvider({
    id: 'openrouter',
    displayName: 'OpenRouter agent (open models + local tools)',
    factory: () => new GrokAgentProvider(),
    capabilities: GROK_AGENT_CAPABILITIES,
    builtIn: false,
  });
  // @deprecated Legacy id. New YAML and events use `openrouter`.
  registerProviderAlias('grok', 'openrouter');
  grokAgentRegistered = true;
}
