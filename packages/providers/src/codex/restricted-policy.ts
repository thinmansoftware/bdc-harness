import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk';
import type { SendQueryOptions } from '../types';

// Unregistered source candidate. Runtime admission additionally requires the
// inspected worker container and immutable config/skill masks in the governed WO.
export const RESTRICTED_WORKSPACE = '/workspace';
export const RESTRICTED_MODEL = 'gpt-5.6-sol';
export const RESTRICTED_BINARY =
  '/app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';

export function validateRestrictedRequest(
  cwd: string,
  resumeId: string | undefined,
  ownedSessions: ReadonlySet<string>,
  options?: SendQueryOptions,
  parentCwd: string = process.cwd()
): void {
  if (cwd !== RESTRICTED_WORKSPACE || parentCwd !== RESTRICTED_WORKSPACE) {
    throw new Error('Restricted Codex requires its dedicated /workspace worker');
  }
  if (resumeId !== undefined && !ownedSessions.has(resumeId)) {
    throw new Error('Restricted Codex refuses an unowned session');
  }
  if (options?.model !== undefined && options.model !== RESTRICTED_MODEL) {
    throw new Error('Restricted Codex model override rejected');
  }
  for (const value of [options?.env, options?.assistantConfig, options?.nodeConfig]) {
    if (value && Object.keys(value).length)
      throw new Error('Restricted Codex configuration override rejected');
  }
  if (
    options?.fallbackModel !== undefined ||
    options?.forkSession ||
    options?.persistSession === false
  ) {
    throw new Error('Restricted Codex fallback/session override rejected');
  }
}

export function restrictedClientOptions(): CodexOptions {
  return {
    codexPathOverride: RESTRICTED_BINARY,
    env: {
      HOME: '/home/appuser',
      CODEX_HOME: '/home/appuser/.codex',
      PATH: '/usr/local/bin:/usr/bin:/bin',
    },
    config: {
      default_permissions: 'tee-time',
      model_provider: 'openai',
      notify: [],
      agents: { enabled: false },
      skills: { bundled: { enabled: false }, include_instructions: false },
      features: {
        hooks: false,
        apps: false,
        plugins: false,
        remote_plugin: false,
        multi_agent: false,
        multi_agent_v2: false,
        skip_host_skill_discovery: true,
      },
      permissions: { 'tee-time': { extends: ':workspace', network: { enabled: false } } },
      shell_environment_policy: { inherit: 'none', set: { PATH: '/usr/local/bin:/usr/bin:/bin' } },
    },
    configOverrides: [
      'permissions.tee-time.filesystem={":root"="deny",":minimal"="read","/app"="read",":slash_tmp"="deny",":tmpdir"="deny"}',
    ],
  };
}

export function restrictedThreadOptions(): ThreadOptions {
  // Do not emit legacy --sandbox / sandbox_workspace_write options after the
  // named policy: the SDK applies thread options last.
  return {
    workingDirectory: RESTRICTED_WORKSPACE,
    skipGitRepoCheck: true,
    model: RESTRICTED_MODEL,
    approvalPolicy: 'never',
    webSearchMode: 'disabled',
    additionalDirectories: [],
  };
}
