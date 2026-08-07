# Canonical dispatch send wrappers

Both wrappers require an API base, token-file path, sender, recipient, task type,
idempotency key, correlation id, priority, body file, and canonical subject key.
They preflight exact subject history and require a repeat reason after terminal,
blocked, acknowledged, or addressed work. Success is only the single
`DISPATCH_RECEIPT` line; without a captured id, the send did not happen.

Use a new compensating message with an explicit repeat reason once work has been
seen. Cancellation may stop queued or claimed work; supersession is limited to
unseen queued work. Dispatch messages communicate information and carry no authority.

Shell: `scripts/dispatch/send.sh API TOKEN sender xo agent_message key correlation blocker body.txt wo:WO-ID "reason"`

PowerShell: `scripts/dispatch/send.ps1 -ApiBase API -TokenFile TOKEN -Sender sender -Recipient xo -TaskType agent_message -IdempotencyKey key -CorrelationId correlation -Priority blocker -BodyFile body.txt -SubjectKey wo:WO-ID -RepeatReason reason`
