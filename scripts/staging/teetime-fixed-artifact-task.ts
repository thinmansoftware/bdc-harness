// Fixed canary entrypoint. No caller prompt, model, path or authority override.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rootLogger } from '../../packages/paths/src/logger';
import {
  createFixedArtifactContract,
  runFixedArtifactTask,
  type FixedArtifactResult,
} from './teetime-fixed-artifact';

const emit = process.stdout.write.bind(process.stdout);
rootLogger.level = 'silent';
console.log =
  console.info =
  console.warn =
  console.error =
  console.debug =
    (): void => {
      // Discard provider diagnostics at the authenticated process boundary.
    };
let result: Readonly<FixedArtifactResult> = {
  kind: 'fixed-artifact-v1',
  passed: false,
  artifactBase64: null,
  modelInvocations: 0,
  assistantCount: 0,
  resultCount: 0,
  thinkingCount: 0,
  normalProviderEnd: false,
  providerIteratorClosed: false,
  aborted: false,
  failureCategory: 'rejected',
  servedModelVerified: false,
};
const controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  if (process.argv.length !== 3) throw new Error('fixed task arguments rejected');
  const nonce = process.argv[2];
  // Reject malformed invocation before file/provider access.
  createFixedArtifactContract(nonce, '0'.repeat(64));
  const policy = readFileSync('/app/packages/providers/src/codex/restricted-policy.ts');
  const policyHash = createHash('sha256').update(policy).digest('hex');
  const contract = createFixedArtifactContract(nonce, policyHash);
  const { createRestrictedCanaryWorkerProvider } =
    await import('../../packages/providers/src/codex/restricted-run-factory');
  const provider = createRestrictedCanaryWorkerProvider({
    runId: contract.runId,
    policyDigest: 'sha256:' + policyHash,
    workspace: '/workspace',
  });
  timer = setTimeout(() => {
    controller.abort();
  }, 90000);
  result = await runFixedArtifactTask(
    (prompt, signal) =>
      provider.sendQuery(prompt, '/workspace', undefined, { abortSignal: signal }),
    nonce,
    policyHash,
    controller,
    () => {
      clearTimeout(timer);
    }
  );
} catch {
  // Fixed diagnostics only. Never emit provider exception strings or rejected text.
} finally {
  clearTimeout(timer);
}
emit(JSON.stringify(result) + '\n');
process.exitCode = result.passed ? 0 : 1;
