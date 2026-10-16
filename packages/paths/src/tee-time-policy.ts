import { createHash } from 'node:crypto';

export const TEE_TIME_REPOSITORY = 'thinmansoftware/whats-that-tee-time';
export const TEE_TIME_WORKFLOW = 'bdc-teetime-foundation';
export const TEE_TIME_MODELS = Object.freeze({
  cursor: 'grok-4.7-high',
  'codex-native-strict': 'gpt-5.6-sol',
});

export function policyDigest(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)])
      );
    }
    return item;
  }
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

export const TEE_TIME_POLICY = Object.freeze({
  version: 1,
  repository: TEE_TIME_REPOSITORY,
  workflow: TEE_TIME_WORKFLOW,
  models: TEE_TIME_MODELS,
  escalation: false,
  demoFeatures: false,
});
export const TEE_TIME_POLICY_HASH = policyDigest(TEE_TIME_POLICY);

export function isTeeTimeProject(project: string | null | undefined): boolean {
  return (
    project?.toLowerCase() === TEE_TIME_REPOSITORY ||
    project?.toLowerCase() === 'whats-that-tee-time'
  );
}

export function isTeeTimeRequest(message: string): boolean {
  return /\bWO-TEETIME-|\bwhats-that-tee-time\b|\bbdc-teetime-/i.test(message);
}

export function policyBlocked(reason: string): never {
  throw new Error(`tee_time_policy_blocked: ${reason}`);
}

export function resolveTeeTimePolicy(
  codebase: { id: string; name: string; repository_url: string | null } | null,
  message: string
): boolean {
  const named = isTeeTimeProject(codebase?.name);
  const remote = codebase?.repository_url
    ?.replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
  const matchingRemote =
    remote === `https://github.com/${TEE_TIME_REPOSITORY}` ||
    remote === `git@github.com:${TEE_TIME_REPOSITORY}`;
  if (!named && !matchingRemote && !isTeeTimeRequest(message)) return false;
  if (!codebase?.id || codebase.name.toLowerCase() !== TEE_TIME_REPOSITORY || !matchingRemote) {
    policyBlocked('stored codebase identity does not match restricted project');
  }
  return true;
}

export function assertTeeTimeProvider(provider: string, model?: string, requireModel = true): void {
  if (!Object.hasOwn(TEE_TIME_MODELS, provider))
    policyBlocked(`provider ${provider} is not permitted`);
  if (requireModel && model !== TEE_TIME_MODELS[provider as keyof typeof TEE_TIME_MODELS]) {
    policyBlocked(`model for ${provider} is not permitted`);
  }
}

export function teeTimeRunPolicy(
  codebaseId: string,
  workflowDigest: string,
  woId: string
): Record<string, unknown> {
  return { hash: TEE_TIME_POLICY_HASH, codebaseId, workflowDigest, woId };
}

export function assertTeeTimeAuthority(
  policy: Record<string, unknown> | null,
  authority: { woId: string } | null | undefined
): void {
  if (policy && authority?.woId !== policy.woId)
    policyBlocked('frozen authority does not match policy WO');
}

export function assertTeeTimeRunPolicy(actual: unknown, expected: Record<string, unknown>): void {
  if (policyDigest(actual ?? null) !== policyDigest(expected))
    policyBlocked('missing or changed persisted run policy');
}
