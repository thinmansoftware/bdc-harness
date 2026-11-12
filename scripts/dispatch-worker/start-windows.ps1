[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.local.json'),
    [string]$SshHost = 'hetzner-prod',
    [int]$LocalPort = 3900,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

# Exit code the worker uses when a GENUINE live instance already holds the lock
# (see EXIT_ALREADY_RUNNING in scripts/dispatch-worker/index.ts). It means "do not retry".
$script:WorkerAlreadyRunningExit = 75

# Descendant processes of a stopped worker that were still alive after the tree kill. Non-zero
# means an agent from the previous worker may still be executing work, so the supervisor must
# not start a replacement (it could reclaim the expired lease while the old agent keeps going).
$script:DescendantsSurvived = 0

# ---------------------------------------------------------------------------
# Adapters. Each one is a small function so a test can redefine it after
# dot-sourcing this file (start-windows.test.ts runs the real supervisor with
# stub processes, a fake clock and no real sleep).
# ---------------------------------------------------------------------------

# The launcher's own file log. Task Scheduler runs the launcher with no console anyone reads, so
# Write-Host alone left no record of why a pair stopped (2026-11-10: the worker died at ~12:00Z and
# nothing explained it). Best effort: a log failure never stops the launcher. Capped: the file is
# rotated to .1 (the older .1 is replaced) once it passes $script:LauncherLogMaxBytes. Messages carry
# pids, exit codes, ports and reasons only: never config, token or prompt text.
$script:LauncherLogMaxBytes = 1048576
function Get-LauncherLogPath {
    if ($env:BDC_DISPATCH_LAUNCHER_LOG) { return $env:BDC_DISPATCH_LAUNCHER_LOG }
    return (Join-Path $env:USERPROFILE '.config\bdc\logs\dispatch-launcher.log')
}

function Write-LauncherLogFile {
    param([string]$Line)
    try {
        $path = Get-LauncherLogPath
        $dir = Split-Path -Parent $path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path).Length -gt $script:LauncherLogMaxBytes)) {
            Move-Item -LiteralPath $path -Destination ($path + '.1') -Force
        }
        Add-Content -LiteralPath $path -Value $Line -Encoding ASCII
    }
    catch { }
}

function Write-LauncherLog {
    param([string]$Message)
    # Write-Host, not Write-Output: callers return values and must not be polluted.
    $line = ("dispatch_launcher: " + $Message)
    Write-Host $line
    Write-LauncherLogFile -Line ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') + ' [pid ' + $PID + '] ' + $line)
}

# "<name> pid=N running" or "<name> pid=N exited code=C": the raw exit reason of a process the
# launcher owns, read from the handle it kept.
function Get-OwnedProcessSummary {
    param([string]$Name, $Process)
    if ($null -eq $Process) { return ($Name + ' not started') }
    try {
        if ($Process.HasExited) { return ($Name + ' pid=' + $Process.Id + ' exited code=' + $Process.ExitCode) }
        return ($Name + ' pid=' + $Process.Id + ' running')
    }
    catch { return ($Name + ' pid=' + $Process.Id + ' state unreadable') }
}

function Invoke-LauncherSleep {
    param([int]$Seconds)
    Start-Sleep -Seconds $Seconds
}

function Get-LauncherNow {
    return [DateTime]::UtcNow
}

function Test-LocalPortOpen {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(1000)) { return $false }
        $client.EndConnect($pending)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Start-TunnelProcess {
    param([string]$SshHost, [int]$LocalPort, [string]$Executable = '')
    $forward = "127.0.0.1:${LocalPort}:127.0.0.1:3090"
    if ($Executable) { $ssh = $Executable }
    else { $ssh = (Get-Command ssh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    $arguments = @('-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-L', $forward, $SshHost)
    $commandLine = (Format-ProcessArgument -Value $ssh) + ' ' + (($arguments | ForEach-Object { Format-ProcessArgument -Value $_ }) -join ' ')
    # The tunnel is launcher-owned, so it lives in its own kill-on-close job object, exactly like the
    # worker. A Start-Process tunnel was NOT in a job: when Task Scheduler stopped the task (or the
    # launcher died any other way) the ssh process survived, kept the local port, and every restart
    # failed with "port is held by a process this launcher did not start" (2026-11-10, #3418).
    return Start-JobOwnedProcess -CommandLine $commandLine -WorkingDirectory ((Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)
}

$script:DispatchJobSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public sealed class BdcDispatchJob
{
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int len, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int which);

    const uint CREATE_SUSPENDED = 0x00000004;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int STARTF_USESTDHANDLES = 0x00000100;

    IntPtr job;
    public int ProcessId;

    public static BdcDispatchJob Start(string commandLine, string workingDirectory)
    {
        IntPtr hJob = CreateJobObjectW(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(hJob, 9, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
        {
            int err = Marshal.GetLastWin32Error();
            CloseHandle(hJob);
            throw new InvalidOperationException("SetInformationJobObject failed: " + err);
        }
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION pi;
        // Suspended, assigned to the job, THEN resumed: the process cannot spawn a child that
        // escapes the job, because it has not run a single instruction before the assignment.
        if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED, IntPtr.Zero, workingDirectory, ref si, out pi))
        {
            int err = Marshal.GetLastWin32Error();
            CloseHandle(hJob);
            throw new InvalidOperationException("CreateProcess failed: " + err);
        }
        if (!AssignProcessToJobObject(hJob, pi.hProcess))
        {
            int err = Marshal.GetLastWin32Error();
            TerminateProcess(pi.hProcess, 1);
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            CloseHandle(hJob);
            throw new InvalidOperationException("AssignProcessToJobObject failed: " + err);
        }
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        BdcDispatchJob result = new BdcDispatchJob();
        result.job = hJob;
        result.ProcessId = pi.dwProcessId;
        return result;
    }

    // Live processes in the job, including every descendant that ever started inside it.
    public int ActiveProcesses()
    {
        if (job == IntPtr.Zero) return 0;
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero))
            throw new InvalidOperationException("QueryInformationJobObject failed: " + Marshal.GetLastWin32Error());
        return (int)info.ActiveProcesses;
    }

    public bool Terminate()
    {
        return job != IntPtr.Zero && TerminateJobObject(job, 1);
    }

    // Closing the handle kills anything still in the job (KILL_ON_JOB_CLOSE).
    public void Close()
    {
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    }
}
'@

# Compiled on first use so dot-sourcing this file stays cheap.
function Initialize-DispatchJobType {
    if (-not ('BdcDispatchJob' -as [type])) {
        Add-Type -TypeDefinition $script:DispatchJobSource -Language CSharp
    }
}

# Start-Process joins ArgumentList elements into ONE command line without preserving argument
# boundaries (Windows PowerShell 5.1), so a path with a space (C:\Users\Jane Doe\...) would be
# split and the worker would get a truncated --config. Every path argument is quoted here.
# -Executable and -Entry exist so a test can run the REAL process adapter against a probe.
function Format-ProcessArgument {
    param([string]$Value)
    return '"' + $Value + '"'
}

# CreateProcess can start an .exe (and a .cmd/.bat through cmd.exe) but NOT a .ps1. Under Windows
# PowerShell 5.1, the Task Scheduler shell, Get-Command bun returns the npm shim bun.ps1 (an
# ExternalScript), which made the first real run of the job-object launcher fail with CreateProcess
# error 193 (2026-11-10, #3418 S4). So resolve an APPLICATION, prefer a real bun.exe (the one next to the
# shim in node_modules\bun\bin), fall back to a .cmd run through cmd.exe, and refuse anything else loudly.
function Resolve-BunLauncher {
    param([string]$Executable = '')
    if ($Executable) { $path = $Executable }
    else { $path = (Get-Command bun -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
    if ($ext -eq '.exe') { return @{ Path = $path; ViaCmd = $false } }
    $sibling = Join-Path (Split-Path -Parent $path) 'node_modules\bun\bin\bun.exe'
    if (Test-Path -LiteralPath $sibling -PathType Leaf) { return @{ Path = $sibling; ViaCmd = $false } }
    if ($ext -eq '.cmd' -or $ext -eq '.bat') { return @{ Path = $path; ViaCmd = $true } }
    throw ("bun resolved to '" + $path + "', which cannot be started as a process (not .exe, .cmd or .bat)")
}

# Starts a process inside its own Windows Job Object (kill-on-close), created suspended and assigned
# BEFORE its first instruction runs, so every descendant it ever spawns is in the job and the whole
# set dies with the launcher. Used for the worker and for the ssh tunnel.
function Start-JobOwnedProcess {
    param([string]$CommandLine, [string]$WorkingDirectory, [string]$Label = 'process')
    try {
        Initialize-DispatchJobType
        $job = [BdcDispatchJob]::Start($CommandLine, $WorkingDirectory)
    }
    catch {
        # Fail loud and closed: without the job there is no guaranteed ownership of descendants.
        throw ("could not start the $Label inside a job object: " + $_.Exception.Message)
    }
    $process = Get-Process -Id $job.ProcessId -ErrorAction Stop
    $null = $process.Handle
    Add-Member -InputObject $process -MemberType NoteProperty -Name DispatchJob -Value $job -Force
    return $process
}

function Start-WorkerProcess {
    param(
        [string]$ConfigPath,
        [string]$Executable = '',
        [string]$Entry = 'scripts/dispatch-worker/index.ts'
    )
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $launcher = Resolve-BunLauncher -Executable $Executable
    # The worker runs inside a Windows Job Object (kill-on-close), created suspended and assigned
    # BEFORE its first instruction runs. Every descendant it ever spawns is in the job, whatever the
    # worker's own lifetime: ownership does not depend on polling or on the worker staying alive.
    $commandLine = (Format-ProcessArgument -Value $launcher.Path) + ' run ' + (Format-ProcessArgument -Value $Entry) +
        ' --config ' + (Format-ProcessArgument -Value $ConfigPath)
    # A .cmd shim must be run by cmd.exe (/d no AutoRun, /s keeps the outer quotes, /c run and exit).
    if ($launcher.ViaCmd) { $commandLine = 'cmd.exe /d /s /c "' + $commandLine + '"' }
    return Start-JobOwnedProcess -CommandLine $commandLine -WorkingDirectory $repoRoot -Label 'worker'
}

# Every descendant (child, grandchild, ...) of a process, from the live process table, with the
# creation time recorded so a reused PID is never mistaken for the original.
function Get-DescendantProcesses {
    param([int]$RootId)
    $table = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $found = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($RootId)
    $seen = @{}
    $seen[$RootId] = $true
    while ($queue.Count -gt 0) {
        $parent = [int]$queue.Dequeue()
        foreach ($row in $table) {
            if ([int]$row.ParentProcessId -ne $parent) { continue }
            $id = [int]$row.ProcessId
            if ($seen.ContainsKey($id)) { continue }
            $seen[$id] = $true
            [void]$found.Add([pscustomobject]@{ Id = $id; Created = [string]$row.CreationDate })
            $queue.Enqueue($id)
        }
    }
    return @($found)
}

function Test-DescendantAlive {
    param($Descendant)
    $row = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $Descendant.Id) -ErrorAction SilentlyContinue
    if ($null -eq $row) { return $false }
    return ([string]$row.CreationDate -eq $Descendant.Created)
}

# Taskkill wrapper, a separate function so a test can make the kill a no-op.
function Invoke-TaskKillTree {
    param([int]$Id)
    & taskkill.exe /PID $Id /T /F *> $null
}

function Test-RootAlive {
    param([int]$Id, $StartTime)
    $live = Get-Process -Id $Id -ErrorAction SilentlyContinue
    if ($null -eq $live) { return $false }
    if ($null -ne $StartTime -and $live.StartTime -ne $StartTime) { return $false }
    return $true
}

# Adds every current descendant of the worker to the tracked set (id -> descendant). Called on
# every supervision poll while the worker runs, so agents it spawned are still known after the
# worker exits (an exited parent has no live children to enumerate).
function Update-TrackedDescendants {
    param($Process, [hashtable]$Tracked)
    if ($null -eq $Process -or $null -eq $Tracked) { return }
    if ($Process.HasExited) { return }
    try {
        foreach ($d in @(Get-DescendantProcesses -RootId $Process.Id)) {
            $Tracked[[int]$d.Id] = $d
        }
    }
    catch { }
}

# Stop-Process ends only the one PID, and killing the worker also prevents its own cleanup of
# the agents it spawned. So the whole tree is taken down (taskkill /T /F), then the root AND every
# recorded descendant (live snapshot plus the tracked set) is verified gone. Returns the number
# of processes still alive after the wait; the root counts. A failed kill is not an excuse to pass.
function Stop-ProcessTreeVerified {
    param([int]$RootId, $RootStartTime = $null, [hashtable]$Tracked = $null, [int]$WaitSeconds = 10)
    $byId = @{}
    if (Test-RootAlive -Id $RootId -StartTime $RootStartTime) {
        foreach ($d in @(Get-DescendantProcesses -RootId $RootId)) { $byId[[int]$d.Id] = $d }
    }
    if ($null -ne $Tracked) {
        foreach ($k in @($Tracked.Keys)) { if (-not $byId.ContainsKey([int]$k)) { $byId[[int]$k] = $Tracked[$k] } }
    }
    $descendants = @($byId.Values)
    if (Test-RootAlive -Id $RootId -StartTime $RootStartTime) { Invoke-TaskKillTree -Id $RootId }
    foreach ($d in $descendants) {
        if (Test-DescendantAlive -Descendant $d) {
            Stop-Process -Id $d.Id -Force -ErrorAction SilentlyContinue
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    while ($true) {
        $alive = @($descendants | Where-Object { Test-DescendantAlive -Descendant $_ }).Count
        if (Test-RootAlive -Id $RootId -StartTime $RootStartTime) { $alive++ }
        if ($alive -eq 0 -or [DateTime]::UtcNow -ge $deadline) { return $alive }
        Start-Sleep -Milliseconds 200
    }
}

# Stops ONLY a process object this launcher started, and only if the live PID still has the
# start time recorded when it was started (a reused PID is left alone). The process and
# everything it spawned (live children and the descendants tracked while it ran, even if it has
# already exited) are stopped and verified. Fail closed: survivors, a failed kill or any
# cleanup error all raise the restart-blocking flag; nothing is ever treated as stopped on faith.
function Stop-OwnedProcess {
    param($Process, [hashtable]$Tracked = $null)
    if ($null -eq $Process) { return }
    try {
        $jobProp = $Process.PSObject.Properties['DispatchJob']
        if ($null -ne $jobProp -and $null -ne $jobProp.Value) {
            $job = $jobProp.Value
            $null = $job.Terminate()
            $deadline = [DateTime]::UtcNow.AddSeconds(10)
            while ($true) {
                $active = [int]$job.ActiveProcesses()
                if ($active -eq 0 -or [DateTime]::UtcNow -ge $deadline) { break }
                Start-Sleep -Milliseconds 200
            }
            if ($active -gt 0) {
                $script:DescendantsSurvived += $active
                Write-LauncherLog ("$active process(es) in the job of owned process " + $Process.Id + " survived the job terminate")
            }
            else {
                $job.Close()
            }
            return
        }
        $rootStart = $null
        try { $rootStart = $Process.StartTime } catch { }
        $survivors = Stop-ProcessTreeVerified -RootId $Process.Id -RootStartTime $rootStart -Tracked $Tracked
        if ($survivors -gt 0) {
            $script:DescendantsSurvived += $survivors
            Write-LauncherLog ("$survivors process(es) of owned process " + $Process.Id + " (the process or its descendants) survived the tree stop")
        }
    }
    catch {
        $script:DescendantsSurvived += 1
        Write-LauncherLog ("cleanup of owned process " + $Process.Id + " failed and cannot be verified; treated as blocking")
    }
}

# ---------------------------------------------------------------------------
# One tunnel + worker pair, supervised until something ends it.
# Returns @{ Outcome = 'clean'|'holder'|'failed'; Reason = '...' }.
# Reasons carry exit codes and port numbers only: never config, token or prompt text.
# ---------------------------------------------------------------------------
function Invoke-DispatchPairOnce {
    param(
        [string]$ConfigPath,
        [string]$SshHost,
        [int]$LocalPort,
        [int]$ReadySeconds = 30,
        [int]$PollSeconds = 5
    )

    # A listener we did not start is never touched: fail loudly and let the bounded
    # retry (and the operator) deal with it.
    if (Test-LocalPortOpen -Port $LocalPort) {
        return @{ Outcome = 'failed'; Reason = "local port $LocalPort is held by a process this launcher did not start; it was not terminated" }
    }

    $tunnel = Start-TunnelProcess -SshHost $SshHost -LocalPort $LocalPort
    Write-LauncherLog (Get-OwnedProcessSummary -Name 'tunnel started:' -Process $tunnel)
    $worker = $null
    $trackedWorkerTree = @{}
    try {
        $ready = $false
        for ($waited = 0; $waited -lt $ReadySeconds; $waited++) {
            if ($tunnel.HasExited) {
                return @{ Outcome = 'failed'; Reason = "ssh tunnel exited before readiness (exit code $($tunnel.ExitCode))" }
            }
            if (Test-LocalPortOpen -Port $LocalPort) { $ready = $true; break }
            Invoke-LauncherSleep -Seconds 1
        }
        if (-not $ready) {
            return @{ Outcome = 'failed'; Reason = "ssh tunnel did not open local port $LocalPort within $ReadySeconds s" }
        }

        $worker = Start-WorkerProcess -ConfigPath $ConfigPath
        Write-LauncherLog (Get-OwnedProcessSummary -Name 'worker started:' -Process $worker)
        while ($true) {
            Invoke-LauncherSleep -Seconds $PollSeconds
            Update-TrackedDescendants -Process $worker -Tracked $trackedWorkerTree
            if ($worker.HasExited) {
                $code = $worker.ExitCode
                if ($code -eq 0) { return @{ Outcome = 'clean'; Reason = 'worker exited 0' } }
                if ($code -eq $script:WorkerAlreadyRunningExit) {
                    return @{ Outcome = 'holder'; Reason = 'a genuine live worker already holds the instance lock' }
                }
                return @{ Outcome = 'failed'; Reason = "worker exited with code $code" }
            }
            if ($tunnel.HasExited) {
                return @{ Outcome = 'failed'; Reason = "ssh tunnel exited while the worker ran (exit code $($tunnel.ExitCode))" }
            }
            if (-not (Test-LocalPortOpen -Port $LocalPort)) {
                return @{ Outcome = 'failed'; Reason = "tunnel listener on port $LocalPort was lost while the worker ran" }
            }
        }
    }
    finally {
        # Record the raw state of both BEFORE they are stopped, so the log shows which one ended the pair.
        Write-LauncherLog ('pair ending: ' + (Get-OwnedProcessSummary -Name 'worker' -Process $worker) + '; ' + (Get-OwnedProcessSummary -Name 'tunnel' -Process $tunnel))
        # Our own pair only: the worker first, then the tunnel.
        Stop-OwnedProcess -Process $worker -Tracked $trackedWorkerTree
        Stop-OwnedProcess -Process $tunnel
    }
}

# ---------------------------------------------------------------------------
# Supervisor: bounded retry with backoff. Exits 0 on a clean stop or a genuine
# existing holder; exits 1 when consecutive failures are exhausted so Task
# Scheduler's own restart policy takes over.
# ---------------------------------------------------------------------------
function Invoke-DispatchSupervisor {
    param(
        [string]$ConfigPath,
        [string]$SshHost,
        [int]$LocalPort,
        [int]$MaxAttempts = 5,
        [int[]]$BackoffSeconds = @(10, 30, 60, 120),
        [int]$StableSeconds = 600
    )

    $failures = 0
    while ($true) {
        $startedAt = Get-LauncherNow
        $result = Invoke-DispatchPairOnce -ConfigPath $ConfigPath -SshHost $SshHost -LocalPort $LocalPort
        if ($script:DescendantsSurvived -gt 0) {
            Write-LauncherLog ("refusing to restart: $($script:DescendantsSurvived) process(es) from the previous worker are still alive and may still be executing work; exiting non-zero for the scheduled task restart policy")
            return 1
        }
        if ($result.Outcome -eq 'clean') {
            Write-LauncherLog "worker stopped cleanly"
            return 0
        }
        if ($result.Outcome -eq 'holder') {
            Write-LauncherLog ("not retrying: " + $result.Reason)
            return 0
        }

        $ranSeconds = ((Get-LauncherNow) - $startedAt).TotalSeconds
        if ($ranSeconds -ge $StableSeconds) { $failures = 0 }
        $failures++
        Write-LauncherLog ("attempt $failures of $MaxAttempts failed: " + $result.Reason)
        if ($failures -ge $MaxAttempts) {
            Write-LauncherLog "retry budget exhausted; exiting non-zero for the scheduled task restart policy"
            return 1
        }
        $wait = $BackoffSeconds[[Math]::Min($failures - 1, $BackoffSeconds.Count - 1)]
        Write-LauncherLog ("retrying in $wait s (retry $failures)")
        Invoke-LauncherSleep -Seconds $wait
    }
}

# Dot-sourcing (the test harness) loads the functions above and stops here.
if ($MyInvocation.InvocationName -eq '.') { return }

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Dispatch worker config is missing: $ConfigPath"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$expectedServerUrl = "http://127.0.0.1:$LocalPort"
if ($config.server_url -ne $expectedServerUrl) {
    throw "config.server_url must be $expectedServerUrl for the managed SSH tunnel"
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'bun is not available on PATH'
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    throw 'ssh is not available on PATH'
}

if ($ValidateOnly) {
    Write-Output 'DISPATCH_WINDOWS_LAUNCHER_VALID'
    exit 0
}

Write-LauncherLog ('launcher starting, port ' + $LocalPort + ', host ' + $SshHost)
$launcherExit = 1
try {
    $launcherExit = Invoke-DispatchSupervisor -ConfigPath $ConfigPath -SshHost $SshHost -LocalPort $LocalPort
}
catch {
    Write-LauncherLog ('launcher crashed: ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message)
    throw
}
finally {
    Write-LauncherLog ('launcher exiting')
}
Write-LauncherLog ('launcher exit code ' + $launcherExit)
exit $launcherExit
