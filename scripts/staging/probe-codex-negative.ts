// Synthetic AppArmor negative checks; no model or credentials.
import { mkdirSync } from 'node:fs';
if (process.env.TEE_TIME_SANDBOX_PROBE !== '1') throw new Error('probe container required');
mkdirSync('/protected/negative-mount', { recursive: true });
const result = Bun.spawnSync(['/app/teetime-mount-negative'], {
  env: { PATH: '/usr/bin:/bin' },
  timeout: 5000,
  stdout: 'pipe',
  stderr: 'pipe',
});
if (result.exitCode !== 0 || result.signalCode)
  throw new Error(`negative helper failed: exit=${result.exitCode}`);
const evidence = JSON.parse(result.stdout.toString());
if (
  evidence.destinationResult !== -1 ||
  evidence.destinationErrno !== 13 ||
  evidence.optionsResult !== -1 ||
  evidence.optionsErrno !== 13
)
  throw new Error('unexpected negative helper result');
console.log(
  JSON.stringify({ passed: true, modelInvocations: 0, appArmorAuditRequired: true, ...evidence })
);
