import type {
  BlockedPrCard,
  BlockerClass,
  CauldronRun,
  PrData,
  RawCheckRun,
  RawReview,
  RawStatus,
} from './card-types';

export const OK = 'OK';
export const OVERSEER_BOT = 'thinman-overseer[bot]';

// Exact behavioral parity with bdc-xo scripts/git/merge_guard_decide.py.
export function reviewVerdict(reviews: RawReview[], head: string, bot = OVERSEER_BOT): string {
  const botReviews = reviews.filter(r => r.user?.login === bot);
  if (!botReviews.length) return 'no Overseer review';
  const latestBot = [...botReviews]
    .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
    .at(-1);
  if (!latestBot) return 'no Overseer review';
  if (latestBot.commit_id !== head)
    return `latest Overseer review is on ${String(latestBot.commit_id).slice(0, 8)}, head is ${head.slice(0, 8)}`;
  if (latestBot.state !== 'APPROVED') return `latest Overseer review is ${latestBot.state}`;
  const latest = new Map<string, RawReview>();
  reviews
    .filter(r => r.commit_id === head)
    .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''))
    .forEach(r => latest.set(r.user?.login ?? '?', r));
  const blocking = [...latest]
    .filter(([, r]) => r.state === 'CHANGES_REQUESTED')
    .map(([u]) => u)
    .sort();
  return blocking.length
    ? `CHANGES_REQUESTED at head (latest review) by ${blocking.join(',')}`
    : OK;
}

export function checksVerdict(checkRuns: RawCheckRun[], statuses: RawStatus[]): string {
  if (!checkRuns.length && !statuses.length) return 'no checks reported for head';
  const bad: string[] = [];
  for (const c of checkRuns) {
    if (c.status !== 'completed') bad.push(`${c.name}=${c.status}`);
    else if (!['success', 'skipped', 'neutral'].includes(c.conclusion ?? ''))
      bad.push(`${c.name}=${c.conclusion}`);
  }
  const latest = new Map<string | undefined, RawStatus>();
  for (const s of statuses) {
    const held = latest.get(s.context);
    if (!held || (s.updated_at ?? '') > (held.updated_at ?? '')) latest.set(s.context, s);
  }
  for (const [ctx, s] of latest) if (s.state !== 'success') bad.push(`${ctx}=${s.state}`);
  return bad.length ? `checks not green: ${bad.sort().join(', ')}` : OK;
}

export interface DecisionInput {
  pr: PrData;
  reviewVerdict: string;
  checksVerdict: string;
  woId: string | null;
  runs: CauldronRun[];
  githubAvailable?: boolean;
}
export function decideBlocker(
  input: DecisionInput
): Pick<
  BlockedPrCard,
  'blocker_class' | 'blocker' | 'next_permitted_action' | 'responsible_actor'
> {
  const { pr } = input;
  const failed = input.runs.find(r => r.status.toLowerCase() === 'failed');
  let kind: BlockerClass;
  if (!['OPEN', 'open'].includes(pr.state)) kind = 'closed';
  else if (pr.draft) kind = 'draft';
  else if (pr.conflicting) kind = 'conflicting';
  else if (input.reviewVerdict.includes('CHANGES_REQUESTED')) kind = 'changes_requested_on_head';
  else if (input.reviewVerdict.startsWith('latest Overseer review is on ')) kind = 'stale_review';
  else if (input.githubAvailable === false) kind = 'no_review';
  else if (input.reviewVerdict === 'no Overseer review')
    kind = failed ? 'cauldron_run_failed' : 'no_review';
  else if (
    input.checksVerdict !== OK &&
    !input.checksVerdict.includes('in_progress') &&
    !input.checksVerdict.includes('queued') &&
    input.checksVerdict !== 'no checks reported for head'
  )
    kind = 'checks_red';
  else if (input.checksVerdict !== OK) kind = 'checks_pending';
  else if (pr.production_base) kind = 'production_base_needs_motion';
  else kind = 'merge_ready';
  const repairWo = input.woId ?? '<new repair WO>';
  const short = pr.repo.split('/')[1] ?? pr.repo;
  const actions: Record<BlockerClass, { action: string; text: string; actor: string }> = {
    closed: { action: 'none', text: 'PR is MERGED/CLOSED', actor: 'none' },
    draft: {
      action: 'mark-ready',
      text: `gh pr ready ${pr.number} --repo ${pr.repo} (Overseer ignores drafts)`,
      actor: 'pr_owner',
    },
    conflicting: {
      action: 'rebase',
      text: `rebase ${pr.head_ref} onto ${pr.base_ref}`,
      actor: 'pr_owner',
    },
    changes_requested_on_head: {
      action: 'repair-in-place',
      text: `fire ${repairWo} with a repair-target line for PR #${pr.number} (branch ${pr.head_ref}) via fire.ps1 -Wo ${repairWo} -Project ${short} -Workflow bdc-feature-development-codex`,
      actor: 'pr_owner',
    },
    checks_red: {
      action: 'repair-in-place',
      text: `fire ${repairWo} with a repair-target line for PR #${pr.number} (branch ${pr.head_ref}) via fire.ps1 -Wo ${repairWo} -Project ${short} -Workflow bdc-feature-development-codex`,
      actor: 'pr_owner',
    },
    stale_review: {
      action: 'await-re-review',
      text:
        input.reviewVerdict.replace('latest ', '').replace(' is on ', ' is on ') +
        '; wait for re-review of the exact head, operator re-review via Dispatch run_review if none within 30 min',
      actor: 'overseer',
    },
    no_review: {
      action: 'await-review',
      text:
        input.githubAvailable === false
          ? 'GitHub evidence is incomplete; wait for an authoritative review snapshot'
          : 'wait for Overseer review of the exact head',
      actor: 'overseer',
    },
    cauldron_run_failed: {
      action: 'diagnose-run',
      text: failed
        ? `run ${failed.id.slice(0, 8)} failed at node ${failed.failing_node ?? 'unknown'}: ${failed.error_line ?? 'unknown error'}`
        : 'linked run failed',
      actor: 'run_owner',
    },
    checks_pending: {
      action: 'wait-checks',
      text: 'wait for checks on the exact head to complete',
      actor: 'ci',
    },
    production_base_needs_motion: {
      action: 'waiting-on-board',
      text: `production base ${pr.base_ref}: needs a recorded M-09 board motion`,
      actor: 'board',
    },
    merge_ready: {
      action: 'merge',
      text: `merge manager merges; if idle: bash scripts/git/merge-if-approved.sh ${pr.repo} ${pr.number}`,
      actor: 'merge_manager',
    },
  };
  const picked = actions[kind];
  return {
    blocker_class: kind,
    blocker: kind === 'merge_ready' ? 'none' : kind.replaceAll('_', ' '),
    next_permitted_action: { action: picked.action, text: picked.text },
    responsible_actor: picked.actor,
  };
}
