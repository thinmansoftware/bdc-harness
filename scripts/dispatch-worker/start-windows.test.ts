/**
 * WO-HARNESS-DISPATCH-WORKER-STALE-LOCK-01 Tests 4 and 5 (launcher), Windows PowerShell.
 *
 * Each scenario dot-sources the REAL start-windows.ps1 in a child powershell.exe, replaces its
 * adapter functions (processes, port probe, sleep, clock) with stubs, and runs the real
 * Invoke-DispatchSupervisor. Time is a fake clock, so nothing sleeps. On a non-Windows host the
 * suite is skipped and the launcher behavior must be verified operator-side.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const IS_WINDOWS = process.platform === 'win32';
const suite = IS_WINDOWS ? describe : describe.skip;
const LAUNCHER = join(import.meta.dir, 'start-windows.ps1');
const SECRET = 's3cr3t-token-value-do-not-print';

interface ScenarioResult {
  code: number;
  log: string[];
  sleeps: number[];
  tunnels: number;
  workers: number;
  stopped: number[];
  violations: string[];
  maxAliveTunnels: number;
  maxAliveWorkers: number;
  tunnelStarts: number[];
  workerStarts: number[];
  diedAt: number[];
  clock: number;
}

const HEADER = `
$ErrorActionPreference = 'Stop'
. '${LAUNCHER.replace(/'/g, "''")}'
$script:clock = 0
$script:log = New-Object System.Collections.ArrayList
$script:sleeps = New-Object System.Collections.ArrayList
$script:tunnels = New-Object System.Collections.ArrayList
$script:workers = New-Object System.Collections.ArrayList
$script:stopped = New-Object System.Collections.ArrayList
$script:violations = New-Object System.Collections.ArrayList
$script:diedAt = New-Object System.Collections.ArrayList
$script:maxAliveTunnels = 0
$script:maxAliveWorkers = 0
$script:nextId = 1000
$script:Tick = $null
$script:OnTunnelStart = $null
$script:OnWorkerStart = $null
$script:PortOpen = $null

function Write-LauncherLog { param([string]$Message) [void]$script:log.Add($Message) }
function Get-LauncherNow { return ([DateTime]'2026-11-09T00:00:00Z').AddSeconds($script:clock) }
function Invoke-LauncherSleep {
    param([int]$Seconds)
    [void]$script:sleeps.Add($Seconds)
    $script:clock += $Seconds
    if ($script:Tick) { $null = & $script:Tick }
}
function New-StubProcess {
    param([string]$Role)
    $script:nextId++
    return [pscustomobject]@{ Id = $script:nextId; Role = $Role; HasExited = $false; ExitCode = $null; StartedAt = $script:clock }
}
function Get-AliveCount { param($List) return @($List | Where-Object { -not $_.HasExited }).Count }
function Start-TunnelProcess {
    param([string]$SshHost, [int]$LocalPort)
    $p = New-StubProcess -Role 'tunnel'
    [void]$script:tunnels.Add($p)
    if ($script:OnTunnelStart) { $null = & $script:OnTunnelStart $p }
    $alive = Get-AliveCount -List $script:tunnels
    if ($alive -gt $script:maxAliveTunnels) { $script:maxAliveTunnels = $alive }
    return $p
}
function Start-WorkerProcess {
    param([string]$ConfigPath)
    $p = New-StubProcess -Role 'worker'
    [void]$script:workers.Add($p)
    $alive = (Get-AliveCount -List $script:workers) + 0
    if ($alive -gt $script:maxAliveWorkers) { $script:maxAliveWorkers = $alive }
    if ($script:OnWorkerStart) { $null = & $script:OnWorkerStart $p }
    return $p
}
function Stop-OwnedProcess {
    param($Process)
    if ($null -eq $Process) { return }
    $known = @(@($script:tunnels) + @($script:workers) | Where-Object { $_.Id -eq $Process.Id })
    if ($known.Count -eq 0) { [void]$script:violations.Add('stopped a process the launcher did not start') }
    [void]$script:stopped.Add($Process.Id)
    if (-not $Process.HasExited) { $Process.HasExited = $true; $Process.ExitCode = -1 }
}
function Test-LocalPortOpen {
    param([int]$Port)
    if ($script:PortOpen) { return [bool](& $script:PortOpen) }
    return $false
}
`;

const FOOTER = `
$code = Invoke-DispatchSupervisor -ConfigPath 'stub-config' -SshHost 'stub-host' -LocalPort 3900
$result = [pscustomobject]@{
    code = [int]$code
    log = @($script:log)
    sleeps = @($script:sleeps)
    tunnels = $script:tunnels.Count
    workers = $script:workers.Count
    stopped = @($script:stopped)
    violations = @($script:violations)
    maxAliveTunnels = $script:maxAliveTunnels
    maxAliveWorkers = $script:maxAliveWorkers
    tunnelStarts = @($script:tunnels | ForEach-Object { $_.StartedAt })
    workerStarts = @($script:workers | ForEach-Object { $_.StartedAt })
    diedAt = @($script:diedAt)
    clock = $script:clock
}
Write-Output ('RESULT_JSON=' + ($result | ConvertTo-Json -Compress -Depth 6))
`;

// A listener exists while any tunnel the launcher started is alive.
const TUNNEL_LISTENER = `$script:PortOpen = { return (Get-AliveCount -List $script:tunnels) -gt 0 }`;
// A running worker stops cleanly after five stub minutes.
const WORKER_ENDS_CLEAN = `
$script:Tick = {
  foreach ($w in $script:workers) {
    if (-not $w.HasExited -and ($script:clock - $w.StartedAt) -ge 300) { $w.HasExited = $true; $w.ExitCode = 0 }
  }
}`;

async function runScenario(body: string): Promise<ScenarioResult> {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-'));
  try {
    const file = join(dir, 'scenario.ps1');
    await writeFile(file, `${HEADER}\n${body}\n${FOOTER}`, 'utf8');
    const proc = Bun.spawn(
      [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        file,
      ],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BDC_TEST_SECRET: SECRET } }
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const line = out.split(/\r?\n/).find(l => l.startsWith('RESULT_JSON='));
    if (!line) throw new Error(`scenario produced no result. stdout=${out} stderr=${err}`);
    const raw = line.slice('RESULT_JSON='.length);
    expect(raw).not.toContain(SECRET);
    return JSON.parse(raw) as ScenarioResult;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

suite('start-windows.ps1 launcher supervisor (real PowerShell, stubbed processes)', () => {
  test('Test 4: a worker that exits 1 twice is retried with backoff and the third attempt runs', async () => {
    const r = await runScenario(`
${TUNNEL_LISTENER}
${WORKER_ENDS_CLEAN}
$script:workerCount = 0
$script:OnWorkerStart = { param($p) $script:workerCount++; if ($script:workerCount -le 2) { $p.HasExited = $true; $p.ExitCode = 1 } }
`);
    expect(r.code).toBe(0);
    expect(r.log).toContain('attempt 1 of 5 failed: worker exited with code 1');
    expect(r.log).toContain('retrying in 10 s (retry 1)');
    expect(r.log).toContain('retrying in 30 s (retry 2)');
    expect(r.workers).toBe(3);
    expect(r.tunnels).toBe(3);
    expect(r.sleeps.filter(s => s >= 10).slice(0, 2)).toEqual([10, 30]);
    expect(r.maxAliveWorkers).toBe(1);
    expect(r.maxAliveTunnels).toBe(1);
    expect(r.violations).toEqual([]);
  });

  test('Test 4: a genuine already-running holder (exit 75) stops retries and exits 0', async () => {
    const r = await runScenario(`
${TUNNEL_LISTENER}
$script:OnWorkerStart = { param($p) $p.HasExited = $true; $p.ExitCode = 75 }
`);
    expect(r.code).toBe(0);
    expect(r.workers).toBe(1);
    expect(
      r.log.some(l => l.startsWith('not retrying:') && l.includes('genuine live worker'))
    ).toBe(true);
    expect(r.sleeps.filter(s => s >= 10)).toEqual([]);
    expect(r.violations).toEqual([]);
  });

  test('Test 5: an owned tunnel that exits before readiness is replaced within the two-minute bound', async () => {
    const r = await runScenario(`
${TUNNEL_LISTENER}
${WORKER_ENDS_CLEAN}
$script:tunnelCount = 0
$script:OnTunnelStart = { param($p) $script:tunnelCount++; if ($script:tunnelCount -eq 1) { $p.HasExited = $true; $p.ExitCode = 255 } }
`);
    expect(r.code).toBe(0);
    expect(r.log).toContain(
      'attempt 1 of 5 failed: ssh tunnel exited before readiness (exit code 255)'
    );
    expect(r.tunnels).toBe(2);
    expect(r.workers).toBe(1);
    expect((r.workerStarts[0] ?? 999) - (r.tunnelStarts[0] ?? 0)).toBeLessThanOrEqual(120);
    expect(r.violations).toEqual([]);
  });

  test('Test 5: a tunnel lost after the worker started restarts the same pair, never two of either', async () => {
    const r = await runScenario(`
${TUNNEL_LISTENER}
$script:Tick = {
  foreach ($w in $script:workers) {
    if (-not $w.HasExited -and ($script:clock - $w.StartedAt) -ge 300) { $w.HasExited = $true; $w.ExitCode = 0 }
  }
  $first = $script:tunnels[0]
  if ($first -and -not $first.HasExited -and ($script:clock - $first.StartedAt) -ge 60) {
    $first.HasExited = $true; $first.ExitCode = 255; [void]$script:diedAt.Add($script:clock)
  }
}
`);
    expect(r.code).toBe(0);
    expect(r.workers).toBe(2);
    expect(r.tunnels).toBe(2);
    expect(r.maxAliveWorkers).toBe(1);
    expect(r.maxAliveTunnels).toBe(1);
    expect(
      r.log.some(l => l.includes('ssh tunnel exited while the worker ran (exit code 255)'))
    ).toBe(true);
    // the first worker was stopped by the launcher (it started it), and nothing else was
    expect(r.stopped).toContain(1002);
    expect(r.violations).toEqual([]);
    expect((r.workerStarts[1] ?? 9999) - (r.diedAt[0] ?? 0)).toBeLessThanOrEqual(120);
  });

  test('Test 5: a foreign listener on the port is never terminated and fails loudly within a bounded budget', async () => {
    const r = await runScenario(`
$script:PortOpen = { return $true }
`);
    expect(r.code).toBe(1);
    expect(r.tunnels).toBe(0);
    expect(r.workers).toBe(0);
    expect(r.stopped).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(
      r.log.filter(l => l.includes('did not start') && l.includes('not terminated'))
    ).toHaveLength(5);
    expect(r.log[r.log.length - 1]).toContain('retry budget exhausted');
  });

  test('Test 5: repeated ssh failure exhausts the bounded attempts with a non-zero exit and a redacted reason', async () => {
    const r = await runScenario(`
${TUNNEL_LISTENER}
$script:OnTunnelStart = { param($p) $p.HasExited = $true; $p.ExitCode = 255 }
`);
    expect(r.code).toBe(1);
    expect(r.tunnels).toBe(5);
    expect(r.workers).toBe(0);
    expect(r.sleeps).toEqual([10, 30, 60, 120]);
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(220);
    expect(r.log[r.log.length - 1]).toContain('retry budget exhausted');
    for (const line of r.log) expect(line).not.toMatch(/token|secret|password/i);
  });

  test('no tight retry: every backoff wait is at least ten seconds and none exceeds two minutes', async () => {
    const r = await runScenario(`
${TUNNEL_LISTENER}
$script:OnTunnelStart = { param($p) $p.HasExited = $true; $p.ExitCode = 255 }
`);
    for (const s of r.sleeps) {
      expect(s).toBeGreaterThanOrEqual(10);
      expect(s).toBeLessThanOrEqual(120);
    }
  });

  test('a run that stays up for ten minutes resets the failure count, so spaced failures never exhaust the budget', async () => {
    const r = await runScenario(`
${TUNNEL_LISTENER}
$script:workerCount = 0
$script:Tick = {
  foreach ($w in $script:workers) {
    if (-not $w.HasExited) {
      $n = $script:workers.IndexOf($w) + 1
      if ($n -le 6 -and ($script:clock - $w.StartedAt) -ge 700) { $w.HasExited = $true; $w.ExitCode = 1 }
      if ($n -gt 6 -and ($script:clock - $w.StartedAt) -ge 300) { $w.HasExited = $true; $w.ExitCode = 0 }
    }
  }
}
`);
    expect(r.code).toBe(0);
    expect(r.workers).toBe(7);
    expect(r.log.filter(l => l.startsWith('attempt 1 of 5 failed'))).toHaveLength(6);
    expect(r.log.some(l => l.includes('exhausted'))).toBe(false);
  });

  test('the real launcher file parses under Windows PowerShell and -ValidateOnly accepts a valid config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-cfg-'));
    try {
      const cfg = join(dir, 'config.local.json');
      await writeFile(cfg, JSON.stringify({ server_url: 'http://127.0.0.1:3900' }), 'utf8');
      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          LAUNCHER,
          '-ConfigPath',
          cfg,
          '-ValidateOnly',
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(out).toContain('DISPATCH_WINDOWS_LAUNCHER_VALID');
      expect(code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
