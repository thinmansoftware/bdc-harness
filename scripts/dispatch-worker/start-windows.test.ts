/**
 * WO-HARNESS-DISPATCH-WORKER-STALE-LOCK-01 Tests 4 and 5 (launcher), Windows PowerShell.
 *
 * Each scenario dot-sources the REAL start-windows.ps1 in a child powershell.exe, replaces its
 * adapter functions (processes, port probe, sleep, clock) with stubs, and runs the real
 * Invoke-DispatchSupervisor. Time is a fake clock, so nothing sleeps. On a non-Windows host the
 * suite is skipped and the launcher behavior must be verified operator-side.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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
function Update-TrackedDescendants { param($Process, $Tracked) }
function Stop-OwnedProcess {
    param($Process, $Tracked)
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
  $first = $script:tunnels[0]
  if ($first -and -not $first.HasExited -and ($script:clock - $first.StartedAt) -ge 60) {
    $first.HasExited = $true; $first.ExitCode = 255
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
