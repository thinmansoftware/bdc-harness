import { isRegisteredProvider, registerProvider } from '../../registry';
import { CURSOR_AGENT_CAPABILITIES } from './capabilities';
import { CursorAgentProvider } from './provider';

/**
 * Register the Cursor agent provider (local cursor-agent CLI on the operator's
 * Cursor subscription). Idempotent. Id: `cursor`.
 *
 * Build-capable (--print --force --trust): usable for implement/repair seats
 * as well as review seats on a different model (see the
 * bdc-feature-development-cursor lane).
 */
export function registerCursorAgentProvider(): void {
  if (isRegisteredProvider('cursor')) return;
  registerProvider({
    id: 'cursor',
    displayName: 'Cursor agent (cursor-agent CLI, local subscription)',
    factory: () => new CursorAgentProvider(),
    capabilities: CURSOR_AGENT_CAPABILITIES,
    builtIn: false,
  });
}
