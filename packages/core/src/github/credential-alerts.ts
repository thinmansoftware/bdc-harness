export interface GitHubCredentialAlert {
  subjectKey: `credential:${string}`;
  credential: string;
  service: string;
  failureClass: 'mint_failed' | 'unauthorized';
  detail: string;
}

export type GitHubCredentialAlertSink = (alert: GitHubCredentialAlert) => Promise<void>;

const ALERT_DEDUPE_MS = 6 * 60 * 60_000;
const lastAlertAt = new Map<string, number>();
let alertSink: GitHubCredentialAlertSink | null = null;

export function registerGitHubCredentialAlertSink(sink: GitHubCredentialAlertSink | null): void {
  alertSink = sink;
}

export async function emitGitHubCredentialAlert(
  alert: GitHubCredentialAlert,
  now: number = Date.now()
): Promise<void> {
  const previous = lastAlertAt.get(alert.subjectKey);
  if (previous !== undefined && now - previous < ALERT_DEDUPE_MS) return;
  lastAlertAt.set(alert.subjectKey, now);
  if (!alertSink) {
    console.error('github_credential_alert_sink_unregistered', {
      subjectKey: alert.subjectKey,
      service: alert.service,
      failureClass: alert.failureClass,
    });
    return;
  }
  try {
    await alertSink(alert);
  } catch (error) {
    console.error('github_credential_alert_sink_failed', {
      subjectKey: alert.subjectKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function clearGitHubCredentialAlertDedupe(): void {
  lastAlertAt.clear();
}
