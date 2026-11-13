/**
 * WO-HARNESS-DISPATCH-WORKER-STALE-LOCK-01 Tests 4 and 5 (launcher), Windows PowerShell.
 *
 * Each scenario dot-sources the REAL start-windows.ps1 in a child powershell.exe, replaces its
 * adapter functions (processes, port probe, sleep, clock) with stubs, and runs the real
 * Invoke-DispatchSupervisor. Time is a fake clock, so nothing sleeps. On a non-Windows host the
 * suite is skipped and the launcher behavior must be verified operator-side.
 */
import { describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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
  workerSignals: number;
  events: { message: string; at: number; liveWorkers: number[]; workerSignals: number }[];
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
$script:ListenerState = $null
$script:workerSignals = 0
$script:events = New-Object System.Collections.ArrayList

function Write-LauncherLog {
    param([string]$Message)
    [void]$script:log.Add($Message)
    [void]$script:events.Add(@{ message = $Message; at = $script:clock; liveWorkers = @($script:workers | Where-Object { -not $_.HasExited } | ForEach-Object { $_.Id }); workerSignals = $script:workerSignals })
}
function Get-LauncherNow { return ([DateTime]'2026-11-09T00:00:00Z').AddSeconds($script:clock) }
function Invoke-LauncherSleep {
    param([int]$Seconds)
    [void]$script:sleeps.Add($Seconds)
    $script:clock += $Seconds
    if ($script:Tick) { $null = & $script:Tick }
    if ($script:clock -gt 5000) { throw 'synthetic scenario exceeded its fake-clock bound' }
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
function Update-TrackedDescendants { param($Process, $Tracked) }
function Stop-OwnedProcess {
    param($Process, $Tracked)
    if ($null -eq $Process) { return }
    $known = @(@($script:tunnels) + @($script:workers) | Where-Object { $_.Id -eq $Process.Id })
    if ($known.Count -eq 0) { [void]$script:violations.Add('stopped a process the launcher did not start') }
    [void]$script:stopped.Add($Process.Id)
    if ($Process.Role -eq 'worker' -and -not $Process.HasExited) { $script:workerSignals++ }
    if (-not $Process.HasExited) { $Process.HasExited = $true; $Process.ExitCode = -1 }
}
function Test-LocalPortOpen {
    param([int]$Port)
    if ($script:PortOpen) { return [bool](& $script:PortOpen) }
    return $false
}
function Get-OwnedTunnelListenerState {
    param($Tunnel, [int]$Port)
    if ($script:ListenerState) { return (& $script:ListenerState $Tunnel) }
    if (-not (Test-LocalPortOpen -Port $Port)) { return 'absent' }
    if ($null -ne $Tunnel -and -not $Tunnel.HasExited) { return 'owned' }
    return 'foreign'
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
    workerSignals = $script:workerSignals
    events = @($script:events)
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

  test('recovery Tests 1 and 5: tunnel loss reconnects only the forward and preserves the in-flight worker', async () => {
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
    expect(r.workers).toBe(1);
    expect(r.tunnels).toBe(2);
    expect(r.maxAliveWorkers).toBe(1);
    expect(r.maxAliveTunnels).toBe(1);
    expect(r.log.some(l => l.includes('TRANSPORT_RECOVERED'))).toBe(true);
    // Cleanup runs only after the original worker naturally completes its five-minute task.
    expect(r.stopped).toContain(1002);
    expect(r.workerSignals).toBe(0);
    expect(r.clock).toBeGreaterThanOrEqual(300);
    expect(r.events.find(e => e.message.includes('TRANSPORT_RECOVERED'))?.liveWorkers).toEqual([
      1002,
    ]);
    expect(r.violations).toEqual([]);
    expect((r.tunnelStarts[1] ?? 9999) - (r.diedAt[0] ?? 0)).toBe(1);
  });

  test('Overseer finding on df482267a: descendants that survive the stop block a replacement worker', async () => {
    const r = await runScenario(`
${TUNNEL_LISTENER}
function Stop-OwnedProcess {
    param($Process, $Tracked)
    if ($null -eq $Process) { return }
    [void]$script:stopped.Add($Process.Id)
    if (-not $Process.HasExited) { $Process.HasExited = $true; $Process.ExitCode = -1 }
    if ($Process.Role -eq 'worker') { $script:DescendantsSurvived += 2 }
}
$script:Tick = {
  $first = $script:workers[0]
  if ($first -and -not $first.HasExited -and ($script:clock - $first.StartedAt) -ge 60) {
    $first.HasExited = $true; $first.ExitCode = 1
  }
}
`);
    expect(r.code).toBe(1);
    expect(r.workers).toBe(1);
    expect(r.tunnels).toBe(1);
    expect(r.log.some(l => l.includes('refusing to restart: 2 process(es)'))).toBe(true);
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

// Recovery runs through the existing supervisor. All clocks and processes here are synthetic;
// the real PowerShell launcher is executed only on the hosted Windows runner, never the desktop.
const RECOVERY_SCENARIO = `
${TUNNEL_LISTENER}
$script:WorkerExitAt = 1200
$script:DuringTick = $null
$script:Tick = {
  $first = $script:tunnels[0]
  if ($first -and -not $first.HasExited -and $script:clock -ge 5) {
    $first.HasExited = $true; $first.ExitCode = 255; [void]$script:diedAt.Add($script:clock)
  }
  if ($script:DuringTick) { $null = & $script:DuringTick }
  foreach ($w in $script:workers) {
    if (-not $w.HasExited -and $script:clock -ge $script:WorkerExitAt) { $w.HasExited = $true; $w.ExitCode = 0 }
  }
}
`;

function expectPreservedWorker(r: ScenarioResult): void {
  expect(r.code).toBe(0);
  expect(r.workers).toBe(1);
  expect(r.workerStarts).toEqual([0]);
  expect(r.workerSignals).toBe(0);
  expect(r.maxAliveWorkers).toBe(1);
  expect(r.maxAliveTunnels).toBeLessThanOrEqual(1);
  expect(r.violations).toEqual([]);
}

suite('owned tunnel recovery inside the current supervisor', () => {
  test('Test 2: exactly three reconnects use 1/2/4 seconds and exhaustion holds beyond the stable reset window', async () => {
    const r = await runScenario(`${RECOVERY_SCENARIO}
$script:OnTunnelStart = { param($p) if ($script:tunnels.Count -gt 1) { $p.HasExited = $true; $p.ExitCode = 255 } }
`);
    expectPreservedWorker(r);
    expect(r.tunnelStarts).toEqual([0, 6, 8, 12]);
    expect(r.events.filter(e => e.message.startsWith('RECONNECT_ATTEMPT_')).map(e => e.at)).toEqual(
      [6, 8, 12]
    );
    const exhausted = r.events.filter(e => e.message.includes('DEGRADED_EXHAUSTED'));
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.liveWorkers).toEqual([1002]);
    expect(exhausted[0]?.workerSignals).toBe(0);
    expect(r.clock).toBeGreaterThanOrEqual(1200);
  });

  test('readiness is bounded to 30 one-second checks per attempt with verified cleanup before replacement', async () => {
    const r = await runScenario(`${RECOVERY_SCENARIO}
$script:PortOpen = { return $script:tunnels.Count -eq 1 -and -not $script:tunnels[0].HasExited }
`);
    expectPreservedWorker(r);
    expect(r.tunnelStarts).toEqual([0, 6, 38, 72]);
    expect(r.sleeps.filter(s => s === 1)).toHaveLength(97); // 90 readiness + 1/2/4 backoff ticks
    expect(r.events.find(e => e.message.includes('DEGRADED_EXHAUSTED'))?.at).toBe(102);
    expect(r.tunnels).toBe(4);
  });

  test('successful reconnects do not reset the three-attempt budget on repeated drops', async () => {
    const r = await runScenario(`${RECOVERY_SCENARIO}
$script:DuringTick = {
  foreach ($p in $script:tunnels) {
    if (-not $p.HasExited -and ($script:clock - $p.StartedAt) -ge 5) { $p.HasExited = $true; $p.ExitCode = 255 }
  }
}
`);
    expectPreservedWorker(r);
    expect(r.tunnels).toBe(4);
    expect(r.log.filter(l => l.startsWith('RECONNECT_ATTEMPT_'))).toHaveLength(3);
    expect(r.log.filter(l => l.includes('TRANSPORT_RECOVERED'))).toHaveLength(3);
    expect(r.log.filter(l => l.includes('DEGRADED_EXHAUSTED'))).toHaveLength(1);
  });

  test.each([5, 6])(
    'Test 3: a foreign listener arriving at second %s is held without killing or borrowing it',
    async foreignAt => {
      const r = await runScenario(`${RECOVERY_SCENARIO}
$script:ListenerState = { param($p) if ($script:clock -ge ${foreignAt}) { return 'foreign' }; return 'absent' }
`);
      expectPreservedWorker(r);
      expect(r.tunnels).toBe(1);
      expect(r.stopped.every(pid => pid === 1001 || pid === 1002)).toBe(true);
      expect(r.log.some(l => l.includes('FOREIGN_LISTENER_REFUSED'))).toBe(true);
    }
  );

  test.each([6, 8])(
    'Test 4: worker exit at second %s stops recovery during backoff or readiness',
    async exitAt => {
      const r = await runScenario(`${RECOVERY_SCENARIO}
$script:WorkerExitAt = ${exitAt}
$script:PortOpen = { return $script:tunnels.Count -eq 1 -and -not $script:tunnels[0].HasExited }
`);
      expectPreservedWorker(r);
      expect(r.tunnels).toBe(exitAt === 6 ? 1 : 2);
      expect(r.log).toContain('worker stopped cleanly');
      expect(r.log.some(l => l.includes('DEGRADED_EXHAUSTED'))).toBe(false);
    }
  );

  test('cleanup uncertainty holds the same worker without a reconnect or repeat cleanup while it lives', async () => {
    const r = await runScenario(`${RECOVERY_SCENARIO}
function Stop-OwnedProcess {
  param($Process, $Tracked)
  if ($null -eq $Process) { return }
  [void]$script:stopped.Add($Process.Id)
  if ($Process.Role -eq 'tunnel') { $script:DescendantsSurvived++; return }
  if (-not $Process.HasExited) { $script:workerSignals++; $Process.HasExited = $true; $Process.ExitCode = -1 }
}
`);
    expect(r.workers).toBe(1);
    expect(r.workerSignals).toBe(0);
    expect(r.tunnels).toBe(1);
    expect(r.log.some(l => l.includes('CLEANUP_UNCERTAIN'))).toBe(true);
    expect(r.log.some(l => l.startsWith('RECONNECT_ATTEMPT_'))).toBe(false);
    expect(r.clock).toBeGreaterThanOrEqual(1200);
  });

  test.each(['unknown', 'throw'])(
    'observation uncertainty (%s) holds without another tunnel or worker signal',
    async mode => {
      const r = await runScenario(`${RECOVERY_SCENARIO}
$script:ListenerState = { param($p) ${mode === 'throw' ? "throw 'synthetic_observation_error'" : "return 'unknown'"} }
`);
      expectPreservedWorker(r);
      expect(r.tunnels).toBe(1);
      expect(r.log.some(l => l.includes('OBSERVATION_UNCERTAIN'))).toBe(true);
      expect(r.log.some(l => l.startsWith('RECONNECT_ATTEMPT_'))).toBe(false);
    }
  );
});

// Test 6 (installer part): the real install-windows.ps1 runs against STUBBED Task Scheduler
// cmdlets, so nothing is registered, stopped or changed on the machine.
suite('install-windows.ps1 (stubbed Task Scheduler)', () => {
  interface Registration {
    TaskName: string;
    TriggerKind: string;
    TriggerRepetitionInterval: string | null;
    TriggerRepetitionDuration: string | null;
    RestartCount: number | null;
    RestartInterval: string | null;
    MultipleInstances: string | null;
    ExecutionTimeLimit: string | null;
    LogonType: string | null;
    RunLevel: string | null;
    Execute: string | null;
    Argument: string | null;
  }

  const INSTALLER = join(import.meta.dir, 'install-windows.ps1');

  async function runInstaller(): Promise<Registration[]> {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-installer-'));
    try {
      const file = join(dir, 'installer-scenario.ps1');
      const script = `
$ErrorActionPreference = 'Stop'
$global:registrations = New-Object System.Collections.ArrayList
function New-ScheduledTaskAction { param($Execute, $Argument) return [pscustomobject]@{ Kind = 'action'; Execute = $Execute; Argument = $Argument } }
function New-ScheduledTaskTrigger {
    param([switch]$AtLogOn, [switch]$Once, $User, $At, $RepetitionInterval, $RepetitionDuration)
    $kind = 'other'
    if ($AtLogOn) { $kind = 'AtLogOn' }
    if ($Once) { $kind = 'Once' }
    return [pscustomobject]@{ Kind = $kind; RepetitionInterval = $RepetitionInterval; Repetition = [pscustomobject]@{ Duration = $(if ($RepetitionDuration) { $RepetitionDuration.ToString() } else { $null }) } }
}
function New-ScheduledTaskSettingsSet {
    param($MultipleInstances, $RestartCount, $RestartInterval, $ExecutionTimeLimit)
    return [pscustomobject]@{ MultipleInstances = $MultipleInstances; RestartCount = $RestartCount; RestartInterval = $RestartInterval; ExecutionTimeLimit = $ExecutionTimeLimit }
}
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) return [pscustomobject]@{ LogonType = $LogonType; RunLevel = $RunLevel } }
function Register-ScheduledTask {
    param($TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force)
    [void]$global:registrations.Add([pscustomobject]@{
        TaskName = $TaskName
        TriggerKind = $Trigger.Kind
        TriggerRepetitionInterval = $(if ($Trigger.RepetitionInterval) { $Trigger.RepetitionInterval.ToString() } else { $null })
        TriggerRepetitionDuration = $Trigger.Repetition.Duration
        RestartCount = $Settings.RestartCount
        RestartInterval = $(if ($Settings.RestartInterval) { $Settings.RestartInterval.ToString() } else { $null })
        MultipleInstances = [string]$Settings.MultipleInstances
        ExecutionTimeLimit = $(if ($null -ne $Settings.ExecutionTimeLimit) { $Settings.ExecutionTimeLimit.ToString() } else { $null })
        LogonType = [string]$Principal.LogonType
        RunLevel = [string]$Principal.RunLevel
        Execute = [string]$Action.Execute
        Argument = [string]$Action.Argument
    })
}
function Stop-Process { throw 'the installer must not stop any process' }
function Unregister-ScheduledTask { throw 'the installer must not unregister any task' }
$null = & '${INSTALLER.replace(/'/g, "''")}' -WorkerId 'dispatch-worker-STUB' -ConfigPath 'stub-config.json'
Write-Output ('RESULT_JSON=' + (ConvertTo-Json -Compress -Depth 6 -InputObject @($global:registrations)))
`;
      await writeFile(file, script, 'utf8');
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
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      const line = out.split(/\r?\n/).find(l => l.startsWith('RESULT_JSON='));
      if (!line)
        throw new Error(`installer scenario produced no result. stdout=${out} stderr=${err}`);
      return JSON.parse(line.slice('RESULT_JSON='.length)) as Registration[];
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('Test 6: registers exactly one worker task and the existing watchdog task, nothing else', async () => {
    const regs = await runInstaller();
    expect(regs.map(r => r.TaskName)).toEqual([
      'BlueDevil-Dispatch-Worker',
      'BlueDevil-Dispatch-Worker-Watchdog',
    ]);
  });

  test('Test 6: the worker task restarts 5 times at 1 minute, ignores a second instance, and has no lifetime cap', async () => {
    const worker = (await runInstaller())[0] as Registration;
    expect(worker.TriggerKind).toBe('AtLogOn');
    expect(worker.RestartCount).toBe(5);
    expect(worker.RestartInterval).toBe('00:01:00');
    expect(worker.MultipleInstances).toBe('IgnoreNew');
    // zero means unlimited in Task Scheduler: not the old one-day cap, not PT72H
    expect(worker.ExecutionTimeLimit).toBe('00:00:00');
  });

  test('both tasks run through conhost.exe --headless so no console window ever appears (2026-11-10, John: "this windows kept popping up")', async () => {
    const regs = await runInstaller();
    expect(regs.length).toBe(2);
    for (const r of regs) {
      expect(r.Execute, r.TaskName).toBe('conhost.exe');
      expect(r.Argument ?? '', r.TaskName).toMatch(/^--headless powershell\.exe -NoProfile /);
    }
    expect(regs[0]?.Argument).toContain('start-windows.ps1');
    expect(regs[1]?.Argument).toContain('watchdog-windows.ps1');
  });

  test('Test 6: the watchdog repeats every 5 minutes indefinitely, ignores a second instance, and keeps the limited interactive user', async () => {
    const regs = await runInstaller();
    const watchdog = regs[1] as Registration;
    expect(watchdog.TriggerKind).toBe('Once');
    expect(watchdog.TriggerRepetitionInterval).toBe('00:05:00');
    // cleared after construction: an empty duration is an indefinite repetition
    expect(watchdog.TriggerRepetitionDuration).toBe('');
    expect(watchdog.MultipleInstances).toBe('IgnoreNew');
    for (const r of regs) {
      expect(r.LogonType).toBe('Interactive');
      expect(r.RunLevel).toBe('Limited');
    }
  });
});

// Overseer finding on 9ac8b51e8: Start-Process joins ArgumentList elements into one command line
// without preserving argument boundaries, so a config path with a space was split and the worker
// got a truncated --config. This test runs the REAL Start-WorkerProcess (not a stub) against a
// probe that records the arguments it receives.
suite('start-windows.ps1 real worker process adapter', () => {
  test('a config path and an entry path with spaces each arrive as ONE argument', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch launcher spaces '));
    try {
      const probe = join(dir, 'probe entry.ts');
      const out = join(dir, 'argv out.json');
      await writeFile(
        probe,
        "import { writeFileSync } from 'fs'; writeFileSync(process.env.PROBE_OUT as string, JSON.stringify(process.argv.slice(2)));\n",
        'utf8'
      );
      const spacedConfig = join(dir, 'Jane Doe', 'config.local.json');
      const script = join(dir, 'adapter-scenario.ps1');
      const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
      await writeFile(
        script,
        `$ErrorActionPreference = 'Stop'
. ${q(LAUNCHER)}
$p = Start-WorkerProcess -ConfigPath ${q(spacedConfig)} -Executable ${q(process.execPath)} -Entry ${q(probe)}
$null = $p.WaitForExit(30000)
Write-Output ('EXIT=' + $p.ExitCode)
`,
        'utf8'
      );
      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PROBE_OUT: out } }
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      expect(stdout, stderr).toContain('EXIT=0');
      const received = JSON.parse(await readFile(out, 'utf8')) as string[];
      expect(received).toEqual(['--config', spacedConfig]);
    } finally {
      for (let attempt = 0; ; attempt++) {
        try {
          await rm(dir, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt >= 20) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
  });
});

// Overseer finding on df482267a: tunnel loss stopped only the worker PID, leaving the agents it
// spawned running. This runs the REAL Stop-OwnedProcess against a real process tree
// (powershell -> cmd -> ping) and requires every descendant to be gone afterwards.
suite('start-windows.ps1 real process tree stop', () => {
  test('Stop-OwnedProcess ends the whole tree of a real child process, not only the worker PID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-tree-'));
    try {
      const script = join(dir, 'tree-scenario.ps1');
      const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
      await writeFile(
        script,
        `$ErrorActionPreference = 'Stop'
. ${q(LAUNCHER)}
function Write-LauncherLog { param([string]$Message) Write-Output ('LOG=' + $Message) }
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', '"cmd /c ping -n 120 127.0.0.1 | Out-Null"') -WindowStyle Hidden -PassThru
$null = $p.Handle
$tree = @()
for ($i = 0; $i -lt 100; $i++) {
    $tree = @(Get-DescendantProcesses -RootId $p.Id)
    if ($tree.Count -ge 2) { break }
    Start-Sleep -Milliseconds 100
}
Write-Output ('TREE_BEFORE=' + $tree.Count)
Stop-OwnedProcess -Process $p
Start-Sleep -Milliseconds 500
$alive = @($tree | Where-Object { Test-DescendantAlive -Descendant $_ })
Write-Output ('PARENT_ALIVE=' + [bool](Get-Process -Id $p.Id -ErrorAction SilentlyContinue))
Write-Output ('DESCENDANTS_ALIVE=' + $alive.Count)
Write-Output ('SURVIVED_FLAG=' + $script:DescendantsSurvived)
`,
        'utf8'
      );
      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      const before = Number(/TREE_BEFORE=(\d+)/.exec(stdout)?.[1] ?? '0');
      expect(before, stdout + stderr).toBeGreaterThanOrEqual(2);
      expect(stdout, stderr).toContain('PARENT_ALIVE=False');
      expect(stdout, stderr).toContain('DESCENDANTS_ALIVE=0');
      expect(stdout, stderr).toContain('SURVIVED_FLAG=0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a descendant that will not die is counted and logged, never ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-survivor-'));
    try {
      const script = join(dir, 'survivor-scenario.ps1');
      const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
      await writeFile(
        script,
        `$ErrorActionPreference = 'Stop'
. ${q(LAUNCHER)}
function Write-LauncherLog { param([string]$Message) Write-Output ('LOG=' + $Message) }
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', '"cmd /c ping -n 120 127.0.0.1 | Out-Null"') -WindowStyle Hidden -PassThru
$null = $p.Handle
for ($i = 0; $i -lt 100; $i++) {
    if (@(Get-DescendantProcesses -RootId $p.Id).Count -ge 1) { break }
    Start-Sleep -Milliseconds 100
}
# every descendant reports alive no matter what, as a process that resists the kill would
function Test-DescendantAlive { param($Descendant) return $true }
Stop-OwnedProcess -Process $p
Write-Output ('SURVIVED_FLAG=' + $script:DescendantsSurvived)
`,
        'utf8'
      );
      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      const flag = Number(/SURVIVED_FLAG=(\d+)/.exec(stdout)?.[1] ?? '0');
      expect(flag, stdout + stderr).toBeGreaterThanOrEqual(1);
      expect(stdout).toContain('survived the tree stop');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});

// Overseer findings on 6db5fc81f: cleanup returned immediately when the worker had already exited
// (leaving orphaned agents), and it failed open (root never verified, errors swallowed).
suite('start-windows.ps1 tree stop fails closed', () => {
  const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  async function runPs(body: string): Promise<{ out: string; err: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-fc-'));
    try {
      const script = join(dir, 'scenario.ps1');
      await writeFile(
        script,
        `$ErrorActionPreference = 'Stop'
. ${q(LAUNCHER)}
function Write-LauncherLog { param([string]$Message) Write-Output ('LOG=' + $Message) }
${body}
`,
        'utf8'
      );
      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      return { out, err };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('an agent orphaned by an already-exited worker is still stopped, using the descendants tracked while it ran', async () => {
    const { out, err } = await runPs(`
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', '"Start-Process -FilePath cmd.exe -ArgumentList ''/c ping -n 120 127.0.0.1'' -WindowStyle Hidden; Start-Sleep 5"') -WindowStyle Hidden -PassThru
$null = $p.Handle
$tracked = @{}
for ($i = 0; $i -lt 100; $i++) {
    Update-TrackedDescendants -Process $p -Tracked $tracked
    if ($tracked.Count -ge 2) { break }
    Start-Sleep -Milliseconds 100
}
Write-Output ('TRACKED=' + $tracked.Count)
$null = $p.WaitForExit(30000)
Write-Output ('PARENT_EXITED=' + $p.HasExited)
$orphans = @($tracked.Values | Where-Object { Test-DescendantAlive -Descendant $_ })
Write-Output ('ORPHANS_BEFORE=' + $orphans.Count)
Stop-OwnedProcess -Process $p -Tracked $tracked
$after = @($tracked.Values | Where-Object { Test-DescendantAlive -Descendant $_ })
Write-Output ('ORPHANS_AFTER=' + $after.Count)
Write-Output ('SURVIVED_FLAG=' + $script:DescendantsSurvived)
`);
    const num = (key: string): number => Number(new RegExp(`${key}=(\\d+)`).exec(out)?.[1] ?? '-1');
    expect(num('TRACKED'), out + err).toBeGreaterThanOrEqual(1);
    expect(out, err).toContain('PARENT_EXITED=True');
    expect(num('ORPHANS_BEFORE'), out + err).toBeGreaterThanOrEqual(1);
    expect(num('ORPHANS_AFTER'), out + err).toBe(0);
    expect(num('SURVIVED_FLAG'), out + err).toBe(0);
  }, 90000);

  test('a kill that does not stop the root is a survivor: the root is verified, not assumed stopped', async () => {
    const { out, err } = await runPs(`
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 120') -WindowStyle Hidden -PassThru
$null = $p.Handle
function Invoke-TaskKillTree { param([int]$Id) }   # the kill silently does nothing
Stop-OwnedProcess -Process $p
Write-Output ('SURVIVED_FLAG=' + $script:DescendantsSurvived)
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
`);
    const flag = Number(/SURVIVED_FLAG=(\d+)/.exec(out)?.[1] ?? '0');
    expect(flag, out + err).toBeGreaterThanOrEqual(1);
    expect(out).toContain('survived the tree stop');
  }, 90000);

  test('a cleanup that throws is treated as blocking, never as stopped', async () => {
    const { out, err } = await runPs(`
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep 60') -WindowStyle Hidden -PassThru
$null = $p.Handle
function Stop-ProcessTreeVerified { throw 'cleanup exploded' }
Stop-OwnedProcess -Process $p
Write-Output ('SURVIVED_FLAG=' + $script:DescendantsSurvived)
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
`);
    expect(out, err).toContain('SURVIVED_FLAG=1');
    expect(out).toContain('cannot be verified; treated as blocking');
  }, 90000);
});

// Overseer finding on 6d4733fc5: a worker can spawn a long-running agent and exit BEFORE any
// supervision poll records it. Ownership must not depend on polling or on the worker staying
// alive, so the worker runs inside a kill-on-close Windows Job Object assigned before its first
// instruction. This runs the REAL Start-WorkerProcess and Stop-OwnedProcess with no tracking at all.
suite('start-windows.ps1 job object ownership', () => {
  test('an agent spawned by a worker that exits immediately, before any poll, is still stopped and verified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-job-'));
    try {
      const probe = join(dir, 'spawn-agent-and-exit.ts');
      // `start /b` leaves the ping running after cmd and the worker are gone: a real orphan.
      await writeFile(
        probe,
        [
          "const c = Bun.spawn(['cmd', '/c', 'start', '/b', 'ping', '-n', '120', '127.0.0.1'], { stdio: ['ignore', 'ignore', 'ignore'] });",
          'await c.exited;',
          'process.exit(0);',
          '',
        ].join('\n'),
        'utf8'
      );
      const script = join(dir, 'job-scenario.ps1');
      const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
      await writeFile(
        script,
        `$ErrorActionPreference = 'Stop'
. ${q(LAUNCHER)}
function Write-LauncherLog { param([string]$Message) Write-Output ('LOG=' + $Message) }
$p = Start-WorkerProcess -ConfigPath ${q(join(dir, 'config.local.json'))} -Executable ${q(process.execPath)} -Entry ${q(probe)}
$null = $p.WaitForExit(30000)
Write-Output ('WORKER_EXITED=' + $p.HasExited)
Start-Sleep -Milliseconds 500
Write-Output ('JOB_ACTIVE_BEFORE=' + $p.DispatchJob.ActiveProcesses())
Stop-OwnedProcess -Process $p
Write-Output ('JOB_ACTIVE_AFTER=' + $p.DispatchJob.ActiveProcesses())
Write-Output ('SURVIVED_FLAG=' + $script:DescendantsSurvived)
`,
        'utf8'
      );
      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      expect(out, err).toContain('WORKER_EXITED=True');
      // the orphaned agent is alive INSIDE THE JOB after the worker exited, and gone after the stop
      expect(
        Number(/JOB_ACTIVE_BEFORE=(\d+)/.exec(out)?.[1] ?? '0'),
        out + err
      ).toBeGreaterThanOrEqual(1);
      expect(out, err).toContain('JOB_ACTIVE_AFTER=0');
      expect(out, err).toContain('SURVIVED_FLAG=0');
    } finally {
      for (let attempt = 0; ; attempt++) {
        try {
          await rm(dir, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt >= 20) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
  }, 90000);
});

// 2026-11-10: the first real run of the job-object launcher failed at S4 of the #3418 swap. Under Windows
// PowerShell 5.1 (the Task Scheduler shell) Get-Command bun returns the npm shim bun.ps1, and CreateProcess
// cannot start a .ps1 (error 193). The earlier tests always passed bun.exe explicitly, so PATH resolution was
// never exercised. These run the REAL Start-WorkerProcess / Resolve-BunLauncher through powershell.exe.
suite('start-windows.ps1 bun resolution (the S4 failure)', () => {
  const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  async function runPs(
    body: string,
    env: Record<string, string> = {}
  ): Promise<{ out: string; err: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-bun-'));
    try {
      const script = join(dir, 'scenario.ps1');
      await writeFile(
        script,
        `$ErrorActionPreference = 'Stop'
. ${q(LAUNCHER)}
${body}
`,
        'utf8'
      );
      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } }
      );
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      return { out, err };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('Start-WorkerProcess with NO -Executable starts the worker through PATH resolution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch launcher path '));
    try {
      const probe = join(dir, 'probe entry.ts');
      const outFile = join(dir, 'argv out.json');
      await writeFile(
        probe,
        "import { writeFileSync } from 'fs'; writeFileSync(process.env.PROBE_OUT as string, JSON.stringify(process.argv.slice(2)));\n",
        'utf8'
      );
      const config = join(dir, 'config.local.json');
      const { out, err } = await runPs(
        `$p = Start-WorkerProcess -ConfigPath ${q(config)} -Entry ${q(probe)}
$null = $p.WaitForExit(30000)
Write-Output ('EXIT=' + $p.ExitCode)`,
        { PROBE_OUT: outFile }
      );
      expect(out, err).toContain('EXIT=0');
      expect(JSON.parse(await readFile(outFile, 'utf8'))).toEqual(['--config', config]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90000);

  test('Resolve-BunLauncher never returns a .ps1 shim: a sibling bun.exe wins, a lone .cmd is run through cmd.exe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-resolve-'));
    try {
      const withExe = join(dir, 'with-exe');
      const cmdOnly = join(dir, 'cmd-only');
      const ps1Only = join(dir, 'ps1-only');
      for (const d of [withExe, cmdOnly, ps1Only]) await mkdir(d, { recursive: true });
      await mkdir(join(withExe, 'node_modules', 'bun', 'bin'), { recursive: true });
      await copyFile(process.execPath, join(withExe, 'node_modules', 'bun', 'bin', 'bun.exe'));
      for (const d of [withExe, cmdOnly, ps1Only])
        await writeFile(join(d, 'bun.ps1'), 'exit 0\n', 'utf8');
      for (const d of [withExe, cmdOnly])
        await writeFile(join(d, 'bun.cmd'), '@echo off\r\n', 'utf8');
      const { out, err } = await runPs(`
foreach ($d in @(${q(withExe)}, ${q(cmdOnly)}, ${q(ps1Only)})) {
    $env:PATH = $d + ';' + $env:SystemRoot + '\System32'
    try {
        $r = Resolve-BunLauncher
        Write-Output ((Split-Path $d -Leaf) + '=' + $r.Path + '|viacmd=' + $r.ViaCmd)
    } catch { Write-Output ((Split-Path $d -Leaf) + '=THROWS ' + $_.Exception.Message) }
}`);
      const line = (name: string): string =>
        out.split(/\r?\n/).find(l => l.startsWith(`${name}=`)) ?? '';
      expect(line('with-exe'), out + err).toContain(join('node_modules', 'bun', 'bin', 'bun.exe'));
      expect(line('with-exe')).toContain('viacmd=False');
      expect(line('cmd-only'), out + err).toContain('bun.cmd');
      expect(line('cmd-only')).toContain('viacmd=True');
      expect(line('ps1-only'), out + err).toContain('THROWS');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90000);
});

// The precheck script every launcher swap runs BEFORE touching the task (README "Swapping the worker launcher").
suite('preflight-launcher.ps1 dry start under Windows PowerShell', () => {
  const PRECHECK = join(import.meta.dir, 'preflight-launcher.ps1');
  async function runPrecheck(extra: string[] = []): Promise<{ out: string; code: number }> {
    const proc = Bun.spawn(
      [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PRECHECK,
        ...extra,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return { out, code: proc.exitCode ?? -1 };
  }

  test('the current launcher passes the dry start', async () => {
    const r = await runPrecheck();
    expect(r.out).toContain('LAUNCHER_DRY_START_OK');
    expect(r.code).toBe(0);
  }, 90000);

  test('a launcher that cannot start its worker fails the dry start loudly and exits 1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-preflight-bad-'));
    try {
      const bad = join(dir, 'start-windows.ps1');
      await writeFile(
        bad,
        "function Start-WorkerProcess { param([string]$ConfigPath, [string]$Executable = '', [string]$Entry = '') throw 'could not start the worker inside a job object: CreateProcess failed: 193' }\n",
        'utf8'
      );
      const r = await runPrecheck(['-Launcher', bad]);
      expect(r.out).toContain('LAUNCHER_DRY_START_FAIL');
      expect(r.out).toContain('CreateProcess failed: 193');
      expect(r.code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90000);
});

suite('start-windows.ps1 tunnel ownership (the orphaned-tunnel outage, 2026-11-10)', () => {
  const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  async function runHost(body: string): Promise<{ out: string; err: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-tunnel-'));
    const script = join(dir, 'scenario.ps1');
    await writeFile(
      script,
      `$ErrorActionPreference = 'Stop'
. ${q(LAUNCHER)}
${body}
`,
      'utf8'
    );
    const proc = Bun.spawn(
      [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { out, err, dir };
  }

  test.each([
    ['absent', '@()', 'absent', false],
    [
      'owned',
      "[pscustomobject]@{ LocalAddress='127.0.0.1'; LocalPort=3900; State='Listen'; OwningProcess=1001 }",
      'owned',
      false,
    ],
    [
      'foreign PID',
      "[pscustomobject]@{ LocalAddress='127.0.0.1'; LocalPort=3900; State='Listen'; OwningProcess=4242 }",
      'foreign',
      false,
    ],
    [
      'wildcard bind',
      "[pscustomobject]@{ LocalAddress='0.0.0.0'; LocalPort=3900; State='Listen'; OwningProcess=1001 }",
      'foreign',
      false,
    ],
    [
      'reused exited PID',
      "[pscustomobject]@{ LocalAddress='127.0.0.1'; LocalPort=3900; State='Listen'; OwningProcess=1001 }",
      'foreign',
      true,
    ],
    [
      'permission denied',
      "Write-Error -Message 'synthetic_denied' -Category PermissionDenied",
      'unknown',
      false,
    ],
    [
      'enumeration failed',
      "Write-Error -Message 'synthetic_missing' -Category ObjectNotFound",
      'unknown',
      false,
    ],
  ] as const)('listener identity adapter: %s', async (_name, enumeration, expected, exited) => {
    const { out, err, dir } = await runHost(`
function Get-NetTCPConnection { [CmdletBinding()] param() ${enumeration} }
$p = [pscustomobject]@{ Id=1001; HasExited=$${exited ? 'true' : 'false'} }
Write-Output ('LISTENER=' + (Get-OwnedTunnelListenerState -Tunnel $p -Port 3900))
`);
    try {
      expect(err).toBe('');
      expect(out.trim()).toBe(`LISTENER=${expected}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('Start-TunnelProcess hands the launcher-owned ssh to the job object with the forward, keepalive and host intact', async () => {
    const { out, err, dir } = await runHost(`
function Start-JobOwnedProcess { param([string]$CommandLine, [string]$WorkingDirectory, [string]$Label = 'process') [Console]::Out.WriteLine('CAPTURED=' + $CommandLine); return [pscustomobject]@{ Id = 1 } }
$null = Start-TunnelProcess -SshHost 'hetzner-prod' -LocalPort 3900 -Executable 'C:/Windows/System32/OpenSSH/ssh.exe'
`);
    try {
      expect(err).toBe('');
      const line = out.split(/\r?\n/).find(l => l.startsWith('CAPTURED=')) ?? '';
      expect(line).toContain('ssh.exe');
      expect(line).toContain('"-N"');
      expect(line).toContain('ExitOnForwardFailure=yes');
      expect(line).toContain('ServerAliveInterval=30');
      expect(line).toContain('"-L" "127.0.0.1:3900:127.0.0.1:3090"');
      expect(line.trim().endsWith('"hetzner-prod"')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a launcher killed abruptly (what Task Scheduler stop does) takes its job-owned child with it: no orphan holds the port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-tunnel-kill-'));
    try {
      const script = join(dir, 'host.ps1');
      await writeFile(
        script,
        `$ErrorActionPreference = 'Stop'
. ${q(LAUNCHER)}
$p = Start-JobOwnedProcess -CommandLine 'ping -n 300 127.0.0.1' -WorkingDirectory ${q(dir)}
Write-Output ('CHILD=' + $p.Id)
[Console]::Out.Flush()
Start-Sleep -Seconds 300
`,
        'utf8'
      );
      const host = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      const reader = host.stdout.getReader();
      let seen = '';
      const decoder = new TextDecoder();
      const t0 = Date.now();
      let childPid = 0;
      while (Date.now() - t0 < 60000 && childPid === 0) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value);
        const m = /CHILD=(\d+)/.exec(seen);
        if (m) childPid = Number(m[1]);
      }
      expect(childPid, `host output: ${seen}`).toBeGreaterThan(0);
      const alive = (pid: number): boolean => {
        const r = Bun.spawnSync(['tasklist', '/FI', `PID eq ${pid}`, '/NH']);
        return new TextDecoder().decode(r.stdout).includes(String(pid));
      };
      expect(alive(childPid)).toBe(true);
      host.kill(); // TerminateProcess on the launcher: no finally block, no cleanup code runs
      await host.exited;
      let gone = false;
      for (let i = 0; i < 40 && !gone; i++) {
        gone = !alive(childPid);
        if (!gone) await new Promise(r => setTimeout(r, 250));
      }
      expect(gone, 'the job-owned child must die with the launcher').toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the launcher no longer starts the tunnel with Start-Process (which left it outside any job)', async () => {
    const source = await readFile(LAUNCHER, 'utf8');
    const tunnel = /function Start-TunnelProcess \{[^]*?\r?\n\}\r?\n/.exec(source)?.[0] ?? '';
    expect(tunnel.length).toBeGreaterThan(0);
    expect(tunnel).toContain('Start-JobOwnedProcess');
    expect(tunnel).not.toMatch(/Start-Process\s+-FilePath/);
  });
});

suite('start-windows.ps1 launcher event log (the unexplained 2026-11-10 stop)', () => {
  const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  async function runHost(
    body: string,
    env: Record<string, string>
  ): Promise<{ out: string; err: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-log-'));
    try {
      const script = join(dir, 'scenario.ps1');
      await writeFile(
        script,
        `$ErrorActionPreference = 'Stop'
. ${q(LAUNCHER)}
${body}
`,
        'utf8'
      );
      const proc = Bun.spawn(
        [
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
        ],
        { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } }
      );
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      return { out, err };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('Write-LauncherLog appends a timestamped, pid-tagged line to the launcher log file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-logfile-'));
    try {
      const log = join(dir, 'sub', 'dispatch-launcher.log');
      const { err } = await runHost(
        `Write-LauncherLog 'attempt 1 of 5 failed: ssh tunnel exited (exit code -1)'`,
        {
          BDC_DISPATCH_LAUNCHER_LOG: log,
        }
      );
      expect(err).toBe('');
      const text = await readFile(log, 'utf8');
      expect(text).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[pid \d+\] dispatch_launcher: attempt 1 of 5 failed: ssh tunnel exited \(exit code -1\)/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the log is capped: past the limit it rotates to .1 and the live file stays small', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-logcap-'));
    try {
      const log = join(dir, 'dispatch-launcher.log');
      const { err } = await runHost(
        `$script:LauncherLogMaxBytes = 300
1..30 | ForEach-Object { Write-LauncherLog ('line number ' + $_ + ' padding padding padding') }`,
        { BDC_DISPATCH_LAUNCHER_LOG: log }
      );
      expect(err).toBe('');
      const live = await readFile(log, 'utf8');
      const rotated = await readFile(log + '.1', 'utf8');
      expect(live.length).toBeLessThan(700);
      expect(rotated.length).toBeGreaterThan(0);
      expect(live + rotated).toContain('line number 30');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an unwritable log path never stops the launcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dispatch-launcher-lognowrite-'));
    try {
      const blocker = join(dir, 'a-file');
      await writeFile(blocker, 'x', 'utf8');
      const { out, err } = await runHost(
        `Write-LauncherLog 'still running'
Write-Output 'SURVIVED'`,
        {
          BDC_DISPATCH_LAUNCHER_LOG: join(blocker, 'not-a-dir', 'dispatch-launcher.log'),
        }
      );
      expect(err).toBe('');
      expect(out).toContain('SURVIVED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('Get-OwnedProcessSummary reports the raw exit code of an exited process and pid of a running one', async () => {
    const { out, err } = await runHost(
      `$e = [pscustomobject]@{ Id = 4242; HasExited = $true; ExitCode = -1 }
$r = [pscustomobject]@{ Id = 77; HasExited = $false; ExitCode = $null }
Write-Output (Get-OwnedProcessSummary -Name 'tunnel' -Process $e)
Write-Output (Get-OwnedProcessSummary -Name 'worker' -Process $r)
Write-Output (Get-OwnedProcessSummary -Name 'worker' -Process $null)`,
      {}
    );
    expect(err).toBe('');
    const lines = out.split(/\r?\n/).filter(Boolean);
    expect(lines).toEqual([
      'tunnel pid=4242 exited code=-1',
      'worker pid=77 running',
      'worker not started',
    ]);
  });
});
