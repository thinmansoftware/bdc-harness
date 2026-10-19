# Minimal diagnostic data path - source design, not execution

Objective remains the complete simulated demo. Four implementation attempts are
consumed. A minimal diagnostic is not attempt5, app source, a booking or a demo.
Oracle search for failure-only minimal tee-time diagnostic receipts returned no
relevant contract. Existing restricted provider, lifecycle, worker and receipt
source are the prior art. No extra account/model operation is authorized here.

## Diagnostic collector and independent validator

Add an unregistered source-only collector with no CLI or process entrypoint.
Its query callback receives only the literal `Reply with exactly OK.` and the
caller-owned abort signal. No caller prompt, model, cwd, tools, options, file
output or source-artifact selector. Future operational code must use the existing
restricted canary factory and independently enforce custody, authorization,
workspace, preflights, deadline and process reaping before any account delivery.

One provider invocation maximum. Reuse ArtifactProviderLifecycle and the newly
reviewed private origin reader. Bound normalized chunks to64, examined content
to16384 UTF-8 bytes and retained assistant text to64 bytes. Successful completion
requires exact response after ASCII whitespace trim `OK`, exactly one clean
result, normal stream end, closed iterator and no abort. Thinking is discardable
and bounded. Tool, route, system and unknown chunks reject; error results reject.
No source bytes or response text leave the collector. A provider error may have
zero normalized chunks, so record its actual private origin before enrichment
can be discarded. An incomplete error result preserves its chunk's trusted
origin. Event interpretation failures stay unknown.

The version1 `teetime-minimal-diagnostic` packet includes only passed,
responseVerified, modelInvocations, assistant/result/thinking/chunk counts,
normalProviderEnd, providerIteratorClosed, aborted and a nullable failure record.
The failure record has a closed local failureCode, closed existing broad
exceptionCategory hint and `{version:1,origin:<closed origin>}`. Do not expose raw
errors, arbitrary fields, paths, identifiers, response text, private-message
hashes, HTTP statuses inferred from text or claims of entitlement. Counts remain
bounded even on first excess: chunkCount may be65 only for a bound failure.
The collector has no app artifact or publication field.

Independent review correction: every failure additionally requires a boolean
cleanupFailure. Latch the primary failure before iterator unwind. Later SDK
return/onClosed exceptions set this flag without replacing primary code or
provenance. Thus chunk65 remains chunk_limit with categorized count64 even when
cleanup throws. Callback-only cleanup uses cleanup_failed/true and cannot have
normalProviderEnd. Ordinary early rejection with successful cleanup keeps false.
This flag concerns iterator/callback exceptions, not container or auth custody.

The new strict Python validator accepts only exact keys, ASCII JSON up to4096
bytes, no duplicates/constants/unknown enum values, exact types and bounded
counts. Cross-check success/failure/lifecycle/response fields and actual child
exit0/1. It validates diagnostic syntax only, granting no wrapper custody or
app acceptance. Existing demo/fixed-artifact packets and historical validators
must remain unchanged. No default field added to old packets.

## CONNECT diagnosis remains separately versioned

Plan a separate receipt, not a mutation of legacy parse_proxy_receipt output.
Use the existing five ConnectPolicyError reasons; count only parse_connect
rejections. Their sum must equal the existing parser-denial aggregate. Keep
connection limits, header-read/framing, DNS and other failures distinct; never
infer those from error text or collect header names/values/hosts. Unknown reasons
or contradictory totals reject instead of normalizing to zero. Retain existing
proxy policy, transport destinations and legacy output by default. Concrete
counter integration and diagnostic-mode output need independent design review.

## Review and verification gates

Implement only after independent design corrections. Test first with mocked
provider failure origins, native error results, tiny success, mismatched/oversize
responses, disallowed chunks, duplicate/error/missing results, bounds, abort,
iterator exceptions/cleanup and private markers. Python negatives cover forged
success, extra/duplicate keys, bool-as-int, unknown origin/hint/code, wrong exit
and legacy/app packet rejection. Verify actual mocked provider failures flow
through the collector and Python parser without raw text. Update owning runbook
and existing offline CI invocations; run typecheck, ASCII and source review.

This design does not start a worker, install source/image, deliver credentials,
create a diagnostic claim, alter a provider-attempt row, widen proxy policy or
approve an authenticated diagnostic. Those require separately reviewed immutable
inputs, exact carrier and one-use execution gates preserving all four attempts.
No full product prompt, automatic retry, Claude/Fable, real golf-provider calls,
bookings, payments, purchases, production changes or desktop app-code fallback.
