param(
  [string]$SshAlias = "hetzner-prod",
  [string]$DesktopAuthPath = "$env:USERPROFILE\.codex\auth.json",
  [string]$ContainerName = "archon-app-1",
  [string]$ContainerAuthPath = "/root/.codex/auth.json",
  [string]$WebhookUrl = "https://n8n.bluedevilcollectibles.com/webhook/builder-status",
  [string]$LogPath = "$env:USERPROFILE\.codex\codex-auth-sync.log"
)

# Sync Codex desktop OAuth credentials to the Hetzner container using newest-wins.
# Protected remote file operations run as root through docker exec. The verify
# probe emits booleans only and fails if the replacement is not valid credentials.

$ErrorActionPreference = "Stop"
$WoId = "WO-HARNESS-CODEX-AUTH-SYNC-AND-FRESHNESS-GATE-01"
$ContainerTempPath = "/root/.codex/auth.json.tmp.sync"

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
    Write-RedactedLog -Action "failed" -Detail "status=webhook_post_failed"
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

function Get-LocalJwtIssuedAtSeconds {
  param([string]$Path)
  try {
    $json = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    $token = [string]$json.tokens.access_token
    $parts = $token.Split(".")
    if ($parts.Length -ne 3) { return $null }

    $payload = $parts[1].Replace("-", "+").Replace("_", "/")
    while (($payload.Length % 4) -ne 0) { $payload += "=" }
    $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
    if ($null -eq $payloadJson.iat) { return $null }
    return [int64]$payloadJson.iat
  } catch {
    return $null
  }
}

function Get-LocalSha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-ContainerMetadata {
  $command = @"
docker exec $ContainerName bun -e "import {readFileSync,statSync} from 'node:fs';import {createHash} from 'node:crypto';const p='$ContainerAuthPath';try{const raw=readFileSync(p);const stat=statSync(p);const json=JSON.parse(raw.toString('utf8'));const token=json?.tokens?.access_token;let iat=null;if(typeof token==='string'){const parts=token.split('.');if(parts.length===3){try{const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));if(Number.isFinite(payload.iat))iat=Math.trunc(payload.iat);}catch{}}}console.log(JSON.stringify({exists:true,sha256:createHash('sha256').update(raw).digest('hex'),bytes:raw.length,mtimeSeconds:Math.trunc(stat.mtimeMs/1000),iat}));}catch{console.log(JSON.stringify({exists:false,sha256:'',bytes:0,mtimeSeconds:null,iat:null}));}"
"@
  $raw = Invoke-RemoteText -Command $command.Trim()
  return $raw | ConvertFrom-Json
}

function Invoke-VerifyProbe {
  $probe = @"
docker exec $ContainerName bun -e "import('/app/packages/providers/src/auth-refresh/preflight.ts').then(m=>{const f=m.readCodexFreshness('$ContainerAuthPath');if(!f.hasCreds||!f.hasRefreshToken)process.exit(2);console.log(JSON.stringify({hasCreds:f.hasCreds,hasRefreshToken:f.hasRefreshToken,fresh:Boolean(f.freshExpiresAt)}));}).catch(()=>process.exit(3))"
"@
  Invoke-RemoteChecked -Command $probe.Trim()
}

try {
  if (-not (Test-Path -LiteralPath $DesktopAuthPath)) {
    Complete-Action -Action "failed" -Detail "status=desktop_auth_missing"
    exit 1
  }

  $desktopHash = Get-LocalSha256 -Path $DesktopAuthPath
  $desktopBytes = (Get-Item -LiteralPath $DesktopAuthPath).Length
  $desktopIssuedAtSeconds = Get-LocalJwtIssuedAtSeconds -Path $DesktopAuthPath
  $containerMetadata = Get-ContainerMetadata
  $remoteHash = [string]$containerMetadata.sha256
  $remoteBytes = [int64]$containerMetadata.bytes
  $remoteIssuedAtSeconds = if ($null -ne $containerMetadata.iat) { [int64]$containerMetadata.iat } else { $null }
  $desktopHashPrefix = $desktopHash.Substring(0, 8)
  $remoteHashPrefix = if ($remoteHash.Length -ge 8) { $remoteHash.Substring(0, 8) } else { "missing" }

  if ($desktopHash -and $remoteHash -and $desktopHash -eq $remoteHash) {
    Complete-Action -Action "no-op" -Detail "status=hashes_identical desktop_sha=$desktopHashPrefix remote_sha=$remoteHashPrefix desktop_bytes=$desktopBytes remote_bytes=$remoteBytes"
    exit 0
  }

  $comparison = "jwt_iat"
  if ($null -ne $desktopIssuedAtSeconds -and $null -ne $remoteIssuedAtSeconds) {
    $desktopIsNewer = $desktopIssuedAtSeconds -gt $remoteIssuedAtSeconds
  } else {
    $comparison = "mtime_fallback"
    $desktopMtime = ([DateTimeOffset](Get-Item -LiteralPath $DesktopAuthPath).LastWriteTimeUtc).ToUnixTimeSeconds()
    $remoteMtime = if ($null -ne $containerMetadata.mtimeSeconds) { [int64]$containerMetadata.mtimeSeconds } else { $null }
    $desktopIsNewer = $null -eq $remoteMtime -or $desktopMtime -gt $remoteMtime
  }

  if (-not $desktopIsNewer) {
    Complete-Action -Action "skipped" -Detail "status=container_newer_or_equal comparison=$comparison desktop_sha=$desktopHashPrefix remote_sha=$remoteHashPrefix desktop_bytes=$desktopBytes remote_bytes=$remoteBytes"
    exit 0
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupPath = "$ContainerAuthPath.bak.$stamp"
  Invoke-RemoteChecked -Command "docker exec $ContainerName sh -c `"if [ -f '$ContainerAuthPath' ]; then cp '$ContainerAuthPath' '$backupPath'; fi`""

  Get-Content -Raw -LiteralPath $DesktopAuthPath |
    & ssh $SshAlias "docker exec -i $ContainerName sh -c `"umask 077; cat > $ContainerTempPath`"" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "credential stream failed exit=$LASTEXITCODE" }

  Invoke-RemoteChecked -Command "docker exec $ContainerName sh -c `"chmod 600 $ContainerTempPath && mv $ContainerTempPath $ContainerAuthPath`""

  try {
    Invoke-VerifyProbe
  } catch {
    Invoke-RemoteChecked -Command "docker exec $ContainerName sh -c `"if [ -f '$backupPath' ]; then cp '$backupPath' '$ContainerAuthPath' && chmod 600 '$ContainerAuthPath'; fi`""
    Complete-Action -Action "failed" -Detail "status=verify_probe_failed comparison=$comparison desktop_sha=$desktopHashPrefix remote_sha=$remoteHashPrefix desktop_bytes=$desktopBytes remote_bytes=$remoteBytes"
    exit 1
  }

  Complete-Action -Action "synced" -Detail "status=synced comparison=$comparison desktop_sha=$desktopHashPrefix remote_sha=$remoteHashPrefix desktop_bytes=$desktopBytes remote_bytes=$remoteBytes"
  exit 0
} catch {
  Complete-Action -Action "failed" -Detail "status=sync_error"
  exit 1
}
