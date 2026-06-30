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

/**
 * Register the OpenRouter alias provider under the id 'opr'.
 *
 * GlmProvider is a generic OpenRouter client (baseURL =
 * https://openrouter.ai/api/v1, no model allowlist). Registering it as
 * 'opr' lets new workflow YAML use self-documenting references such as
 * `provider: opr, model: qwen/qwen3-coder` instead of the misleading
 * 'glm' id. The 'glm' registration is preserved unchanged for backward
 * compatibility.
 *
 * Idempotent -- mirrors the registerGlmProvider() guard exactly.
 */
export function registerOprProvider(): void {
  if (isRegisteredProvider('opr')) return;
  registerProvider({
    id: 'opr',
    displayName: 'OpenRouter (Qwen / DeepSeek / GLM / any OpenRouter model)',
    factory: () => new GlmProvider(),
    capabilities: GLM_CAPABILITIES,
    builtIn: false,
  });
}
