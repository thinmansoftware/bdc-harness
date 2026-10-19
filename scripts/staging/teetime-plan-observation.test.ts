import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readPlanObservation } from './teetime-plan-observation';
import * as observations from './teetime-plan-observation';

test('minimal Python producer binds actual reviewed carrier and immutable independent review',()=>{
  const code='import sys;sys.path.insert(0,sys.argv[1]);from test_teetime_minimal_plan_observation import MinimalPlanObservationTests;f=MinimalPlanObservationTests();f.setUp();sys.stdout.buffer.write(f.observe())';
  const raw=execFileSync(process.platform==='win32'?'python':'python3',
    ['-I','-c',code,import.meta.dirname],{timeout:5000,maxBuffer:32768});
  const value=JSON.parse(raw.toString('ascii'));
  const binding={nonce:'2'.repeat(32),baseSha:'bf6e8935768cf39ebb56b3ef44535830fd71ea7f',
    runId:'a'.repeat(32),reviewHead:'1'.repeat(40),preparedBindingHash:value.preparedBindingHash,
    executionHash:value.executionHash,admissionHash:value.admissionHash,installedManifestHash:value.installedManifestHash,
    sourceSha:value.sourceSha,operatorInputHash:value.operatorInputHash};
  const result=observations.readMinimalPlanObservation(raw,binding,1001000);
  expect(result.review.reviews[0].id).toBe(12);expect(Object.isFrozen(result.review)).toBe(true);
  expect(()=>readPlanObservation(raw,binding,1001000)).toThrow();
  for(const [key,bad] of [['admissionHash','sha256:'+'f'.repeat(64)],['installedManifestHash','sha256:'+'f'.repeat(64)],
    ['sourceSha','f'.repeat(40)],['operatorInputHash','f'.repeat(64)],['nonce','f'.repeat(32)],
    ['kind','tee-time-plan-observation'],['extra','PRIVATE']]){
    expect(()=>observations.readMinimalPlanObservation(Buffer.from(JSON.stringify({...value,[key]:bad})),binding,1001000)).toThrow();
  }
  const duplicate=raw.toString('ascii').replace('"version":1','"version":1,"version":1');
  expect(()=>observations.readMinimalPlanObservation(Buffer.from(duplicate),binding,1001000)).toThrow();
  expect(()=>observations.readMinimalPlanObservation(raw,binding,1060000)).toThrow();
  expect(()=>observations.readMinimalPlanObservation(Buffer.alloc(32769,32),binding,1001000)).toThrow();
});

test('actual Python producer bytes are accepted by the TypeScript parser', () => {
  const code =
    'import sys;sys.path.insert(0,sys.argv[1]);from test_teetime_plan_observation import PlanObservationTests;f=PlanObservationTests();f.setUp();sys.stdout.buffer.write(f.observe())';
  const raw = execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-c', code, import.meta.dirname],
    { timeout: 5000, maxBuffer: 65536 }
  );
  const value = JSON.parse(raw.toString('ascii'));
  const result = readPlanObservation(
    raw,
    {
      nonce: '2'.repeat(32),
      baseSha: 'bf6e8935768cf39ebb56b3ef44535830fd71ea7f',
      runId: 'actual-run',
      reviewHead: '1'.repeat(40),
      preparedBindingHash: 'sha256:' + 'c'.repeat(64),
      executionHash: value.executionHash,
    },
    1001000
  );
  expect(result.review.reviews[0].id).toBe(12);
});

const expected = {
  nonce: 'a'.repeat(32),
  baseSha: 'bf6e8935768cf39ebb56b3ef44535830fd71ea7f',
  executionHash: 'sha256:' + 'b'.repeat(64),
  preparedBindingHash: 'sha256:' + 'c'.repeat(64),
  runId: 'actual-run',
  reviewHead: 'd'.repeat(40),
};
function packet() {
  return {
    version: 1,
    kind: 'tee-time-plan-observation',
    remote: 'bdc-server',
    nonce: expected.nonce,
    remoteStagingSha: expected.baseSha,
    observedAtMs: 100000,
    expiresAtMs: 160000,
    executionHash: expected.executionHash,
    preparedBindingHash: expected.preparedBindingHash,
    runId: expected.runId,
    repository: 'thinmansoftware/bdc-xo',
    pullRequest: 3392,
    packagePath: 'docs/tee-time/supervised-demo-execution.json',
    review: {
      head: expected.reviewHead,
      state: 'OPEN',
      author: 'builder',
      complete: true,
      reviews: [
        {
          id: 123,
          head: expected.reviewHead,
          login: 'thinman-overseer[bot]',
          state: 'APPROVED',
          submittedAt: '2026-10-19T00:00:00Z',
        },
      ],
    },
  };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
test('fresh packet has immutable review and bound observation identity', () => {
  const result = readPlanObservation(bytes(packet()), expected, 101000);
  expect(result.observationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(Object.isFrozen(result.review)).toBe(true);
  expect(Object.isFrozen(result.review.reviews)).toBe(true);
  expect(Object.isFrozen(result.review.reviews[0])).toBe(true);
});
test('expired, future, foreign and duplicate-key observations cannot authorize transition', () => {
  expect(() => readPlanObservation(bytes(packet()), expected, 160000)).toThrow();
  expect(() => readPlanObservation(bytes(packet()), expected, 94999)).toThrow();
  for (const change of [
    { nonce: 'e'.repeat(32) },
    { executionHash: 'sha256:' + 'f'.repeat(64) },
    { runId: 'foreign' },
    { pullRequest: 1 },
    { remote: 'other' },
    { expiresAtMs: 999999 },
  ])
    expect(() =>
      readPlanObservation(bytes({ ...packet(), ...change }), expected, 101000)
    ).toThrow();
  const duplicate = bytes(packet()).toString().replace('"version":1', '"version":1,"version":1');
  expect(() => readPlanObservation(Buffer.from(duplicate), expected, 101000)).toThrow();
});
test('review head and closed nested record fields are checked', () => {
  const value = packet();
  value.review.head = '0'.repeat(40);
  expect(() => readPlanObservation(bytes(value), expected, 101000)).toThrow();
  const extra = packet();
  Object.assign(extra.review.reviews[0], { ignored: 'no' });
  expect(() => readPlanObservation(bytes(extra), expected, 101000)).toThrow();
});
