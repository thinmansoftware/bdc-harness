export type SourceStatus = 'ok' | `unavailable: ${string}`;
export type BlockerClass =
  | 'closed'
  | 'draft'
  | 'conflicting'
  | 'changes_requested_on_head'
  | 'stale_review'
  | 'no_review'
  | 'cauldron_run_failed'
  | 'checks_red'
  | 'checks_pending'
  | 'production_base_needs_motion'
  | 'merge_ready';

export interface PrData {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  head_sha: string;
  head_ref: string;
  base_ref: string;
  production_base: boolean;
  conflicting?: boolean;
  author?: string;
}
export interface ReviewData {
  latest_overseer: { state: string; commit_id: string | null; on_exact_head: boolean } | null;
  changes_requested_on_head_by: string[];
  verdict: string;
}
export interface CardCheck {
  name: string;
  kind: 'run' | 'status';
  state: string;
  required: boolean | null;
}
export interface CauldronRun {
  id: string;
  workflow: string;
  status: string;
  started_at: string;
  failing_node: string | null;
  error_line: string | null;
}
export interface BlockedPrCard {
  pr: PrData;
  owner: { who: string; source: string };
  review: ReviewData;
  checks: CardCheck[];
  checks_verdict: string;
  findings: string[];
  wo: { id: string | null; issue: number | null };
  cauldron_runs: CauldronRun[];
  blocker_class: BlockerClass;
  blocker: string;
  next_permitted_action: { action: string; text: string };
  responsible_actor: string;
  sources: { github: SourceStatus; event_store: SourceStatus; taskmaster: SourceStatus };
  generated_at: string;
}

export interface RawReview {
  user?: { login?: string };
  submitted_at?: string;
  commit_id?: string | null;
  state?: string;
  body?: string | null;
}
export interface RawCheckRun {
  id?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: { slug?: string; name?: string };
}
export interface RawStatus {
  context?: string;
  state?: string;
  updated_at?: string;
}
