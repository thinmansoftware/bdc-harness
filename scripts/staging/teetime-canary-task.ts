// Fixed synthetic task only. This entrypoint cannot accept a product prompt.
import { rootLogger } from '../../packages/paths/src/logger';
import { acceptCanaryChunk, type CanaryCompletion } from './teetime-canary-result';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const emit = process.stdout.write.bind(process.stdout);
rootLogger.level = 'silent';
// Provider diagnostics must never be emitted from this authenticated process.
console.log =
  console.info =
  console.warn =
  console.error =
  console.debug =
    (): void => {
      // Discard raw diagnostics at the authenticated process boundary.
    };
const controller = new AbortController();
const timer = setTimeout(() => {
  controller.abort();
}, 90000);
let passed = false;
const state: CanaryCompletion = { results: 0, failureCode: 'none' };
try {
  // Initialize provider children only after the actual Pino root is silent.
  const { createRestrictedCanaryWorkerProvider } =
    await import('../../packages/providers/src/codex/restricted-run-factory');
  const policy = readFileSync('/app/packages/providers/src/codex/restricted-policy.ts');
  const provider = createRestrictedCanaryWorkerProvider({
    runId: 'teetime-authenticated-synthetic-canary',
    policyDigest: 'sha256:' + createHash('sha256').update(policy).digest('hex'),
    workspace: '/workspace',
  });
  for await (const chunk of provider.sendQuery(
    'Create only /workspace/canary.txt containing exactly tee-time-canary-ready followed by one newline. Do not read other files, run network commands, install tools, or modify any other path. This is a synthetic infrastructure check, not application work.',
    '/workspace',
    undefined,
    { abortSignal: controller.signal }
  )) {
    acceptCanaryChunk(state, chunk);
  }
  passed = state.results === 1;
} catch {
  if (state.failureCode === 'none') state.failureCode = 'provider_failed';
  passed = false;
} finally {
  clearTimeout(timer);
}
emit(
  JSON.stringify({
    passed,
    modelInvocations: 1,
    servedModelVerified: false,
    failureCode: state.failureCode,
    terminalCount: state.results,
    systemCategory: state.systemCategory ?? 'none',
    diagnosticHint: state.diagnosticHint ?? 'none',
  }) + '\n'
);
// The trusted wrapper receives the sanitized failure category and determines exit.
