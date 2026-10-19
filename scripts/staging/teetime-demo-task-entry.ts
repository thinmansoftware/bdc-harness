// Unregistered source-only demo entry. Controller custody, phase claim and
// persisted attempt must be verified before launching this authenticated child.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rootLogger } from '../../packages/paths/src/logger';
import { collectDemoTask, type DemoTaskResult } from './teetime-demo-task';

const emit = process.stdout.write.bind(process.stdout);
rootLogger.level = 'silent';
console.log = console.info = console.warn = console.error = console.debug = (): void => {};
const controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
let result: Readonly<DemoTaskResult> = {
  kind: 'supervised-demo-v1',
  collected: false,
  artifactBase64: null,
  modelInvocations: 0,
  assistantCount: 0,
  resultCount: 0,
  thinkingCount: 0,
  normalProviderEnd: false,
  providerIteratorClosed: false,
  aborted: false,
  servedModelVerified: false,
};
try {
  if (process.argv.length !== 2) throw new Error('demo arguments rejected');
  // A bounded stream read avoids allocating an unbounded stdin packet.
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of process.stdin) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (size > 160000) throw new Error('demo input bound');
    parts.push(bytes);
  }
  const raw = Buffer.concat(parts);
  if (!raw.length || raw.some(byte => byte > 127)) throw new Error('demo ASCII input required');
  const input = JSON.parse(raw.toString('ascii'));
  // The trusted producer uses exactly this compact serialization. Roundtrip
  // equality also rejects duplicate keys before policy/provider access.
  if (
    JSON.stringify(input) !== raw.toString('ascii') ||
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(',') !== 'policyHash,prompt,promptHash,runId' ||
    typeof input.runId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.runId) ||
    typeof input.policyHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.policyHash) ||
    typeof input.promptHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.promptHash) ||
    typeof input.prompt !== 'string' ||
    !/^[\x01-\x7f]{1,131072}$/.test(input.prompt) ||
    createHash('sha256').update(input.prompt, 'ascii').digest('hex') !== input.promptHash
  )
    throw new Error('demo input identity rejected');
  const policyHash = createHash('sha256')
    .update(readFileSync('/app/packages/providers/src/codex/restricted-policy.ts'))
    .digest('hex');
  if (policyHash !== input.policyHash) throw new Error('demo policy differs');
  const { createRestrictedCanaryWorkerProvider } =
    await import('../../packages/providers/src/codex/restricted-run-factory');
  const provider = createRestrictedCanaryWorkerProvider({
    runId: input.runId,
    policyDigest: 'sha256:' + policyHash,
    workspace: '/workspace',
  });
  // Explicit demo budget; the outer worker must enforce its own reaping bound.
  timer = setTimeout(() => controller.abort(), 600000);
  result = await collectDemoTask(
    (prompt, signal) =>
      provider.sendQuery(prompt, '/workspace', undefined, { abortSignal: signal }),
    input.prompt,
    input.promptHash,
    controller,
    () => clearTimeout(timer)
  );
} catch {
  // Never emit provider errors, input text, credentials or rejected source.
} finally {
  clearTimeout(timer);
}
emit(JSON.stringify(result) + '\n');
process.exitCode = result.collected ? 0 : 1;
