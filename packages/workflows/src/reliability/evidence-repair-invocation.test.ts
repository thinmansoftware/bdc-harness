import { expect, test } from 'bun:test';
import { verifyRepairInvocation, type RepairInvocation } from './evidence-repair-invocation';
const original: RepairInvocation = {
  repositoryId: 1,
  repository: 'thinmansoftware/example',
  pr: 7,
  head: 'a'.repeat(40),
  runId: 10,
  attempt: 1,
  workflowId: 20,
  jobId: 30,
  checkId: 30,
  checkName: 'manifest-validate / manifest-validate',
  appId: 15368,
  event: 'pull_request',
  checkConclusion: 'failure',
  stepConclusion: 'failure',
  callerSha: 'b'.repeat(40),
  reusableSha: 'c'.repeat(40),
  scriptsSha: 'd'.repeat(40),
  checkoutSha: 'e'.repeat(40),
  checkoutParents: ['f'.repeat(40), 'a'.repeat(40)],
  stepNumber: 6,
  stepName: 'Validate manifest v2 block',
};
const current = (): RepairInvocation => ({
  ...original,
  runId: 11,
  jobId: 31,
  checkId: 31,
  checkConclusion: 'success',
  stepConclusion: 'success',
});
const verify = (candidate: RepairInvocation) =>
  verifyRepairInvocation(original, candidate, {
    repairHead: original.head,
    baseSha: 'f'.repeat(40),
    finalLocalHead: original.head,
    finalRemoteHead: original.head,
    callerSha: original.callerSha,
    reusableSha: original.reusableSha,
    scriptsSha: original.scriptsSha,
  });
test('new successful invocation on bound unchanged repair head', () =>
  expect(verify(current()).state).toBe('verified'));
for (const [key, value] of Object.entries({
  runId: 10,
  attempt: 0,
  repositoryId: 2,
  repository: 'other/repo',
  pr: 8,
  head: 'f'.repeat(40),
  workflowId: 21,
  appId: 9,
  event: 'push',
  checkName: 'another check',
  checkConclusion: 'neutral',
  stepConclusion: 'skipped',
  callerSha: 'f'.repeat(40),
  reusableSha: 'f'.repeat(40),
  scriptsSha: 'f'.repeat(40),
  stepNumber: 7,
  stepName: 'Different step',
})) {
  test('rejects mismatched ' + key, () =>
    expect(verify({ ...current(), [key]: value }).state).toBe('unknown')
  );
}
test('unbound check job cannot substitute', () =>
  expect(verify({ ...current(), checkId: 999 }).state).toBe('unknown'));
test('wrong merge checkout parent fails', () =>
  expect(verify({ ...current(), checkoutParents: ['f'.repeat(40)] }).state).toBe('unknown'));
test('changed final head fails', () =>
  expect(
    verifyRepairInvocation(original, current(), {
      repairHead: original.head,
      baseSha: 'f'.repeat(40),
      finalLocalHead: 'f'.repeat(40),
      finalRemoteHead: original.head,
      callerSha: original.callerSha,
      reusableSha: original.reusableSha,
      scriptsSha: original.scriptsSha,
    }).state
  ).toBe('unknown'));

test('wrong merge base fails even with correct head parent', () =>
  expect(verify({ ...current(), checkoutParents: ['b'.repeat(40), original.head] }).state).toBe(
    'unknown'
  ));
