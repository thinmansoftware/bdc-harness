# Build the checked-out exact commit and run the same acceptance gate as CI.
# No login, host credential copy, shared staging replacement or production use.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceSha,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if ($SourceSha -notmatch '^[a-f0-9]{40}$') { throw 'SourceSha must be a full commit SHA' }
$headSha = (git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $headSha -ne $SourceSha) { throw 'Checkout does not match SourceSha' }
$dirty = git -C $repo status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Use a clean candidate worktree' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Evidence directory already exists' }
$docker = (Get-Command docker -ErrorAction Stop).Source
$bun = (Get-Command bun -ErrorAction Stop).Source
$endpoint = (& $docker context inspect --format '{{.Endpoints.docker.Host}}').Trim()
if ($LASTEXITCODE -ne 0 -or -not $endpoint) { throw 'Cannot resolve Docker endpoint' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$clientConfig = Join-Path $output 'public-docker-client'
New-Item -ItemType Directory -Path $clientConfig | Out-Null
# An explicit empty Hub entry prevents Windows' automatic native credential
# helper discovery. Public base images need no account or saved credentials.
$anonymous = @{ auths = @{ 'https://index.docker.io/v1/' = @{} } }
[IO.File]::WriteAllText((Join-Path $clientConfig 'config.json'),
  ($anonymous | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
$priorConfig = $env:DOCKER_CONFIG
$priorHost = $env:DOCKER_HOST
$image = 'archon-runtime-candidate:' + $SourceSha.Substring(0, 12) + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
try {
  $env:DOCKER_CONFIG = $clientConfig
  $env:DOCKER_HOST = $endpoint
  $buildArgs = @('build', '--build-arg', "ARCHON_BUILD_SHA=$SourceSha", '--label',
    "org.opencontainers.image.revision=$SourceSha", '-t', $image, $repo)
  $ErrorActionPreference = 'Continue'
  & $docker @buildArgs *> (Join-Path $output 'build.log')
  $buildExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($buildExit -ne 0) { throw "Build failed ($buildExit); see build.log" }
  @{ sourceSha = $SourceSha; image = $image; buildExit = $buildExit } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'candidate.json') -Encoding ascii
  $ErrorActionPreference = 'Continue'
  & $bun (Join-Path $repo 'scripts/staging/verify-runtime.ts') --image $image --source-sha $SourceSha --output-dir (Join-Path $output 'acceptance') *> (Join-Path $output 'acceptance.log')
  $acceptanceExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($acceptanceExit -ne 0) { throw "Acceptance failed ($acceptanceExit); see acceptance/receipt.json" }
  Get-Content -LiteralPath (Join-Path $output 'acceptance/receipt.json')
} finally {
  $env:DOCKER_CONFIG = $priorConfig
  $env:DOCKER_HOST = $priorHost
}
