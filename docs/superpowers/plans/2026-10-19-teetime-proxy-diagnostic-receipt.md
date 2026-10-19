# Separately versioned proxy denial diagnosis - source proposal

The demo remains incomplete and all four implementation attempts are consumed.
The single aggregate denial in attempt4 is not proven causal. This source slice
collects closed reason counts only; no raw request/header/host/error material and
no parser, destination, DNS policy, tunnel or duration changes.

Prior art: existing ConnectPolicyError five-reason enum, handle_client source,
legacy parse_proxy_receipt and offline native header fixtures. The earlier Oracle
diagnostic query returned no relevant contract. Live source governs.

Keep all counters and receipt construction inside the already measured proxy
module; add no runtime dependency. Legacy startup/final JSON remain identical
by default. A new fixed `--diagnostic-receipt` flag emits separate version1
diagnostic ready/final records which the old parser intentionally rejects.
Existing callers never set it. No new task/duration/destination configuration.

At the existing parser ValueError catch, increment legacy denial exactly as
today. Additionally count only actual closed ConnectPolicyError.reason values:
request_line_or_destination, duplicate_header, unsupported_header,
invalid_header_value, encoding_or_framing. Unknown parser failures make reason
totals disagree and diagnostic construction/validation reject; do not normalize.

Track the actual source phase, without reading error text. Outer handled
failures outside parsing count one of connection_limit, header_read, dns_lookup,
dns_validation, upstream_connect or tunnel. Set each phase at its narrow source
boundary. Preserve existing exception handling, numeric DNS dialing, TLS-first
check, limits, cancellation and cleanup. Parser failures cannot be counted as
header-read failures. Timeout remains in the legacy aggregate as well as its
distinct observed non-parser phase; this is categorization, not request tracing.

Version1 final kind `teetime-proxy-diagnostic` carries outcomes/bytes/active,
parserReasons and nonParserReasons only. All enum keys appear, no unknown keys.
The five parser reasons sum exactly to header_or_destination_denied. Parser plus
non-parser failures sum exactly to rejected_or_closed + timeout. dns_validation
equals dns_denied; failure count cannot exceed closed. Require active0, existing
byte bound and exact nonnegative integer counters at most1e9. No booleans,
unknown values, missing keys, duplicate JSON keys or silent saturation.

Add an independent strict parser module for this separate two-line ready/final
schema,4096-byte ASCII bound and contradictions. Do not alter the legacy parser.
Test real handle_client through loopback mocks for every parser reason and each
non-parser phase, unknown parser failure, valid and rejected counter sums,
privacy markers and default output equality. No real upstream/model/account.
Run existing proxy/header/legacy-receipt tests and source CI after independent
source review. This does not install an image, widen policy, start a proxy,
authenticate, create a claim or authorize a real diagnostic. Future runtime
integration and immutable one-use diagnostic execution need separate review.
