import { expect, test } from 'bun:test';
import { TEE_TIME_POLICY, policyDigest, teeTimeRunPolicy } from './tee-time-policy';
import {
  supervisedRunPolicy,
  TEE_TIME_SUPERVISED_POLICY,
  TEE_TIME_SUPERVISED_WO,
} from './tee-time-supervised-policy';

test('supervised exception cannot turn on the ordinary v1 demo route', () => {
  const original = policyDigest(TEE_TIME_POLICY);
  const newer = supervisedRunPolicy('owned-codebase', 'sha256:' + '1'.repeat(64));
  expect(TEE_TIME_POLICY.demoFeatures).toBe(false);
  expect(TEE_TIME_POLICY.version).toBe(1);
  expect(newer.woId).toBe(TEE_TIME_SUPERVISED_WO);
  expect(newer.hash).not.toBe(
    teeTimeRunPolicy('owned-codebase', 'sha256:' + '1'.repeat(64), TEE_TIME_SUPERVISED_WO).hash
  );
  expect(policyDigest(TEE_TIME_POLICY)).toBe(original);
  expect(TEE_TIME_SUPERVISED_POLICY.escalation).toBe(false);
  expect(TEE_TIME_SUPERVISED_POLICY.provider).toBe('codex-native-strict');
  expect(TEE_TIME_SUPERVISED_POLICY.model).toBe('gpt-5.6-sol');
});
test('incomplete runtime workflow identity cannot produce a policy', () => {
  expect(() => supervisedRunPolicy('', 'sha256:' + '1'.repeat(64))).toThrow();
  expect(() => supervisedRunPolicy('owned', 'latest')).toThrow();
});
