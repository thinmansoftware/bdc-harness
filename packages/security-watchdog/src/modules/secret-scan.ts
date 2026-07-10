import type { Finding } from '../types';

export interface SecretCandidate {
  readonly path: string;
  readonly line: number;
  readonly value: string;
  readonly source: 'tracked-file' | 'git-history';
}

export type TrackedFileReader = () => Promise<readonly { readonly path: string; readonly content: string }[]>;
export type HistorySecretReader = () => Promise<readonly SecretCandidate[]>;

const SECRET_PATTERNS = [
  /(?:sk|ghp|glpat|xox[baprs])-[A-Za-z0-9_-]{16,}/g,
  /(?:SUPABASE|DATABASE|TELEGRAM|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*["']?([^"'\s]{16,})/g,
];

export function redactSecret(value: string): string {
  const prefix = value.slice(0, Math.min(4, value.length));
  return `${prefix}...[redacted:${value.length}]`;
}

export function findSecretsInContent(path: string, content: string): readonly SecretCandidate[] {
  const candidates: SecretCandidate[] = [];
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const pattern of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        candidates.push({
          path,
          line: index + 1,
          value: match[1] ?? match[0],
          source: 'tracked-file',
        });
      }
    }
  }
  return candidates;
}

export async function scanSecrets(options: {
  readonly readTrackedFiles: TrackedFileReader;
  readonly readHistorySecrets?: HistorySecretReader;
}): Promise<readonly Finding[]> {
  const tracked = await options.readTrackedFiles();
  const candidates = tracked.flatMap(file => findSecretsInContent(file.path, file.content));
  const history = options.readHistorySecrets ? await options.readHistorySecrets() : [];
  return [...candidates, ...history].map(candidate => ({
    module: 'secret-scan',
    severity: 'CRITICAL',
    target: `${candidate.path}:${candidate.line}`,
    evidence: {
      source: candidate.source,
      secret: redactSecret(candidate.value),
      length: candidate.value.length,
    },
    reason_code: 'secret_material_detected',
  }));
}
