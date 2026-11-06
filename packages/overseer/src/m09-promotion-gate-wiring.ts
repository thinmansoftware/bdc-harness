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
}
const NAME = 'm09-promotion-gate';
/** Serializes evaluations, including concurrent deliveries of the same head. */
export function createPromotionGate(
  request: PromotionRequest,
  appId: number
): (target: PromotionTarget) => Promise<PromotionResult | undefined> {
  let tail: Promise<unknown> = Promise.resolve();
  async function evaluate(target: PromotionTarget): Promise<PromotionResult | undefined> {
    const bases = COVERED_PRODUCTION_BASES[target.repository];
    if (!bases) return;
    const [owner, repo] = target.repository.split('/');
    const args = { owner, repo };
    const pr = (
      await request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        ...args,
        pull_number: target.number,
      })
    ).data as { body: string | null; head: { sha: string }; base: { ref: string } };
    if (!bases.includes(pr.base.ref)) return;
    const xo = { owner: 'thinmansoftware', repo: 'bdc-xo' };
    let pinnedSha = '',
      motion = '',
      paths: string[] = [],
      truncated = true,
      behindBy = -1;
    try {
      pinnedSha = (
        (await request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...xo, ref: 'heads/main' }))
          .data as { object: { sha: string } }
      ).object.sha;
      if (!/^[a-f0-9]{40}$/i.test(pinnedSha)) throw Error('invalid pin');
      const tree = (
        await request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
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
          await request('GET /repos/{owner}/{repo}/contents/{path}', {
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
          await request('GET /repos/{owner}/{repo}/compare/{basehead}', {
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
    const output = {
      title: `${result.reason || `M-09 ${result.conclusion}`}: ${result.rules.map((r, i) => `${i + 1} ${r.pass ? 'PASS' : 'FAIL'}`).join(', ')}`,
      summary: `bdc-xo pinned SHA: ${pinnedSha || 'unavailable'}\n${result.rules.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}`).join('\n')}`,
    };
    let existing: number | undefined;
    for (let page = 1; ; page++) {
      const runs = (
        (
          await request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
            ...args,
            ref: pr.head.sha,
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
        r => r.name === NAME && r.external_id === pr.head.sha && r.app?.id === appId
      );
      if (found) {
        existing = found.id;
        break;
      }
      if (runs.length < 100) break;
      if (page >= 100) throw Error('incomplete check listing');
    }
    await request(
      existing
        ? 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}'
        : 'POST /repos/{owner}/{repo}/check-runs',
      {
        ...args,
        ...(existing ? { check_run_id: existing } : { name: NAME, head_sha: pr.head.sha }),
        external_id: pr.head.sha,
        status: 'completed',
        conclusion: result.conclusion,
        output,
      }
    );
    return result;
  }
  return (target: PromotionTarget) => {
    const next = tail.then(() => evaluate(target));
    tail = next.catch(() => undefined);
    return next;
  };
}
let realGate: ReturnType<typeof createPromotionGate> | undefined;
export function reevaluatePromotion(target: PromotionTarget): Promise<PromotionResult | undefined> {
  if (!realGate) {
    const identity = resolveServiceGitHubAuth('overseer');
    if (identity.kind !== 'app') throw Error('m09 requires Overseer App installation identity');
    const client = new Octokit({
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
  pull_request?: { number: number; base: { ref: string } };
  check_run?: { name: string; pull_requests?: { number: number }[] };
}
export async function handlePromotionEvent(
  eventType: string | undefined,
  payload: PromotionEvent
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
    return reevaluatePromotion({
      repository,
      number: payload.pull_request.number,
    });
  }
  if (
    eventType === 'check_run' &&
    payload.action === 'rerequested' &&
    payload.check_run?.name === NAME
  ) {
    for (const pr of payload.check_run.pull_requests ?? [])
      await reevaluatePromotion({ repository, number: pr.number });
  }
  return undefined;
}
