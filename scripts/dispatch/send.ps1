param(
  [Parameter(Mandatory=$true)][string]$ApiBase, [Parameter(Mandatory=$true)][string]$TokenFile,
  [Parameter(Mandatory=$true)][string]$Sender, [Parameter(Mandatory=$true)][string]$Recipient,
  [Parameter(Mandatory=$true)][string]$TaskType, [Parameter(Mandatory=$true)][string]$IdempotencyKey,
  [Parameter(Mandatory=$true)][string]$CorrelationId, [Parameter(Mandatory=$true)][string]$Priority,
  [Parameter(Mandatory=$true)][string]$BodyFile, [Parameter(Mandatory=$true)][string]$SubjectKey,
  [string]$RepeatReason=''
)
$ErrorActionPreference='Stop'
if ($SubjectKey -notmatch '^(wo:WO-[A-Z0-9]+(?:-[A-Z0-9]+)*|gh:[A-Za-z0-9][A-Za-z0-9.-]*/[A-Za-z0-9_.-]+#[1-9][0-9]*)$') { throw 'invalid subject_key' }
$token=(Get-Content -Raw $TokenFile).Trim(); if (!$token) { throw 'empty token file' }
$headers=@{ Authorization="Bearer $token" }
$history=@(Invoke-RestMethod -Headers $headers -Uri "$($ApiBase.TrimEnd('/'))/api/dispatch/messages?subject_key=$([uri]::EscapeDataString($SubjectKey))&limit=100")
$history | ForEach-Object { [Console]::Error.WriteLine("$($_.id)`t$($_.status)`t$($_.task_outcome)`t$($_.acknowledged_at)`t$($_.addressed_at)`t$($_.repeat_reason)") }
$repeat=[bool]($history | Where-Object { $_.status -in @('done','failed') -or $_.task_outcome -eq 'blocked' -or $_.acknowledged_at -or $_.addressed_at })
if ($repeat -and !$RepeatReason) { throw 'repeat reason required' }
$payload=@{correlation_id=$CorrelationId;idempotency_key=$IdempotencyKey;task_type=$TaskType;sender=$Sender;recipient=$Recipient;body=(Get-Content -Raw $BodyFile);priority=$Priority;subject_key=$SubjectKey}
if ($RepeatReason) { $payload.repeat_reason=$RepeatReason }
$receipt=Invoke-RestMethod -Method Post -Headers $headers -ContentType application/json -Body ($payload|ConvertTo-Json -Compress) -Uri "$($ApiBase.TrimEnd('/'))/api/dispatch/messages"
if (!$receipt.id) { throw 'malformed dispatch receipt' }
"DISPATCH_RECEIPT id=$($receipt.id) subject_key=$($receipt.subject_key) status=$($receipt.status) repeat=$($repeat.ToString().ToLower())"
