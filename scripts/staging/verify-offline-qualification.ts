import { getAgentProvider, registerBuiltinProviders } from '../../packages/providers/src';
import { resolveRestrictedRun } from '../../packages/workflows/src/tee-time-policy';
import type { WorkflowDeps } from '../../packages/workflows/src/deps';

if (process.env.ARCHON_OFFLINE_QUALIFICATION !== '1') throw new Error('offline profile required');
const token = process.env.ARCHON_OPERATOR_TOKEN;
if (!token) throw new Error('operator token required');
const root = 'http://127.0.0.1:3092';
const checks: string[] = [];
async function check(
  path: string,
  status: number,
  authorized = true,
  body?: unknown
): Promise<void> {
  const response = await fetch(`${root}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status !== status)
    throw new Error(`${path}: expected ${status}, got ${response.status}`);
  checks.push(`${path} ${status}`);
}
await check('/api/health', 200, false);
await check('/api/codebases', 401, false);
await check('/api/codebases', 200);
await check('/api/conversations', 401, false, { message: 'unauthorized request' });
await check('/api/conversations', 403, true, { message: 'blocked model request' });
await check('/api/workflows/bash-only/run', 403, true, {
  workflow: { name: 'bash-only', nodes: [{ id: 'shell', bash: 'touch /tmp/UNSAFE' }] },
});
await check('/api/workflows/runs/nonexistent/resume', 403, true, {});
registerBuiltinProviders();
for (const provider of ['claude', 'codex', 'codex-native-strict', 'cursor']) {
  let rejected = false;
  try {
    getAgentProvider(provider);
  } catch (error) {
    rejected = String(error).includes('offline_qualification_execution_disabled');
  }
  if (!rejected) throw new Error(`provider construction was not blocked: ${provider}`);
}
let workflowBlocked = false;
try {
  await resolveRestrictedRun({} as WorkflowDeps, undefined, '', { name: 'bash-only' });
} catch (error) {
  workflowBlocked = String(error).includes('offline_qualification_execution_disabled');
}
if (!workflowBlocked) throw new Error('direct workflow execution was not blocked');
const curlVersion = Bun.spawnSync(['curl', '--version'], { stdout: 'ignore', stderr: 'ignore' });
if (curlVersion.exitCode !== 0) throw new Error('curl executable unavailable');
const probe = Bun.spawnSync(
  ['curl', '--silent', '--max-time', '3', '--connect-timeout', '2', 'https://1.1.1.1'],
  { stdout: 'ignore', stderr: 'ignore' }
);
if (![7, 28].includes(probe.exitCode))
  throw new Error(`expected network connection failure, curl exit ${probe.exitCode}`);
console.log(
  JSON.stringify({
    passed: true,
    profile: 'offline-only',
    checks,
    providerFactories: 'blocked',
    workflowExecution: 'blocked',
    externalNetwork: 'connection failed; pair with Docker network inspection',
    curlExitCode: probe.exitCode,
  })
);
