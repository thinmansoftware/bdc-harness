// Fixed synthetic task only. This entrypoint cannot accept a product prompt.
import { createRestrictedCanaryWorkerProvider } from '../../packages/providers/src/codex/restricted-run-factory';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const emit = process.stdout.write.bind(process.stdout);
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
try {
  const policy = readFileSync('/app/packages/providers/src/codex/restricted-policy.ts');
  const provider = createRestrictedCanaryWorkerProvider({
    runId: 'teetime-authenticated-synthetic-canary',
    policyDigest: 'sha256:' + createHash('sha256').update(policy).digest('hex'),
    workspace: '/workspace',
  });
  let results = 0;
  for await (const chunk of provider.sendQuery(
    'Create only /workspace/canary.txt containing exactly tee-time-canary-ready followed by one newline. Do not read other files, run network commands, install tools, or modify any other path. This is a synthetic infrastructure check, not application work.',
    '/workspace',
    undefined,
    { abortSignal: controller.signal }
  )) {
    if (chunk.type === 'system') throw new Error('unexpected system diagnostic');
    if (chunk.type === 'result') {
      // This provider emits this shape only for the SDK turn.completed event.
      if (
        chunk.isError ||
        chunk.errors?.length ||
        chunk.errorSubtype ||
        !chunk.sessionId ||
        chunk.servedModelId !== null ||
        chunk.servedModelMissingReason !== 'codex_sdk_does_not_expose_served_model'
      )
        throw new Error('canary rejected');
      results += 1;
    }
  }
  passed = results === 1;
} catch {
  passed = false;
} finally {
  clearTimeout(timer);
}
emit(JSON.stringify({ passed, modelInvocations: 1, servedModelVerified: false }) + '\n');
process.exitCode = passed ? 0 : 1;
