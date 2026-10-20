export type OpsEventClass = 'ROUTINE' | 'NEEDS_A_PERSON' | 'BLOCKER';
export type OpsEventDestination = 'digest' | 'interrupt';

export interface OpsEvent {
  sender?: string;
  task_type?: string;
  priority?: string;
  body: string;
  subject_key?: string | null;
  created_at?: string;
}

export interface OpsEventRoute {
  class: OpsEventClass;
  destination: OpsEventDestination;
  reason: string;
}

export interface OpsEventRoutingState {
  blocker_by_subject?: Record<string, string>;
}

const OWNER_SEATS = new Set([
  'codex', 'cursor', 'claude', 'grok', 'desktop-claude', 'codex-desktop',
  'codex-voice', 'xo-board', 'ArcB-Owner',
]);
const NO_RETRY = /\b(retries exhausted|no retry|cannot retry|will not retry|max attempts|max retries|gave up|given_up|all tiers exhausted)\b/i;
const RUN_OR_WO = /\b(run|WO-[A-Z0-9-]+)\b/i;
const SECURITY_OR_MONEY = /\b(security|secret|credential|service_role|money|billing|refund|charge)\b/i;
const PERSON = /\b(decision needed|approve|approval|human-only|rotate|rotation|login|owner:john|owner:board)\b/i;
const CUSTOMER_RISK = /\bcustomer\b/i;
const CUSTOMER_FAILURE = /\b(broken|down|wrong|failing|overcharged)\b/i;

function route(kind: OpsEventClass, reason: string): OpsEventRoute {
  return { class: kind, destination: kind === 'ROUTINE' ? 'digest' : 'interrupt', reason };
}

export function routeOpsEvent(
  event: OpsEvent,
  options: { now?: Date; state?: OpsEventRoutingState; repeatHours?: number } = {}
): OpsEventRoute {
  const now = options.now ?? new Date(event.created_at ?? Date.now());
  const state = options.state;
  const repeatMs = (options.repeatHours ?? 24) * 3_600_000;
  const body = event.body ?? '';
  let answer: OpsEventRoute;
  if (event.priority === 'blocker' || (event.sender === 'taskmaster' && event.task_type === 'blocker_report')) {
    answer = route('BLOCKER', 'explicit blocker');
  } else if (event.sender === 'taskmaster' && /^expectation EXHAUSTED\b/.test(body)) {
    answer = route('ROUTINE', 'ordinary exhausted-expectation summary');
  } else if ((event.task_type === 'run_report' || RUN_OR_WO.test(body)) && NO_RETRY.test(body)) {
    answer = route('BLOCKER', 'failure has no retry path');
  } else if (OWNER_SEATS.has(event.sender ?? '') && body.includes('?')) {
    answer = route('BLOCKER', 'owner asked a question');
  } else if (SECURITY_OR_MONEY.test(body)) {
    answer = route('BLOCKER', 'security or money risk');
  } else if (PERSON.test(body)) {
    answer = route('NEEDS_A_PERSON', 'human decision or step required');
  } else if (CUSTOMER_RISK.test(body) && CUSTOMER_FAILURE.test(body)) {
    answer = route('NEEDS_A_PERSON', 'customer-facing risk');
  } else {
    answer = route('ROUTINE', 'routine operational event');
  }
  if (answer.class === 'BLOCKER' && event.subject_key && state) {
    const previous = state.blocker_by_subject?.[event.subject_key];
    if (previous && now.getTime() - Date.parse(previous) < repeatMs) {
      return route('ROUTINE', 'repeat blocker within suppression window');
    }
    state.blocker_by_subject ??= {};
    state.blocker_by_subject[event.subject_key] = now.toISOString();
  }
  return answer;
}
