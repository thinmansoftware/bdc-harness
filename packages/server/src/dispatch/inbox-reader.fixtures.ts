/**
 * Real-shape dispatch message fixtures (WO-HARNESS-DISPATCH-INBOX-READER-01,
 * Section 4f). Taken verbatim from agent_dispatch_messages on 2026-09-29 (ids
 * and bodies preserved; long bodies cut where marked "...").
 *
 * Each fixture carries the static message fields; tests set created_at, status,
 * acknowledged_at, addressed_at and route_disposition per case via buildRow().
 */
import type { InboxClassifierInput } from './inbox-reader-rules';

export interface InboxFixture {
  id: string;
  sender: string;
  task_type: string;
  recipient: string;
  body: string;
  priority: 'blocker' | 'normal' | 'heartbeat';
  subject_key: string | null;
}

/** F1 overseer approved (R1). */
export const F1: InboxFixture = {
  id: 'fef9d3c2-4702-4622-b8f5-6ae0a99e0455',
  sender: 'overseer',
  task_type: 'run_report',
  recipient: 'operator',
  priority: 'normal',
  subject_key: 'gh:thinmansoftware/bdc-xo#2593',
  body: '{"kind":"pr_review_submit_receipt","correlationId":"pr-review:thinmansoftware/bdc-xo#2593@86f4f5a6fe90ff0a92ff82aeea957a7e39c554f9","messageId":"33117dfa-87de-4225-a696-fd54faa88b19","owner":"thinmansoftware","repo":"bdc-xo","prNumber":2593,"headSha":"86f4f5a6fe90ff0a92ff82aeea957a7e39c554f9","disposition":"approved","event":"APPROVE"}',
};

/** F2 overseer-review-route approved (R1). */
export const F2: InboxFixture = {
  id: 'e672cae7-86da-41fa-938f-ab4944453c04',
  sender: 'overseer-review-route',
  task_type: 'run_report',
  recipient: 'operator',
  priority: 'normal',
  subject_key: 'gh:thinmansoftware/bdc-xo#1952',
  body: '{"kind":"pr_review_submit_receipt","correlationId":"pr-review:thinmansoftware/bdc-xo#1952@09294f623f6199d56c75e39f95bf9b54f8dac5b9","messageId":"11111111-2222-3333-4444-555555555555","owner":"thinmansoftware","repo":"bdc-xo","prNumber":1952,"headSha":"09294f623f6199d56c75e39f95bf9b54f8dac5b9","disposition":"approved","event":"APPROVE"}',
};

/** F3 checks_pending (R2). */
export const F3: InboxFixture = {
  id: 'bec322f1-e3c2-4e9e-8809-5ee50faff7d9',
  sender: 'overseer',
  task_type: 'run_report',
  recipient: 'operator',
  priority: 'normal',
  subject_key: 'gh:thinmansoftware/bdc-xo#2593',
  body: '{"kind":"pr_review_submit_receipt","correlationId":"pr-review:thinmansoftware/bdc-xo#2593@86f4f5a6fe90ff0a92ff82aeea957a7e39c554f9","messageId":"33117dfa-87de-4225-a696-fd54faa88b19","owner":"thinmansoftware","repo":"bdc-xo","prNumber":2593,"headSha":"86f4f5a6fe90ff0a92ff82aeea957a7e39c554f9","disposition":"checks_pending","reason":"checks_not_terminal"}',
};

/** F4 ingest queued (R3). */
export const F4: InboxFixture = {
  id: '23651e69-9419-4c44-98ca-4925799199c4',
  sender: 'overseer',
  task_type: 'run_report',
  recipient: 'operator',
  priority: 'normal',
  subject_key: null,
  body: '{"kind":"pr_review_ingest_receipt","deliveryId":"78f31220-bbd5-11f1-9efb-812d42c32581","owner":"thinmansoftware","repo":"bdc-xo","prNumber":2593,"headSha":"86f4f5a6fe90ff0a92ff82aeea957a7e39c554f9","disposition":"queued","reason":null,"messageId":"33117dfa-87de-4225-a696-fd54faa88b19"}',
};

/** F5 ingest blocked (ACTIONABLE via G3 keyword "blocked"). */
export const F5: InboxFixture = {
  id: '464fdd84-838a-42a9-b088-137c4c3e76d2',
  sender: 'overseer',
  task_type: 'run_report',
  recipient: 'operator',
  priority: 'normal',
  subject_key: null,
  body: '{"kind":"pr_review_ingest_receipt","deliveryId":"98e78ec0-bb86-11f1-86b6-fe50da43cdf9","owner":"thinmansoftware","repo":"lspro-react","prNumber":626,"headSha":"33579a2f493b33b7fa2037aa58443da0518184b3","disposition":"blocked","reason":"rereview_total_ceiling_reached:consecutive=0:total=10:comment_posted","messageId":null}',
};

/** F6 submission_failed (ACTIONABLE fallthrough, no_rule_matched). */
export const F6: InboxFixture = {
  id: '5acbd453-bef2-4fb6-8b62-2ea9f6033501',
  sender: 'overseer',
  task_type: 'run_report',
  recipient: 'operator',
  priority: 'normal',
  subject_key: null,
  body: '{"kind":"pr_review_submit_receipt","correlationId":"pr-review:thinmansoftware/bdc-harness#1018@0d1724eae6cb3f61076ce0c90b993f7480cc8062","messageId":"9f4586cd-751a-4e65-a29b-d8f3e2f894aa","owner":"thinmansoftware","repo":"bdc-harness","prNumber":1018,"headSha":"0d1724eae6cb3f61076ce0c90b993f7480cc8062","disposition":"submission_failed","event":"REQUEST_CHANGES","reason":"github_review_transport_ambiguous"}',
};

/** F7 taskmaster daily digest nudge (R4). escalate_p0 must NOT trip \bP[01]\b. */
export const F7: InboxFixture = {
  id: '932ed6fc-019d-4bfd-8f09-5be9d6760a85',
  sender: 'taskmaster',
  task_type: 'agent_message',
  recipient: 'operator',
  priority: 'normal',
  subject_key: 'digest:2026-08-30',
  body: 'Taskmaster daily digest for 2026-08-30: escalate_p0:rejected=48, digest:sent=1, escalate_p0:sent=21. Pause/resume/status runbook: xo-wiki/wiki/tools/taskmaster/_index.md.',
};

/** F8 codex question to xo (ACTIONABLE via G2 unknown_sender, also G3 "?"). */
export const F8: InboxFixture = {
  id: '7e779b92-4f02-444d-83cf-cc1e9ad50935',
  sender: 'codex',
  task_type: 'agent_message',
  recipient: 'xo',
  priority: 'normal',
  subject_key: null,
  body: 'Read-only ownership/capability question for live XO session f3acb22d-7fd2-4687-a227-1dcd7419d851 / bdc-xo-36 (lease principal xo-claude-board-work fence97 rechecked). ... Please identify responsible current session and obtain its explicit answer: is there an ALREADY AUTHORIZED, documented and callable exact-head App-review invocation that preserves draft status? Provide exact source/doc/invocation',
};

/** F9 taskmaster unclaimed P0 (ACTIONABLE via G3 "P0"). */
export const F9: InboxFixture = {
  id: '3c0b1abb-92a5-4ceb-b487-ac7c745ad6ad',
  sender: 'taskmaster',
  task_type: 'agent_message',
  recipient: 'operator',
  priority: 'normal',
  subject_key: 'gh:thinmansoftware/bdc-harness#194',
  body: 'Unclaimed P0: "WO-CICD-BDC-CI-LIBRARY-P1-01" (gh:thinmansoftware/bdc-harness#194) [P0] has no owner. Last movement 104 days ago. This is an escalation for John\'s attention; no automated assignment is made (Slice 1 has no assignment authority). https://github.com/thinmansoftware/bdc-harness/issues/194',
};

/** F10 taskmaster EXHAUSTED blocker to xo (ACTIONABLE via G1 blocker_priority). */
export const F10: InboxFixture = {
  id: '47295a61-3a01-4e5c-9682-f9b30cf1c2a9',
  sender: 'taskmaster',
  task_type: 'agent_message',
  recipient: 'xo',
  priority: 'blocker',
  subject_key: null,
  body: 'Taskmaster expectation EXHAUSTED -- no human has confirmed this work landed.\n\nExpected proof: a completed dispatch reply for correlation tm-280eff56-f03a-420b-a0a0-f3f4371bf07c with outcome succeeded\nOwed by:        operator\nDue at:         2026-09-25T11:51:05.258Z (passed)',
};

/** F11 unknown sender (ACTIONABLE via G2 unknown_sender). */
export const F11: InboxFixture = {
  id: 'c58d894e-60fd-4f62-bdd4-c16a04941c38',
  sender: 'ArcB-Owner',
  task_type: 'agent_message',
  recipient: 'xo',
  priority: 'normal',
  subject_key: null,
  body: 'Arc B (#1315): TWO items need XO action. (1) JOHN RULED the M-99 kill-test clock RESTARTS from the 2026-07-31 13:22:53 UTC deploy -- new deadline 2026-08-02 13:22 UTC; please record against M-99.',
};

/** F12 overseer_run_report (ACTIONABLE via G3 "BLOCKED"; also fallthrough). */
export const F12: InboxFixture = {
  id: '82e86c75-1bd6-4ed9-b071-54e91c6c02d6',
  sender: 'overseer',
  task_type: 'run_report',
  recipient: 'operator',
  priority: 'normal',
  subject_key: null,
  body: '{"kind":"overseer_run_report","card_id":"4955ef39d18f4d0160cdb7e3989f453a37bb6584166a6adcd50b378dc11886c2","blocker":"Contrary to the advisory ignore hint, the implement loop exhausted five iterations without COMPLETE, leaving the run BLOCKED with no PR.","branch":null,"checks":{"failed":0,"passed":0,"pending":0,"total":0}}',
};

export const ALL_FIXTURES: readonly InboxFixture[] = [
  F1,
  F2,
  F3,
  F4,
  F5,
  F6,
  F7,
  F8,
  F9,
  F10,
  F11,
  F12,
];

/**
 * Build a full classifier/reader row from a fixture plus per-test dynamic
 * fields (created_at, status, receipts, disposition). Defaults model a fresh
 * queued unread row.
 */
export function buildRow(
  fixture: InboxFixture,
  overrides: {
    created_at: string;
    status?: 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled';
    acknowledged_at?: string | null;
    addressed_at?: string | null;
    route_disposition?: 'unroutable' | 'superseded' | 'expired' | 'auto_surfaced' | null;
    id?: string;
    priority?: 'blocker' | 'normal' | 'heartbeat';
  }
): InboxClassifierInput {
  return {
    id: overrides.id ?? fixture.id,
    sender: fixture.sender,
    task_type: fixture.task_type,
    recipient: fixture.recipient,
    body: fixture.body,
    subject_key: fixture.subject_key,
    priority: overrides.priority ?? fixture.priority,
    created_at: overrides.created_at,
    status: overrides.status ?? 'queued',
    acknowledged_at: overrides.acknowledged_at ?? null,
    addressed_at: overrides.addressed_at ?? null,
    route_disposition: overrides.route_disposition ?? null,
  };
}
