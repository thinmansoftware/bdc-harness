import { checkGitHubWebhookSignature } from '@archon/adapters/forge/github/webhook-signature';
import type { PromotionResult } from './m09-promotion-gate';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { resolveServiceGitHubAuth } from '@archon/core/github/service-identity';
import {
  COVERED_PRODUCTION_BASES,
  evaluatePromotion,
  motionPaths,
  promotionBlock,
} from './m09-promotion-gate';
export type PromotionRequest = (
  route: string,
  data: Record<string, unknown>
) => Promise<{ data: unknown }>;
export interface PromotionTarget {
  repository: string;
  number: number;
  head?: string;
  base?: string;
}
const NAME = 'm09-promotion-gate';
/** Serializes evaluations, including concurrent deliveries of the same head. */
export interface PromotionRetryOptions {
  retryDelay?: (milliseconds: number) => Promise<void>;
}
export function createPromotionGate(
  request: PromotionRequest,
  appId: number,
  options: PromotionRetryOptions = {}
): (target: PromotionTarget) => Promise<PromotionResult | undefined> {
  const tails = new Map<string, Promise<unknown>>();
  const known = new Map<string, number>();
  const ambiguous = new Set<string>();
  const delay =
    options.retryDelay ??
    ((ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms)));
  async function call(route: string, data: Record<string, unknown>): Promise<{ data: unknown }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(route, data);
      } catch (error) {
        if (route.startsWith('POST')) {
          // A lost create response may still have created the check. Reconcile
          // before another create; never blindly retry a non-idempotent write.
          for (let page = 1; ; page++) {
            const runs = (
              (
                await call('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
                  owner: data.owner,
                  repo: data.repo,
                  ref: data.head_sha,
                  check_name: NAME,
                  filter: 'all',
                  per_page: 100,
                  page,
                })
              ).data as {
                check_runs: {
                  id: number;
                  name: string;
                  external_id: string;
                  app?: { id: number };
                }[];
              }
            ).check_runs;
            const found = runs.find(
              r => r.name === NAME && r.external_id === data.external_id && r.app?.id === appId
            );
            if (found) return { data: found };
            if (runs.length < 100) break;
            if (page >= 100) throw Error('m09 create reconciliation incomplete; redeliver webhook');
          }
        }
        if (attempt >= 2) throw Error('m09 API unavailable; redeliver webhook or rerequest check');
        const retry = error as { response?: { headers?: Record<string, string> } };
        const seconds = Number(retry.response?.headers?.['retry-after']);
        await delay(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt);
      }
    }
  }
  async function evaluate(target: PromotionTarget): Promise<PromotionResult | undefined> {
    const bases = COVERED_PRODUCTION_BASES[target.repository];
    if (!bases || (target.base && !bases.includes(target.base))) return;
    const [owner, repo] = target.repository.split('/');
    const args = { owner, repo };
    interface Pr {
      body: string | null;
      head: { sha: string };
      base: { ref: string };
    }
    let pr: Pr | undefined;
    // Signed webhook metadata lets us invalidate even when the live PR lookup fails.
    const head = target.head ?? '';
    if (!/^[a-f0-9]{40}$/i.test(head)) throw Error('m09 head unavailable');
    const key = `${target.repository}:${head}`;
    let existing = known.get(key);
    let lookupFailed = false;
    {
      try {
        for (let page = 1; ; page++) {
          const runs = (
            (
              await call('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
                ...args,
                ref: head,
                check_name: NAME,
                filter: 'all',
                per_page: 100,
                page,
              })
            ).data as {
              check_runs: { id: number; name: string; external_id: string; app?: { id: number } }[];
            }
          ).check_runs;
          const found = runs.find(
            r => r.name === NAME && r.external_id === head && r.app?.id === appId
          );
          if (found) {
            existing = found.id;
            break;
          }
          if (runs.length < 100) break;
          if (page >= 100) throw Error('incomplete check listing');
        }
      } catch {
        lookupFailed = true;
      }
    }
    async function publish(
      status: 'in_progress' | 'completed',
      result?: PromotionResult
    ): Promise<void> {
      if (!existing && ambiguous.has(key)) {
        for (let page = 1; ; page++) {
          const runs = (
            (
              await call('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
                ...args,
                ref: head,
                check_name: NAME,
                filter: 'all',
                per_page: 100,
                page,
              })
            ).data as {
              check_runs: { id: number; name: string; external_id: string; app?: { id: number } }[];
            }
          ).check_runs;
          const found = runs.find(
            r => r.name === NAME && r.external_id === head && r.app?.id === appId
          );
          if (found) {
            existing = found.id;
            known.set(key, existing);
            ambiguous.delete(key);
            break;
          }
          if (runs.length < 100)
            throw Error('m09 ambiguous create unresolved; rerequest after reconciliation');
          if (page >= 100) throw Error('m09 ambiguous create listing incomplete');
        }
      }
      if (!existing) ambiguous.add(key);
      const response = await call(
        existing
          ? 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}'
          : 'POST /repos/{owner}/{repo}/check-runs',
        {
          ...args,
          ...(existing ? { check_run_id: existing } : { name: NAME, head_sha: head }),
          external_id: head,
          status,
          ...(result ? { conclusion: result.conclusion } : { conclusion: null }),
          output: {
            title: result
              ? `M-09 ${result.conclusion}: ${result.rules.map((r, i) => `${i + 1} ${r.pass ? 'PASS' : 'FAIL'}`).join(', ')}`
              : 'M-09 evaluation pending',
            summary: result
              ? `${result.reason ? result.reason + '\n' : ''}bdc-xo pinned SHA: ${result.pinnedSha || 'unavailable'}\n${result.rules.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}`).join('\n')}`
              : 'Approval is being revalidated. This check is not a promotion approval.',
          },
        }
      );
      existing = (response.data as { id: number }).id;
      known.set(key, existing);
      ambiguous.delete(key);
    }
    const unavailable: PromotionResult = {
      conclusion: 'failure',
      pinnedSha: '',
      reason: 'API lookup failed',
      rules: [{ name: 'API lookup', pass: false }],
    };
    // Never inspect approval while an earlier successful check is still current.
    try {
      await publish('in_progress');
    } catch {
      await publish('completed', unavailable);
      throw Error('m09 invalidation failed; redeliver webhook or rerequest check');
    }
    try {
      if (lookupFailed) throw Error('check lookup failed');
      pr ??= (
        await call('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          ...args,
          pull_number: target.number,
        })
      ).data as Pr;
      if (pr.head.sha !== head || !bases.includes(pr.base.ref))
        throw Error('PR changed during evaluation');
    } catch {
      await publish('completed', unavailable);
      return unavailable;
    }
    const xo = { owner: 'thinmansoftware', repo: 'bdc-xo' };
    let pinnedSha = '',
      motion = '',
      paths: string[] = [],
      truncated = true,
      behindBy = -1;
    try {
      pinnedSha = (
        (await call('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...xo, ref: 'heads/main' }))
          .data as { object: { sha: string } }
      ).object.sha;
      if (!/^[a-f0-9]{40}$/i.test(pinnedSha)) throw Error('invalid pin');
      const tree = (
        await call('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
          ...xo,
          tree_sha: pinnedSha,
          recursive: '1',
        })
      ).data as { truncated?: boolean; tree: { type: string; mode: string; path: string }[] };
      truncated = tree.truncated !== false;
      paths = tree.tree.filter(e => e.type === 'blob' && e.mode === '100644').map(e => e.path);
      const block = promotionBlock(pr.body ?? '');
      const matches = motionPaths(paths, block?.id ?? '');
      if (!truncated && matches.length === 1) {
        const record = (
          await call('GET /repos/{owner}/{repo}/contents/{path}', {
            ...xo,
            path: matches[0],
            ref: pinnedSha,
          })
        ).data as { encoding: string; content: string };
        if (record.encoding !== 'base64' || typeof record.content !== 'string')
          throw Error('invalid record');
        motion = Buffer.from(record.content, 'base64').toString('utf8');
      }
      behindBy = (
        (
          await call('GET /repos/{owner}/{repo}/compare/{basehead}', {
            ...args,
            basehead: `${pr.base.ref}...${pr.head.sha}`,
          })
        ).data as { behind_by: number }
      ).behind_by;
    } catch {
      motion = '';
      behindBy = -1;
    }
    const result = evaluatePromotion({
      repository: target.repository,
      head: pr.head.sha,
      body: pr.body ?? '',
      pinnedSha,
      paths,
      truncated,
      motion,
      behindBy,
    });
    try {
      await publish('completed', result);
    } catch {
      // If success publication failed, preserve a failing result whenever writes recover.
      await publish('completed', unavailable);
      throw Error('m09 publication failed; redeliver webhook or rerequest check');
    }
    return result;
  }
  return async (target: PromotionTarget): Promise<PromotionResult | undefined> => {
    if (!COVERED_PRODUCTION_BASES[target.repository]) return undefined;
    // Discover only identity outside the lock. Approval body is always read again
    // inside evaluate after every caller has acquired the same repository/head lock.
    if (!target.head) {
      const [owner, repo] = target.repository.split('/');
      const metadata = (
        await call('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner,
          repo,
          pull_number: target.number,
        })
      ).data as { head: { sha: string }; base: { ref: string } };
      if (!COVERED_PRODUCTION_BASES[target.repository]?.includes(metadata.base.ref))
        return undefined;
      target = { ...target, head: metadata.head.sha, base: metadata.base.ref };
    }
    const key = `${target.repository}:${target.head}`;
    const next = (tails.get(key) ?? Promise.resolve()).then(() => evaluate(target));
    const settled = next.catch(() => undefined);
    tails.set(key, settled);
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return next;
  };
}
let realGate: ReturnType<typeof createPromotionGate> | undefined;
export function reevaluatePromotion(target: PromotionTarget): Promise<PromotionResult | undefined> {
  if (!realGate) {
    const identity = resolveServiceGitHubAuth('overseer');
    if (identity.kind !== 'app') throw Error('m09 requires Overseer App installation identity');
    const client = new Octokit({
      request: { timeout: 20000 },
      authStrategy: createAppAuth,
      auth: {
        appId: identity.appId,
        installationId: identity.installationId,
        privateKey: identity.privateKey,
      },
    });
    realGate = createPromotionGate(
      (route, data) => client.request(route, data),
      Number(identity.appId)
    );
  }
  return realGate(target);
}
/** Call only after the existing webhook signature verification succeeds. */
interface PromotionEvent {
  action: string;
  repository?: { full_name: string };
  pull_request?: { number: number; head?: { sha: string }; base: { ref: string } };
  check_run?: {
    name: string;
    head_sha?: string;
    pull_requests?: { number: number; base?: { ref: string } }[];
  };
}
export async function handlePromotionEvent(
  eventType: string | undefined,
  payload: PromotionEvent,
  evaluate: (target: PromotionTarget) => Promise<PromotionResult | undefined> = reevaluatePromotion
): Promise<PromotionResult | undefined> {
  const repository = payload.repository?.full_name;
  if (!repository) return undefined;
  const bases = COVERED_PRODUCTION_BASES[repository];
  if (!bases) return undefined;
  if (
    eventType === 'pull_request' &&
    payload.pull_request &&
    bases.includes(payload.pull_request.base.ref) &&
    ['opened', 'reopened', 'synchronize', 'edited'].includes(payload.action)
  ) {
    return evaluate({
      repository,
      number: payload.pull_request.number,
      head: payload.pull_request.head?.sha,
      base: payload.pull_request.base.ref,
    });
  }
  if (
    eventType === 'check_run' &&
    payload.action === 'rerequested' &&
    payload.check_run?.name === NAME
  ) {
    for (const pr of payload.check_run.pull_requests ?? [])
      await evaluate({
        repository,
        number: pr.number,
        head: payload.check_run.head_sha,
        base: pr.base?.ref,
      });
  }
  return undefined;
}

export interface PromotionWebhook {
  eventType: string | undefined;
  rawBody: string;
  signature: string | undefined;
}
export async function processPromotionWebhook(
  input: PromotionWebhook,
  secret: string,
  evaluate: (target: PromotionTarget) => Promise<PromotionResult | undefined> = reevaluatePromotion
): Promise<void> {
  if (!checkGitHubWebhookSignature(input.rawBody, input.signature, secret).valid) return;
  await handlePromotionEvent(
    input.eventType,
    JSON.parse(input.rawBody) as PromotionEvent,
    evaluate
  );
}
/** Intake always finishes before promotion IO; promotion errors remain retryable. */
export async function ingestBeforePromotion<T>(
  ingest: () => Promise<T>,
  promotion: () => Promise<void>
): Promise<T> {
  const result = await ingest();
  await promotion();
  return result;
}
