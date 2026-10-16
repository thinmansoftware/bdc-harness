import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Immutable for this process. Loaded environment must agree before server startup.
export const OFFLINE_QUALIFICATION = process.env.ARCHON_OFFLINE_QUALIFICATION === '1';

export function assertExecutionEnabled(): void {
  if (OFFLINE_QUALIFICATION) throw new Error('offline_qualification_execution_disabled');
}

export function validateOfflineQualification(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  exists: (path: string) => boolean = existsSync
): void {
  const requested = env.ARCHON_OFFLINE_QUALIFICATION;
  if (requested !== undefined && requested !== '1')
    throw new Error('offline_qualification_invalid_mode');
  if ((requested === '1') !== OFFLINE_QUALIFICATION)
    throw new Error('offline_qualification_mode_changed_after_import');
  if (!OFFLINE_QUALIFICATION) return;
  if (!env.ARCHON_OPERATOR_TOKEN || env.ARCHON_OPERATOR_AUTH_DISABLED === 'true') {
    throw new Error('offline_qualification_operator_auth_required');
  }
  for (const [key, value] of Object.entries(env)) {
    if (!value || key === 'ARCHON_OPERATOR_TOKEN') continue;
    if (/(TOKEN|API_KEY|PASSWORD|PRIVATE_KEY|SECRET|DATABASE_URL|AUTH|PROXY)/i.test(key)) {
      throw new Error(`offline_qualification_forbidden_environment: ${key}`);
    }
  }
  for (const directory of ['.claude', '.codex', '.cursor', '.ssh', '.config']) {
    if (exists(join(home, directory)))
      throw new Error(`offline_qualification_credential_home: ${directory}`);
  }
}
