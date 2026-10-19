# Source-only failure provenance after consumed attempt4

The simulated demo remains incomplete. Attempt4 returned stream/other/none,
one provider invocation, no normalized output and no artifact. Its complete row
and all consumed roots are preserved. No implementation attempt5 is proposed.
Knowledge layer: the earlier Oracle query returned no relevant tee-time
contract; live provider, collector, proxy and retained failure receipts govern.

Independent architect recommended preserving actual error origins, bounded
in-memory hints and separately versioned CONNECT parser-denial reasons before
considering a minimal authenticated diagnostic. No correlation between a single
proxy denial and inference may be inferred. Zero normalized chunks do not prove
zero internal native events. No HTTP status may be inferred from wording.

First source slice, before any diagnostic protocol or runtime change:

1. Add an internal WeakMap-backed fixed record for SDK iterator exceptions,
   native turn.failed, native stream error without terminal, provider
   initialization, and unknown. Record only version1 and one closed origin.
   No raw message, arbitrary properties, private-message hash or identifier.
2. Attach it at the actual iterator/event/initialization boundaries. Preserve
   existing errors and chunks, messages, retry/fallback and acceptance semantics.
   Copy the record through existing enrichment into replacement Error objects.
   Plain/hostile/unrecognized values must safely produce unknown.
3. Read it only through a typed internal helper. No public package export,
   MessageChunk schema change, worker/report schema change or new logging.
   Native incomplete error-result chunks may carry private WeakMap metadata;
   successful completions have no failure origin. Existing broad hints remain.
4. Write mocked regression tests first: each actual boundary and enrichment,
   recovered native error followed by successful completion, malformed/hostile
   metadata, secret-marker exclusion, unchanged result/error behavior and
   restricted one-invocation/no-fallback behavior.

Later source slices require their own concrete design/source review: a strict
failure-only diagnostic record through worker/controller, source-backed closed
in-memory hint classes, and a separately versioned proxy-reason receipt whose
five reason counters sum to parser denials. Keep header-read/connection/DNS
failures distinct. No parse_connect policy change or connection correlation.

Verification: new pure helper tests, mocked provider source/provenance suites,
existing restricted-provider and stream tests, full scripts typecheck, ASCII and
diff checks, independent source review and exact-source CI. No account, provider
request, image installation, new claim, authentication, deployment or app source
generation is authorized by this plan. A future tiny fixed-response diagnostic
needs separate reviewed contract, immutable inputs and one-use execution gates.
