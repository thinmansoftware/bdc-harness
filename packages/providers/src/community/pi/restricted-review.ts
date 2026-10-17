// Loaded only after PiProvider validates the restricted request and package shim.
import * as pi from '@mariozechner/pi-coding-agent';
import type { MessageChunk } from '../../types';
import { bridgeSession } from './event-bridge';
import {
  REVIEW_PROVIDER,
  REVIEW_MODEL,
  REVIEW_DIGEST,
  REVIEW_ENDPOINT,
  REVIEW_SYSTEM,
  isRestrictedReviewSystem,
  parseReviewVerdict,
} from './restricted-review-policy';

async function verifyModelIdentity(signal: AbortSignal): Promise<void> {
  const response = await fetch(`${REVIEW_ENDPOINT}/api/tags`, { redirect: 'error', signal });
  if (!response.ok) throw new Error('local review model inventory unavailable');
  const inventory = (await response.json()) as { models?: { name?: string; digest?: string }[] };
  const matches = inventory.models?.filter(model => model.name === REVIEW_MODEL) ?? [];
  if (matches.length !== 1 || matches[0].digest !== REVIEW_DIGEST)
    throw new Error('local review model digest mismatch');
  const loadedResponse = await fetch(`${REVIEW_ENDPOINT}/api/ps`, { redirect: 'error', signal });
  if (!loadedResponse.ok) throw new Error('review capacity inventory unavailable');
  const loaded = (await loadedResponse.json()) as {
    models?: { name?: string; digest?: string; context_length?: number }[];
  };
  const running = loaded.models?.filter(model => model.name === REVIEW_MODEL) ?? [];
  if (
    running.length !== 1 ||
    running[0].digest !== REVIEW_DIGEST ||
    running[0].context_length !== 8192
  )
    throw new Error('review model capacity not qualified');
}

export async function* runRestrictedReview(
  prompt: string,
  abortSignal?: AbortSignal
): AsyncGenerator<MessageChunk> {
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    if (process.env[key]) throw new Error('review worker must not inherit proxy configuration');
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(90000),
    ...(abortSignal ? [abortSignal] : []),
  ]);
  await verifyModelIdentity(signal);
  const authStorage = pi.AuthStorage.inMemory();
  // Local endpoint has no auth. A literal placeholder prevents ambient key lookup.
  authStorage.setRuntimeApiKey(REVIEW_PROVIDER, 'local-no-auth');
  const modelRegistry = pi.ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(REVIEW_PROVIDER, {
    apiKey: 'local-no-auth',
    baseUrl: `${REVIEW_ENDPOINT}/v1`,
    api: 'openai-completions',
    authHeader: false,
    models: [
      {
        id: REVIEW_MODEL,
        name: 'Tee-time local review candidate',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    ],
  });
  const model = modelRegistry.find(REVIEW_PROVIDER, REVIEW_MODEL);
  if (model?.baseUrl !== `${REVIEW_ENDPOINT}/v1`)
    throw new Error('review model definition mismatch');
  const settingsManager = pi.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
  });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: '/workspace',
    agentDir: '/home/appuser/.pi/teetime-review',
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: REVIEW_SYSTEM,
    appendSystemPrompt: [],
  });
  await resourceLoader.reload();
  if (
    resourceLoader.getSystemPrompt() !== REVIEW_SYSTEM ||
    resourceLoader.getAppendSystemPrompt().length !== 0 ||
    resourceLoader.getExtensions().extensions.length !== 0 ||
    resourceLoader.getExtensions().errors.length !== 0 ||
    resourceLoader.getSkills().skills.length !== 0 ||
    resourceLoader.getPrompts().prompts.length !== 0 ||
    resourceLoader.getAgentsFiles().agentsFiles.length !== 0
  )
    throw new Error('restricted review resources mismatch');
  const { session, modelFallbackMessage, extensionsResult } = await pi.createAgentSession({
    cwd: '/workspace',
    agentDir: '/home/appuser/.pi/teetime-review',
    model,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: pi.SessionManager.inMemory('/workspace'),
    tools: [],
    customTools: [],
    scopedModels: [],
  });
  function verifySession(): void {
    if (
      modelFallbackMessage ||
      !isRestrictedReviewSystem(session.systemPrompt) ||
      session.model?.id !== REVIEW_MODEL ||
      session.model.provider !== REVIEW_PROVIDER ||
      session.model.baseUrl !== `${REVIEW_ENDPOINT}/v1` ||
      session.getActiveToolNames().length !== 0 ||
      extensionsResult.extensions.length !== 0 ||
      extensionsResult.errors.length !== 0
    )
      throw new Error('restricted review session mismatch or fallback');
  }
  let bridgeOwnsCleanup = false;
  let text = '';
  let terminal: Extract<MessageChunk, { type: 'result' }> | undefined;
  try {
    verifySession();
    bridgeOwnsCleanup = true;
    for await (const chunk of bridgeSession(session, prompt, signal)) {
      if (chunk.type === 'assistant') {
        text += chunk.content;
        if (text.length > 6000) throw new Error('review output exceeds bound');
      } else if (chunk.type === 'result') {
        if (terminal || chunk.isError || chunk.stopReason !== 'stop')
          throw new Error('review failed or output truncated');
        terminal = chunk;
      } else if (chunk.type !== 'thinking') {
        throw new Error('unexpected restricted review action');
      }
    }
    verifySession();
    if (!terminal) throw new Error('missing terminal review result');
    await verifyModelIdentity(signal);
    let verdict;
    try {
      verdict = parseReviewVerdict(text);
    } catch (error) {
      // Opt-in diagnostic for isolated synthetic qualification only. Never enabled
      // by the shared server or ordinary review path; not an accepted result.
      if (
        process.platform === 'linux' &&
        process.cwd() === '/workspace' &&
        process.env.TEE_TIME_REVIEW_WORKER === '1' &&
        process.env.TEE_TIME_SYNTHETIC_REVIEW_DIAGNOSTICS === '1'
      ) {
        console.error(
          JSON.stringify({
            type: 'synthetic_review_diagnostic',
            category: error instanceof SyntaxError ? 'invalid_json' : 'invalid_schema',
            rawResponse: text.slice(0, 6000),
            stopReason: terminal.stopReason,
            tokens: terminal.tokens,
          })
        );
      }
      throw error;
    }
    yield { type: 'assistant', content: JSON.stringify(verdict) };
    yield {
      ...terminal,
      structuredOutput: verdict,
      servedModelId: null,
      servedModelMissingReason:
        'local_tag_digest_checked_before_after_not_digest_addressed_inference',
    };
  } finally {
    // The shared bridge owns disposal once iteration starts. Before that point
    // no prompt has started, so only dispose (never abort a disposed session).
    if (!bridgeOwnsCleanup) session.dispose();
  }
}
