param(
  [string]$TaskName = "BDC Codex Auth Sync",
  [string]$SourceScriptPath = "$PSScriptRoot\sync-codex-auth.ps1",
  [int]$IntervalMinutes = 30
)

# Installs a validated, access-controlled copy before registering the task.
# All preparation failures stop before Register-ScheduledTask.

$ErrorActionPreference = "Stop"

function Get-SidValue {
  param([System.Security.Principal.IdentityReference]$Identity)
  return $Identity.Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Get-OwnerSidValue {
  param([string]$Owner)
  try {
    $account = New-Object System.Security.Principal.NTAccount($Owner)
    return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    return $Owner
  }
}

function Set-ProtectedOperatorAcl {
  param(
    [string]$Path,
    [bool]$IsDirectory
  )

  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $requiredSidValues = @(
    $currentSid.Value,
    "S-1-5-18",
    "S-1-5-32-544"
  ) | Select-Object -Unique
  $acl = Get-Acl -LiteralPath $Path
  if ((Get-OwnerSidValue -Owner $acl.Owner) -ne $currentSid.Value) {
    $acl.SetOwner($currentSid)
  }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    $acl.RemoveAccessRuleSpecific($rule)
  }

  $inheritance = if ($IsDirectory) {
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [System.Security.AccessControl.InheritanceFlags]::None
  }
  foreach ($sidValue in $requiredSidValues) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  try {
    Set-Acl -LiteralPath $Path -AclObject $acl
  } catch {
    throw "ACL enforcement failed file=$([IO.Path]::GetFileName($Path)) directory=$IsDirectory"
  }
}

function Assert-ProtectedOperatorAcl {
  param([string]$Path)

  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $requiredSidValues = @(
    $currentSid.Value,
    "S-1-5-18",
    "S-1-5-32-544"
  ) | Select-Object -Unique
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) {
    throw "installed ACL still inherits permissions"
  }
  if ((Get-OwnerSidValue -Owner $acl.Owner) -ne $currentSid.Value) {
    throw "installed ACL owner verification failed"
  }

  $verified = @{}
  foreach ($rule in @($acl.Access)) {
    $sidValue = Get-SidValue -Identity $rule.IdentityReference
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      throw "installed ACL contains a deny rule"
    }
    if ($requiredSidValues -notcontains $sidValue) {
      throw "installed ACL contains an unexpected principal"
    }
    if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne `
      [System.Security.AccessControl.FileSystemRights]::FullControl) {
      throw "installed ACL does not grant required control"
    }
    $verified[$sidValue] = $true
  }
  foreach ($sidValue in $requiredSidValues) {
    if (-not $verified.ContainsKey($sidValue)) {
      throw "installed ACL is missing a required principal"
    }
  }
}

function Assert-ValidPowerShellSource {
  param([string]$Path)

  $tokens = $null
  $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $Path).Path,
    [ref]$tokens,
    [ref]$parseErrors
  ) | Out-Null
  if ($parseErrors.Count -ne 0) {
    throw "sync script PowerShell validation failed"
  }
}

if ($IntervalMinutes -lt 15 -or $IntervalMinutes -gt 60) {
  throw "IntervalMinutes must be between 15 and 60."
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "LOCALAPPDATA is required."
}
if (-not (Test-Path -LiteralPath $SourceScriptPath -PathType Leaf)) {
  throw "sync-codex-auth.ps1 source is missing."
}

Assert-ValidPowerShellSource -Path $SourceScriptPath
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $SourceScriptPath).Hash
$InstallDirectory = Join-Path $env:LOCALAPPDATA "BlueDevil\codex-auth-sync"
$InstalledScriptPath = Join-Path $InstallDirectory "sync-codex-auth.ps1"
$tempPath = Join-Path $InstallDirectory "sync-codex-auth.ps1.tmp.$([guid]::NewGuid().ToString('N'))"
$replaceBackupPath = Join-Path $InstallDirectory "sync-codex-auth.ps1.replace-backup.$([guid]::NewGuid().ToString('N'))"
$failedCandidatePath = Join-Path $InstallDirectory "sync-codex-auth.ps1.failed.$([guid]::NewGuid().ToString('N'))"
$destinationExisted = Test-Path -LiteralPath $InstalledScriptPath -PathType Leaf
$destinationHash = if ($destinationExisted) {
  (Get-FileHash -Algorithm SHA256 -LiteralPath $InstalledScriptPath).Hash
} else {
  $null
}
$replacementCompleted = $false

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
Set-ProtectedOperatorAcl -Path $InstallDirectory -IsDirectory $true
Assert-ProtectedOperatorAcl -Path $InstallDirectory

try {
  [IO.File]::Copy($SourceScriptPath, $tempPath, $false)
  $tempHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $tempPath).Hash
  if ($tempHash -ne $sourceHash) {
    throw "temporary copy hash verification failed"
  }
  Set-ProtectedOperatorAcl -Path $tempPath -IsDirectory $false
  Assert-ProtectedOperatorAcl -Path $tempPath

  if ($destinationExisted) {
    [IO.File]::Replace($tempPath, $InstalledScriptPath, $replaceBackupPath)
  } else {
    [IO.File]::Move($tempPath, $InstalledScriptPath)
  }
  $replacementCompleted = $true

  Set-ProtectedOperatorAcl -Path $InstalledScriptPath -IsDirectory $false
  Assert-ProtectedOperatorAcl -Path $InstalledScriptPath
  $installedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InstalledScriptPath).Hash
  if ($installedHash -ne $sourceHash) {
    throw "installed copy hash verification failed"
  }
  if ($destinationExisted) {
    Remove-Item -LiteralPath $replaceBackupPath -Force
  }
} catch {
  $installError = $_
  if ($replacementCompleted) {
    try {
      if ($destinationExisted) {
        if (-not (Test-Path -LiteralPath $replaceBackupPath -PathType Leaf)) {
          throw "replacement backup is missing"
        }
        if (Test-Path -LiteralPath $InstalledScriptPath -PathType Leaf) {
          [IO.File]::Replace($replaceBackupPath, $InstalledScriptPath, $failedCandidatePath)
        } else {
          [IO.File]::Move($replaceBackupPath, $InstalledScriptPath)
        }
        $restoredHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $InstalledScriptPath).Hash
        if ($restoredHash -ne $destinationHash) {
          throw "restored copy hash verification failed"
        }
        if (Test-Path -LiteralPath $failedCandidatePath) {
          Remove-Item -LiteralPath $failedCandidatePath -Force
        }
      } else {
        if (Test-Path -LiteralPath $InstalledScriptPath) {
          Remove-Item -LiteralPath $InstalledScriptPath -Force
        }
        if (Test-Path -LiteralPath $InstalledScriptPath) {
          throw "failed first install was not removed"
        }
      }
    } catch {
      throw "sync task installation failed and rollback verification failed"
    }
  }
  throw $installError
} finally {
  if (Test-Path -LiteralPath $tempPath) {
    Remove-Item -LiteralPath $tempPath -Force
  }
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$InstalledScriptPath`""

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Sync BDC Codex OAuth auth.json to Hetzner with newest-wins safety." `
  -Force | Out-Null

Write-Output "task='$TaskName' interval_minutes=$IntervalMinutes installed_path='$InstalledScriptPath'"
