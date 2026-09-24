/**
 * Process-isolated constructor probe for reconcile's Octokit client.
 * Not a *.test.ts file: bun test must not load its mock.module() into the
 * shared package test process. The parent test spawns this file with bun.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mock } from 'bun:test';

const ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

interface ConstructionSummary {
  hasAuthStrategy: boolean;
  authStrategyName: string | null;
  appId: string | null;
  installationId: string | null;
  authIsString: boolean;
}

interface IssueCall {
  operation: string;
  authIsString: boolean;
}

const constructions: ConstructionSummary[] = [];
const issueCalls: IssueCall[] = [];
const issueFailure = process.argv[3] ?? 'none';

mock.module('@octokit/rest', () => ({
  Octokit: class Octokit {
    constructor(options: Record<string, unknown>) {
      const auth = options.auth;
      const authObject =
        auth && typeof auth === 'object'
          ? (auth as { appId?: unknown; installationId?: unknown })
          : null;
      const strategy = options.authStrategy;
      const summary: ConstructionSummary = {
        hasAuthStrategy: typeof strategy === 'function',
        authStrategyName: typeof strategy === 'function' ? strategy.name : null,
        appId: typeof authObject?.appId === 'string' ? authObject.appId : null,
        installationId:
          typeof authObject?.installationId === 'string' ? authObject.installationId : null,
        authIsString: typeof auth === 'string',
      };
      constructions.push(summary);
      const recordIssue = (operation: string): Record<string, never> => {
        issueCalls.push({ operation, authIsString: summary.authIsString });
        if (summary.authIsString || issueFailure === 'none') return {};
        if (issueFailure === 'rate-limit') {
          throw Object.assign(new Error('API rate limit exceeded'), {
            status: 403,
            response: { headers: { 'x-ratelimit-remaining': '0' } },
          });
        }
        throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
      };
      this.issues = {
        createComment: async (): Promise<Record<string, never>> => recordIssue('createComment'),
        addLabels: async (): Promise<Record<string, never>> => recordIssue('addLabels'),
        update: async (): Promise<Record<string, never>> => recordIssue('update'),
      };
    }

    search = {
      issuesAndPullRequests: async (): Promise<{
        data: { items: [] };
        headers: Record<string, string>;
      }> => ({
        data: { items: [] },
        headers: { 'x-ratelimit-remaining': '4000' },
      }),
    };

    pulls = {
      listFiles: async (): Promise<{ data: []; headers: Record<string, string> }> => ({
        data: [],
        headers: { 'x-ratelimit-remaining': '3999' },
      }),
      get: async (): Promise<{ data: Record<string, never>; headers: Record<string, string> }> => ({
        data: {},
        headers: { 'x-ratelimit-remaining': '3998' },
      }),
    };

    issues!: {
      createComment(input: Record<string, unknown>): Promise<unknown>;
      addLabels(input: Record<string, unknown>): Promise<unknown>;
      update(input: Record<string, unknown>): Promise<unknown>;
    };
  },
}));

interface CapturedLog {
  message: string;
  identity?: string;
  operation?: string;
  rateLimitRemaining?: string;
}

const logs: CapturedLog[] = [];
const originalInfo = console.info.bind(console);

console.info = (...args: unknown[]): void => {
  const message = typeof args[1] === 'string' ? args[1] : '';
  const fields = args[2] && typeof args[2] === 'object' ? (args[2] as Record<string, unknown>) : {};
  logs.push({
    message,
    identity: typeof fields.identity === 'string' ? fields.identity : undefined,
    operation: typeof fields.operation === 'string' ? fields.operation : undefined,
    rateLimitRemaining:
      typeof fields.rateLimitRemaining === 'string' ? fields.rateLimitRemaining : undefined,
  });
  originalInfo(...args);
};

function pem(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
}

function applyMode(mode: string): void {
  for (const key of ENV_KEYS) delete process.env[key];
  if (mode === 'pat-only') {
    process.env.GITHUB_TOKEN = 'ghp_probe_pat';
    return;
  }
  process.env.GITHUB_APP_ID = '4574893';
  process.env.GITHUB_APP_INSTALLATION_ID = '153295654';
  process.env.GITHUB_APP_PRIVATE_KEY = pem();
  if (mode === 'app-and-pat' || mode === 'issue-mutations') {
    process.env.GITHUB_TOKEN = 'ghp_probe_pat';
  }
}

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

const mode = process.argv[2] ?? 'pat-only';

try {
  applyMode(mode);
  const reconcile = await import('../../reconcile');
  const deps = reconcile.createDefaultReconcileDeps();
  const missingCredentials = deps.githubIdentity === undefined;
  if (!missingCredentials) {
    await deps.searchMergedPullRequests({ org: 'thinmansoftware', since: '2026-01-01' });
    if (mode === 'issue-mutations') {
      const issue = {
        owner: 'thinmansoftware',
        repo: 'bdc-xo',
        number: 1,
        title: 'WO-PROBE-01',
        state: 'open' as const,
      };
      await deps.addTrackerEvidenceComment({ issue, body: 'evidence' });
      await deps.addTrackerLabel({ issue, label: 'wo:done' });
      await deps.closeTrackerIssue({ issue });
    }
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, constructions, logs, missingCredentials, issueCalls })}\n`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: message, constructions, logs, missingCredentials: false, issueCalls })}\n`
  );
} finally {
  for (const key of ENV_KEYS) {
    const prior = saved.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}
