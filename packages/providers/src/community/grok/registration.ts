import { isRegisteredProvider, registerProvider } from '../../registry';
import { GROK_AGENT_CAPABILITIES } from './capabilities';
import { GrokAgentProvider } from './provider';

/**
 * Register tool-capable Grok agent provider (OpenRouter + local tool loop).
 * Idempotent. Id: `grok`.
 *
 * Use for implement/repair seats. Do not confuse with chat-only `opr`.
 */
export function registerGrokAgentProvider(): void {
  if (isRegisteredProvider('grok')) return;
  registerProvider({
    id: 'grok',
    displayName: 'Grok agent (OpenRouter + local tools)',
    factory: () => new GrokAgentProvider(),
    capabilities: GROK_AGENT_CAPABILITIES,
    builtIn: false,
  });
}
