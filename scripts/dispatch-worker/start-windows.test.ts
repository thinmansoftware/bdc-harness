import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const launcher = join(import.meta.dir, 'start-windows.ps1').replaceAll("'", "''");
function powershell(body: string): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; . '${launcher}' -ConfigPath 'SYNTHETIC_NOT_READ.json'; ${body}`,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 }
  ).trim();
}

describe.skipIf(process.platform !== 'win32')('owned Windows Dispatch tunnel supervision', () => {
  test.each(['unknown', 'throw'])(
    'uncertain observation holds live worker and tunnel: %s',
    mode => {
      const result = JSON.parse(
        powershell(`
      $script:ticks=0; $script:stops=0; $script:firstWaitStops=-1;
      $script:w=[pscustomobject]@{HasExited=$false};
      $t=[pscustomobject]@{HasExited=$false};
      $script:events=New-Object 'System.Collections.Generic.List[string]';
      $probe={param($p) if('${mode}' -eq 'throw'){throw 'synthetic_observation_failure'}; 'unknown'};
      $stop={param($p) $script:stops++; $p.HasExited=$true; $true};
      $wait={ $script:ticks++; if($script:ticks -eq 1){$script:firstWaitStops=$script:stops}; if($script:ticks -ge 3){$script:w.HasExited=$true} };
      $report={param($s) [void]$script:events.Add($s)};
      $r=Invoke-DispatchTunnelSupervision $script:w $t {throw 'must_not_reconnect'} $stop $probe $wait $report 2;
      @{firstWaitStops=$script:firstWaitStops; stops=$script:stops; attempts=$r.ReconnectAttempts; events=@($script:events)} | ConvertTo-Json -Compress
    `)
      );
      expect(result.firstWaitStops).toBe(0);
      expect(result.stops).toBe(1); // Only after the same worker naturally exits.
      expect(result.attempts).toBe(0);
      expect(result.events).toEqual(['OBSERVATION_UNCERTAIN', 'WORKER_EXITED']);
    }
  );

  test.each(['PermissionDenied', 'ObjectNotFound'])(
    'actual listener adapter refuses enumeration failure: %s',
    category => {
      expect(
        powershell(`
      function Get-NetTCPConnection {
        [CmdletBinding()] param($LocalAddress,$LocalPort,$State)
        Write-Error -Message 'synthetic_observation_denied' -Category ${category}
      };
      if((Get-DispatchOwnedListenerState $null 3900) -ne 'unknown'){throw 'read_error_misclassified'};
      'OBSERVATION_ERROR_IS_UNKNOWN'
    `)
      ).toBe('OBSERVATION_ERROR_IS_UNKNOWN');
    }
  );

  test('actual listener adapter verifies absence only after successful empty enumeration', () => {
    expect(
      powershell(`
      function Get-NetTCPConnection { [CmdletBinding()] param() @() };
      if((Get-DispatchOwnedListenerState $null 3900) -ne 'absent'){throw 'expected_verified_absence'};
      'SUCCESSFUL_EMPTY_ENUMERATION'
    `)
    ).toBe('SUCCESSFUL_EMPTY_ENUMERATION');
  });

  test.each(['recover', 'exhaust', 'foreign', 'uncertain', 'worker-exit', 'flap'])(
    'actual supervisor with injected processes: %s',
    scenario => {
      const result = JSON.parse(
        powershell(`
      $script:mode='${scenario}'; $script:ticks=0; $script:starts=0; $script:stops=0;
      $script:worker=[pscustomobject]@{HasExited=$false};
      $initial=[pscustomobject]@{HasExited=$true; Probes=0};
      $script:events=New-Object 'System.Collections.Generic.List[string]';
      $start={ $script:starts++; [pscustomobject]@{HasExited=($script:mode -eq 'exhaust'); Probes=0} };
      $stop={ param($p) $script:stops++; if($script:mode -eq 'uncertain'){return $false}; $p.HasExited=$true; return $true };
      $probe={ param($p)
        if($null -eq $p){ if($script:mode -eq 'foreign'){return 'foreign'}; return 'absent' };
        $p.Probes++; if($script:mode -eq 'flap' -and $p.Probes -gt 1){return 'absent'};
        return 'owned'
      };
      $wait={ $script:ticks++; if(($script:mode -eq 'worker-exit' -and $script:ticks -ge 1) -or $script:ticks -ge 20){$script:worker.HasExited=$true} };
      $report={param($s) [void]$script:events.Add($s)};
      $out=Invoke-DispatchTunnelSupervision $script:worker $initial $start $stop $probe $wait $report 2;
      @{starts=$script:starts; stops=$script:stops; events=@($script:events); result=$out; workerExited=$script:worker.HasExited} | ConvertTo-Json -Depth 5 -Compress
    `)
      );
      expect(result.workerExited).toBe(true);
      expect(result.events).toContain('WORKER_EXITED');
      if (scenario === 'recover') {
        expect(result.starts).toBe(1);
        expect(result.events).toContain('TRANSPORT_RECOVERED');
      } else if (scenario === 'exhaust' || scenario === 'flap') {
        expect(result.starts).toBe(3);
        expect(result.events).toContain('DEGRADED_EXHAUSTED');
        expect(result.result.Held).toBe(true);
      } else if (scenario === 'foreign') {
        expect(result.starts).toBe(0);
        expect(result.events).toContain('FOREIGN_LISTENER_REFUSED');
      } else if (scenario === 'uncertain') {
        expect(result.starts).toBe(0);
        expect(result.stops).toBe(1);
        expect(result.result.CleanupUncertain).toBe(true);
      } else {
        expect(result.starts).toBe(0);
      }
    }
  );

  test.each(['ready', 'foreign', 'failed', 'worker-exited'])(
    'readiness returns bounded state: %s',
    state => {
      const result = JSON.parse(
        powershell(`
      $script:waits=0; $p=[pscustomobject]@{HasExited=$false};
      $w=[pscustomobject]@{HasExited=('${state}' -eq 'worker-exited')};
      $probe={param($t) if('${state}' -eq 'ready'){return 'owned'}; if('${state}' -eq 'foreign'){return 'foreign'}; return 'absent'};
      $wait={$script:waits++};
      $r=Wait-DispatchOwnedTunnel $p $w $probe $wait 2;
      @{state=$r; waits=$script:waits} | ConvertTo-Json -Compress
    `)
      );
      expect(result.state).toBe(state);
      expect(result.waits).toBe(state === 'failed' ? 2 : 0);
    }
  );

  test('captured exited identity never kills a potentially reused PID', () => {
    expect(
      powershell(`
      $p=[pscustomobject]@{HasExited=$true};
      $p | Add-Member ScriptMethod Kill {throw 'must_not_kill'};
      if(-not (Stop-DispatchOwnedTunnel $p)){throw 'expected_verified_exit'};
      'EXITED_IDENTITY_PRESERVED'
    `)
    ).toBe('EXITED_IDENTITY_PRESERVED');
  });

  test('uncertain owned termination is reported without alternate process access', () => {
    expect(
      powershell(`
      $p=[pscustomobject]@{HasExited=$false};
      $p | Add-Member ScriptMethod Kill {throw 'synthetic_handle_failure'};
      if(Stop-DispatchOwnedTunnel $p){throw 'unexpected_cleanup_success'};
      'UNCERTAIN_NO_RETRY'
    `)
    ).toBe('UNCERTAIN_NO_RETRY');
  });
});
