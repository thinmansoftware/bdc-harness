param(
  [string]$SshAlias = "hetzner-prod",
  [string]$DesktopAuthPath = "$env:USERPROFILE\.codex\auth.json",
  [string]$RemoteAuthPath = "/opt/bdc/archon-user-home/.codex/auth.json",
  [string]$WebhookUrl = "https://n8n.bluedevilcollectibles.com/webhook/builder-status",
  [string]$LogPath = "$env:USERPROFILE\.codex\codex-auth-sync.log"
)

# Sync Codex desktop OAuth credentials to the Hetzner host using newest-wins.
# Verify probe: after a copy, docker exec runs Bun in archon-app-1 and imports
# the provider preflight reader against /root/.codex/auth.json. The probe only
# emits booleans and exits non-zero if auth.json cannot be read as credentials.

$ErrorActionPreference = "Stop"
$WoId = "WO-HARNESS-CODEX-AUTH-SYNC-AND-FRESHNESS-GATE-01"
$RemoteTempPath = "/tmp/codex-auth-sync-auth.json"

function Write-RedactedLog {
  param([string]$Action, [string]$Detail)
  $line = "$(Get-Date -Format o) action=$Action $Detail"
  $dir = Split-Path -Parent $LogPath
  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  Add-Content -Path $LogPath -Value $line -Encoding ascii
  Write-Output $line
}

function Send-BuilderStatus {
  param([string]$Action, [string]$Detail)
  $body = @{
    builder = "Cauldron"
    wo_id = $WoId
    action = $Action
    detail = $Detail
  } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Method Post -Uri $WebhookUrl -ContentType "application/json" -Body $body | Out-Null
  } catch {
    Write-RedactedLog -Action "failed" -Detail "webhook_post_failed status=unknown"
  }
}

function Complete-Action {
  param([string]$Action, [string]$Detail)
  Write-RedactedLog -Action $Action -Detail $Detail
  Send-BuilderStatus -Action $Action -Detail $Detail
}

function Invoke-RemoteText {
  param([string]$Command)
  $output = & ssh $SshAlias $Command
  if ($LASTEXITCODE -ne 0) {
    throw "ssh command failed exit=$LASTEXITCODE"
  }
  return ($output -join "`n").Trim()
}

function Invoke-RemoteChecked {
  param([string]$Command)
  & ssh $SshAlias $Command | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "ssh command failed exit=$LASTEXITCODE"
  }
}

function Get-LocalLastRefreshMs {
  param([string]$Path)
  try {
    $json = Get-Content -Raw -Path $Path | ConvertFrom-Json
    if (-not $json.last_refresh) { return $null }
    return ([DateTimeOffset]::Parse([string]$json.last_refresh)).ToUnixTimeMilliseconds()
  } catch {
    return $null
  }
}

function Get-RemoteLastRefreshMs {
  try {
    $raw = Invoke-RemoteText -Command "cat $RemoteAuthPath 2>/dev/null || true"
    if (-not $raw) { return $null }
    $json = $raw | ConvertFrom-Json
    if (-not $json.last_refresh) { return $null }
    return ([DateTimeOffset]::Parse([string]$json.last_refresh)).ToUnixTimeMilliseconds()
  } catch {
    return $null
  }
}

function Get-LocalSha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Get-RemoteSha256 {
  try {
    return Invoke-RemoteText -Command "test -f $RemoteAuthPath && sha256sum $RemoteAuthPath | cut -d' ' -f1 || true"
  } catch {
    return ""
  }
}

function Get-RemoteMtimeSeconds {
  try {
    $value = Invoke-RemoteText -Command "stat -c %Y $RemoteAuthPath 2>/dev/null || true"
    if (-not $value) { return $null }
    return [int64]$value
  } catch {
    return $null
  }
}

function Invoke-VerifyProbe {
  $probe = @"
docker exec archon-app-1 bun -e "import('/app/packages/providers/src/auth-refresh/preflight.ts').then(m=>{const f=m.readCodexFreshness('/root/.codex/auth.json');if(!f.hasCreds||!f.hasRefreshToken)process.exit(2);console.log(JSON.stringify({hasCreds:f.hasCreds,hasRefreshToken:f.hasRefreshToken,fresh:Boolean(f.freshExpiresAt)}));}).catch(()=>process.exit(3))"
"@
  Invoke-RemoteChecked -Command $probe.Trim()
}

try {
  if (-not (Test-Path $DesktopAuthPath)) {
    Complete-Action -Action "failed" -Detail "desktop_auth_missing path=$DesktopAuthPath"
    exit 1
  }

  $desktopHash = Get-LocalSha256 -Path $DesktopAuthPath
  $remoteHash = Get-RemoteSha256
  $desktopBytes = (Get-Item $DesktopAuthPath).Length
  $remoteBytesText = Invoke-RemoteText -Command "stat -c %s $RemoteAuthPath 2>/dev/null || true"
  $remoteBytes = if ($remoteBytesText) { [int64]$remoteBytesText } else { 0 }
  $desktopRefreshMs = Get-LocalLastRefreshMs -Path $DesktopAuthPath
  $remoteRefreshMs = Get-RemoteLastRefreshMs
  $desktopHashPrefix = $desktopHash.Substring(0, 8)
  $remoteHashPrefix = if ($remoteHash.Length -ge 8) { $remoteHash.Substring(0, 8) } else { "missing" }

  if ($desktopHash -and $remoteHash -and $desktopHash -eq $remoteHash) {
    Complete-Action -Action "no-op" -Detail "hashes_identical desktop_sha=$desktopHashPrefix remote_sha=$remoteHashPrefix bytes=$desktopBytes"
    exit 0
  }

  $desktopIsNewer = $false
  $usedMtimeFallback = $false
  if ($null -ne $desktopRefreshMs -and $null -ne $remoteRefreshMs) {
    $desktopIsNewer = $desktopRefreshMs -gt $remoteRefreshMs
  } else {
    $usedMtimeFallback = $true
    $desktopMtime = ([DateTimeOffset](Get-Item $DesktopAuthPath).LastWriteTimeUtc).ToUnixTimeSeconds()
    $remoteMtime = Get-RemoteMtimeSeconds
    $desktopIsNewer = $null -eq $remoteMtime -or $desktopMtime -gt $remoteMtime
  }

  if (-not $desktopIsNewer) {
    Complete-Action -Action "skipped" -Detail "container_newer_or_equal desktop_sha=$desktopHashPrefix remote_sha=$remoteHashPrefix desktop_bytes=$desktopBytes remote_bytes=$remoteBytes"
    exit 0
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = "$RemoteAuthPath.bak.$stamp"
  Invoke-RemoteChecked -Command "test -f $RemoteAuthPath && cp $RemoteAuthPath $backupPath || true"
  & scp $DesktopAuthPath "$SshAlias`:$RemoteTempPath" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "scp failed exit=$LASTEXITCODE" }
  Invoke-RemoteChecked -Command "mv $RemoteTempPath $RemoteAuthPath && chown appuser:appuser $RemoteAuthPath && chmod 600 $RemoteAuthPath"

  try {
    Invoke-VerifyProbe
  } catch {
    Invoke-RemoteChecked -Command "test -f $backupPath && mv $backupPath $RemoteAuthPath || true"
    Complete-Action -Action "failed" -Detail "verify_probe_failed restored_backup=$backupPath desktop_sha=$desktopHashPrefix bytes=$desktopBytes"
    exit 1
  }

  $mode = if ($usedMtimeFallback) { "mtime_fallback" } else { "last_refresh" }
  Complete-Action -Action "synced" -Detail "copied mode=$mode backup=$backupPath desktop_sha=$desktopHashPrefix remote_sha_before=$remoteHashPrefix bytes=$desktopBytes"
  exit 0
} catch {
  Complete-Action -Action "failed" -Detail "sync_error type=$($_.Exception.GetType().Name)"
  exit 1
}
