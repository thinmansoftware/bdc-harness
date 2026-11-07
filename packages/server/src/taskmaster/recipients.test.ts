import { test, expect } from 'bun:test';
import { validateProposal } from './guard';
import { RECIPIENT_ROUTES } from './recipients';
const proposal = {
  type: 'nudge' as const,
  threadRef: 't3:x',
  recipient: 'codex-mcp',
  body: '"Task" owner: builder Next action: inspect results',
  idempotencyKey: 'test',
  actsImmediately: true,
};
test('Stop 6: codex accepted by table and guard', () => {
  expect(RECIPIENT_ROUTES['codex-mcp']).toBe('dispatch');
  expect(validateProposal(proposal).allowed).toBe(true);
});
test('Stop 6: unknown rejected', () => {
  expect(validateProposal({ ...proposal, recipient: 'not-a-real-seat' }).allowed).toBe(false);
});
test('Stop 6: existing pairings preserved', () => {
  expect(validateProposal({ ...proposal, type: 'escalate_p0' }).allowed).toBe(false);
  expect(validateProposal({ ...proposal, recipient: 'duty-officer' }).allowed).toBe(false);
});
test('Stop 6: relay contract accepted only for relay recipient', () => {
  const body = JSON.stringify({
    schema: 't3-thread-nudge/v1',
    thread_id: 'mcp:x',
    text: 'Await operator review',
    reason: 'approval-stall',
    request_id: 'r:1',
  });
  expect(validateProposal({ ...proposal, recipient: 't3-desk-local', body }).allowed).toBe(true);
  expect(validateProposal({ ...proposal, recipient: 't3-desk-local' }).allowed).toBe(false);
});

for (const text of ['deploy production', 'charge the customer', 'send the email']) {
  test(`relay rejects forbidden action: ${text}`, () => {
    const body = JSON.stringify({
      schema: 't3-thread-nudge/v1',
      thread_id: 'mcp:x',
      request_id: 'r1',
      reason: 'approval-stall',
      text,
    });
    const result = validateProposal({ ...proposal, recipient: 't3-desk-local', body });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('spend_send_deploy_verb_rejected');
  });
}
