import type { CallModel, CallModelResult, ReviewerConfig } from '../types';

export const fixtureReviewers: ReviewerConfig[] = [
  { role: 'correctness', modelId: 'fixture/correctness' },
  { role: 'security-pii', modelId: 'fixture/security' },
  { role: 'qa-evidence', modelId: 'fixture/qa' },
  { role: 'scope-doctrine', modelId: 'fixture/scope' },
];

export const baseWorkOrder = 'Implement the fusion package and produce review artifacts.';

export const baseDiff = [
  'diff --git a/src/example.ts b/src/example.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/example.ts',
  '@@ -0,0 +1 @@',
  '+export const value = 1;',
].join('\n');

export const successfulStub: CallModel = async ({ role, modelId }): Promise<CallModelResult> => ({
  text: `PASS: ${role} found no blocking issues.`,
  servedModelId: modelId,
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  },
  ok: true,
});

export const missingReviewerStub: CallModel = async ({
  role,
  modelId,
}): Promise<CallModelResult> => ({
  text: role === 'qa-evidence' ? '' : `PASS: ${role}`,
  servedModelId: modelId,
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  },
  ok: role !== 'qa-evidence',
  error: role === 'qa-evidence' ? 'simulated timeout' : undefined,
});

export const mismatchStub: CallModel = async ({ role, modelId }): Promise<CallModelResult> => ({
  text: `PASS: ${role}`,
  servedModelId: role === 'correctness' ? 'fixture/wrong-model' : modelId,
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  },
  ok: true,
});
