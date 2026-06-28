import { isRegisteredProvider, registerProvider } from '../../registry';

import { GLM_CAPABILITIES } from './capabilities';
import { GlmProvider } from './provider';

/**
 * Register the GLM community provider.
 *
 * Idempotent -- safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Kept
 * separate from registerBuiltinProviders() because builtIn: false is
 * load-bearing: GLM validates the community-provider seam and must not
 * be conflated with core providers.
 */
export function registerGlmProvider(): void {
  if (isRegisteredProvider('glm')) return;
  registerProvider({
    id: 'glm',
    displayName: 'GLM (Zhipu/Z.ai community)',
    factory: () => new GlmProvider(),
    capabilities: GLM_CAPABILITIES,
    builtIn: false,
  });
}
