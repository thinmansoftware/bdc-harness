/**
 * Provider Registry
 *
 * Typed registry where each entry is a ProviderRegistration record (factory + metadata).
 * Replaces the hardcoded factory switch from Phase 1.
 *
 * Bootstrap: callers must call registerBuiltinProviders() at process entrypoints
 * (server startup, CLI init) before any provider lookups.
 */
import type {
  IAgentProvider,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
  ProviderExecutionCapability,
} from './types';
import { ClaudeProvider } from './claude/provider';
import { CodexProvider } from './codex/provider';
import { CLAUDE_CAPABILITIES } from './claude/capabilities';
import { CODEX_CAPABILITIES } from './codex/capabilities';
import { registerPiProvider } from './community/pi/registration';
import {
  registerGlmProvider,
  registerOprProvider,
  registerOprZeroProvider,
} from './community/glm/registration';
import { registerGrokAgentProvider, resetGrokAgentProviderRegistration } from './community/grok/registration';
import { registerCursorAgentProvider } from './community/cursor/registration';
import { GlmProvider } from './community/glm/provider';
import { UnknownProviderError } from './errors';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.registry');
  return cachedLog;
}

/** Backing store for registered providers. */
const registry = new Map<string, ProviderRegistration>();

/** Legacy ids that resolve to a real provider. Never listed as their own provider. */
const aliases = new Map<string, string>();

/**
 * Map a legacy provider id onto an already-registered id.
 * Throws if `alias` is already a provider id or an alias.
 */
export function registerProviderAlias(alias: string, targetId: string): void {
  if (registry.has(alias) || aliases.has(alias)) {
    throw new Error(`Provider alias '${alias}' is already registered`);
  }
  aliases.set(alias, targetId);
}

/** Alias to its target id. An unknown or real id is returned unchanged. */
export function resolveProviderId(id: string): string {
  return aliases.get(id) ?? id;
}

/**
 * Register a provider. Throws on duplicate registration or if the id is an alias.
 */
export function registerProvider(entry: ProviderRegistration): void {
  if (aliases.has(entry.id)) {
    throw new Error(`Provider '${entry.id}' is already registered as an alias`);
  }
  if (registry.has(entry.id)) {
    throw new Error(`Provider '${entry.id}' is already registered`);
  }
  registry.set(entry.id, entry);
  getLog().debug({ provider: entry.id, builtIn: entry.builtIn }, 'provider.registered');
}

/**
 * Get an instantiated agent provider by ID.
 * @throws UnknownProviderError if not registered
 */
export function getAgentProvider(id: string): IAgentProvider {
  const resolved = resolveProviderId(id);
  const entry = registry.get(resolved);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
  }
  getLog().debug({ provider: resolved }, 'provider_selected');
  return entry.factory();
}

/**
 * Get the full registration entry for a provider.
 * @throws UnknownProviderError if not registered
 */
export function getRegistration(id: string): ProviderRegistration {
  const resolved = resolveProviderId(id);
  const entry = registry.get(resolved);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
  }
  return entry;
}

/**
 * Get provider capabilities without instantiating a provider.
 * @throws UnknownProviderError if not registered
 */
export function getProviderCapabilities(id: string): ProviderCapabilities {
  return getRegistration(id).capabilities;
}

/** Return required execution capabilities the provider cannot supply. */
export function getMissingProviderExecutionCapabilities(
  id: string,
  required: readonly ProviderExecutionCapability[]
): ProviderExecutionCapability[] {
  const execution = getProviderCapabilities(id).execution;
  return required.filter(capability => !execution[capability]);
}

/**
 * Get all registered providers.
 */
export function getRegisteredProviders(): ProviderRegistration[] {
  return [...registry.values()];
}

/**
 * Get API-safe provider info (excludes the factory).
 */
export function getProviderInfoList(): ProviderInfo[] {
  return getRegisteredProviders().map(({ id, displayName, capabilities, builtIn }) => ({
    id,
    displayName,
    capabilities,
    builtIn,
  }));
}

/**
 * Check if a provider is registered.
 */
export function isRegisteredProvider(id: string): boolean {
  return registry.has(resolveProviderId(id));
}

/**
 * Register built-in providers (Claude, Codex). Idempotent -- skips already-registered IDs.
 * Must be called at process entrypoints (server, CLI) before any provider lookups.
 */
export function registerBuiltinProviders(): void {
  const builtins: ProviderRegistration[] = [
    {
      id: 'claude',
      displayName: 'Claude (Anthropic)',
      factory: () => new ClaudeProvider(),
      capabilities: CLAUDE_CAPABILITIES,
      builtIn: true,
    },
    {
      id: 'codex',
      displayName: 'Codex (OpenAI)',
      // WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01: wire ClaudeProvider as the
      // failback factory so terminal Codex failures (rollout-missing after restart,
      // crash retries exhausted) delegate to a Claude reviewer with disclosure
      // rather than blocking the review gate. The factory is invoked lazily inside
      // sendQuery so the Claude instance is constructed only when actually needed.
      factory: () => new CodexProvider({ failbackProviderFactory: () => new ClaudeProvider() }),
      capabilities: CODEX_CAPABILITIES,
      builtIn: true,
    },
    {
      id: 'codex-opr',
      displayName: 'Codex with OpenRouter failback',
      factory: () =>
        new CodexProvider({
          failbackProviderFactory: () =>
            new GlmProvider({
              assistantConfig: { model: 'deepseek/deepseek-chat-v3.1' },
              failbackProviderFactory: null,
            }),
          failbackLabel: 'OpenRouter',
          failbackEventName: 'codex_failback_to_openrouter',
        }),
      capabilities: CODEX_CAPABILITIES,
      builtIn: true,
    },
  ];

  for (const entry of builtins) {
    if (!registry.has(entry.id)) {
      registry.set(entry.id, entry);
      getLog().debug({ provider: entry.id }, 'builtin_provider.registered');
    }
  }
}

/**
 * Register all bundled community providers in one call.
 *
 * Process entrypoints (server, CLI, config-loader) call this once after
 * `registerBuiltinProviders()`. Adding a new community provider means:
 *   1. Drop the implementation under `packages/providers/src/community/<id>/`.
 *   2. Export a `register<Name>Provider()` function from it.
 *   3. Import + call it here.
 *
 * That's the entire cross-cutting change outside the provider's own
 * directory. No entrypoint edits, no config-type edits -- just add a line
 * to this function. That's the Phase 2 contract (#1195): community
 * providers are a localized addition.
 *
 * Each `register*Provider` is itself idempotent, so calling this
 * aggregator multiple times (e.g. from both CLI and config-loader paths)
 * is safe. Errors during registration are not caught here -- a broken
 * community provider should fail loud at bootstrap, not silently
 * disappear.
 */
export function registerCommunityProviders(): void {
  registerPiProvider();
  // WO-HARNESS-SMART-CAULDRON-LANE-ROSTER-AND-RESILIENCE-01: wire ClaudeProvider
  // as the availability failback for both glm and opr providers. When OpenRouter
  // is unavailable (5xx / timeout / network), the task delegates to Claude with
  // a [GLM FAILBACK] disclosure chunk rather than dying.
  registerGlmProvider({ failbackProviderFactory: () => new ClaudeProvider() });
  registerOprProvider({ failbackProviderFactory: () => new ClaudeProvider() });
  registerOprZeroProvider();
  // WO-HARNESS-GROK-AGENT-PROVIDER-01: tool-capable Grok implement seat (OpenRouter
  // + local tool loop). Chat-only opr must NOT be used for implement.
  registerGrokAgentProvider();
  // PR #848: Cursor rail -- local cursor-agent CLI on the operator's Cursor
  // subscription. Build-capable; used by bdc-feature-development-cursor.
  registerCursorAgentProvider();
}

/** @internal Test-only -- clears the registry. Not for production use. */
export function clearRegistry(): void {
  registry.clear();
  aliases.clear();
  resetGrokAgentProviderRegistration();
}
