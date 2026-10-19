// Unregistered fixed-response entry. No prompt/model/path/authority overrides.
// A future governed worker must own account delivery, source custody and reaping.
const emit = process.stdout.write.bind(process.stdout);
process.exitCode = 1;
if (process.argv.length === 2) {
  // Silence before dynamic provider/collector imports, including import failure.
  console.log = console.info = console.warn = console.error = console.debug = (): void => {};
  process.stdout.write = process.stderr.write = (): boolean => true;
  try {
    const { rootLogger } = await import('../../packages/paths/src/logger');
    rootLogger.level = 'silent';
    const { runMinimalDiagnostic } = await import('./teetime-minimal-diagnostic-runner');
    const { createHash } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    // Measurement only: the future worker must compare approved source custody.
    const policyHash = createHash('sha256')
      .update(readFileSync('/app/packages/providers/src/codex/restricted-policy.ts')).digest('hex');
    const result = await runMinimalDiagnostic((prompt, signal) => (async function* () {
      const { createRestrictedCanaryWorkerProvider } =
        await import('../../packages/providers/src/codex/restricted-run-factory');
      const provider = createRestrictedCanaryWorkerProvider({
        runId: 'teetime-minimal-diagnostic', policyDigest: 'sha256:' + policyHash,
        workspace: '/workspace',
      });
      yield* provider.sendQuery(prompt, '/workspace', undefined, { abortSignal: signal });
    })());
    emit(JSON.stringify(result) + '\n');
    process.exitCode = result.passed ? 0 : 1;
  } catch {
    // Absent receipt fails closed. No fabricated packet or raw initialization text.
  }
}
export {};
