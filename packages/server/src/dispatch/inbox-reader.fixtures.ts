import type { InboxMessage } from './inbox-reader-rules';

const base = {
  task_type: 'run_report',
  sender: 'overseer',
  recipient: 'operator',
  priority: 'normal',
  subject_key: 'gh:thinmansoftware/bdc-xo#2593',
  created_at: '2026-09-29T00:00:00.000Z',
  status: 'queued',
  acknowledged_at: null,
  addressed_at: null,
  route_disposition: null,
} as const;

function fixture(id: string, body: string, values: Partial<InboxMessage> = {}): InboxMessage {
  return { ...base, id, body, ...values } as InboxMessage;
}

export const F1 = fixture(
  'fef9d3c2-4702-4622-b8f5-6ae0a99e0455',
  '{"kind":"pr_review_submit_receipt","correlationId":"pr-review:thinmansoftware/bdc-xo#2593@86f4f5a6fe90ff0a92ff82aeea957a7e39c554f9","messageId":"33117dfa-87de-4225-a696-fd54faa88b19","owner":"thinmansoftware","repo":"bdc-xo","prNumber":2593,"headSha":"86f4f5a6fe90ff0a92ff82aeea957a7e39c554f9","disposition":"approved","event":"APPROVE"}'
);
export const F2 = fixture(
  'e672cae7-86da-41fa-938f-ab4944453c04',
  '{"kind":"pr_review_submit_receipt","repo":"bdc-xo","prNumber":1952,"headSha":"09294f623f6199d56c75e39f95bf9b54f8dac5b9","disposition":"approved","event":"APPROVE"}',
  { sender: 'overseer-review-route' }
);
export const F3 = fixture(
  'bec322f1-e3c2-4e9e-8809-5ee50faff7d9',
  '{"kind":"pr_review_submit_receipt","correlationId":"pr-review:thinmansoftware/bdc-xo#2593@86f4f5a6fe90ff0a92ff82aeea957a7e39c554f9","messageId":"33117dfa-87de-4225-a696-fd54faa88b19","owner":"thinmansoftware","repo":"bdc-xo","prNumber":2593,"headSha":"86f4f5a6fe90ff0a92ff82aeea957a7e39c554f9","disposition":"checks_pending","reason":"checks_not_terminal"}'
);
export const F4 = fixture(
  '23651e69-9419-4c44-98ca-4925799199c4',
  '{"kind":"pr_review_ingest_receipt","deliveryId":"78f31220-bbd5-11f1-9efb-812d42c32581","owner":"thinmansoftware","repo":"bdc-xo","prNumber":2593,"headSha":"86f4f5a6fe90ff0a92ff82aeea957a7e39c554f9","disposition":"queued","reason":null,"messageId":"33117dfa-87de-4225-a696-fd54faa88b19"}',
  { subject_key: null }
);
export const F5 = fixture(
  '464fdd84-838a-42a9-b088-137c4c3e76d2',
  '{"kind":"pr_review_ingest_receipt","disposition":"blocked","reason":"rereview_total_ceiling_reached"}'
);
export const F6 = fixture(
  '5acbd453-bef2-4fb6-8b62-2ea9f6033501',
  '{"kind":"pr_review_submit_receipt","disposition":"submission_failed","event":"REQUEST_CHANGES","reason":"github_review_transport_ambiguous"}'
);
export const F7 = fixture(
  '932ed6fc-019d-4bfd-8f09-5be9d6760a85',
  'Taskmaster daily digest for 2026-08-30: escalate_p0:rejected=48, digest:sent=1.',
  { sender: 'taskmaster', task_type: 'agent_message', subject_key: 'digest:2026-08-30' }
);
export const F8 = fixture(
  '7e779b92-4f02-444d-83cf-cc1e9ad50935',
  'Read-only ownership/capability question. Please identify responsible current session?',
  { sender: 'codex', task_type: 'agent_message', recipient: 'xo' }
);
export const F9 = fixture(
  '3c0b1abb-92a5-4ceb-b487-ac7c745ad6ad',
  'Unclaimed P0: work has no owner.',
  { sender: 'taskmaster', task_type: 'agent_message' }
);
export const F10 = fixture(
  '47295a61-3a01-4e5c-9682-f9b30cf1c2a9',
  'Taskmaster expectation EXHAUSTED -- no human has confirmed this work landed.',
  {
    sender: 'taskmaster',
    task_type: 'agent_message',
    recipient: 'xo',
    priority: 'blocker',
    subject_key: null,
  }
);
export const F11 = fixture(
  'c58d894e-60fd-4f62-bdd4-c16a04941c38',
  'Arc B: TWO items need XO action.',
  { sender: 'ArcB-Owner', task_type: 'agent_message', recipient: 'xo' }
);
export const F12 = fixture(
  '82e86c75-1bd6-4ed9-b071-54e91c6c02d6',
  '{"kind":"overseer_run_report","blocker":"run BLOCKED"}'
);

export const INBOX_READER_FIXTURES = [F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12];
