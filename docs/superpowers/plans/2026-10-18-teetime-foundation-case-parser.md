# Tee-time foundation case parser - source-only slice

Parent: bdc-xo#3332. This is pure platform source preparation, not application work.
The independent pre-build review approved this slice while the diagnostic workflow
review-owner gate remains pending. No CLI, worker, registry or runtime activation.

Implement parse_foundation_case with strict canonical ASCII JSON,65536-byte and
existing depth8 limits. Accept only clean-foundation-v1 and the exact foundation
WO. Require closed binding/governance/source/dependencies/runtime/execution objects.
Trusted context/profile, complete base/candidate bytes and all frozen asset bytes
are separate arguments; never derive them from the incoming manifest.

Recompute complete trees/manifests/frame using existing pure helpers unchanged.
Freeze one source-owned asset-reference map and require exactly those assets.
Bound every collection before hashing. Full candidate package.json/bun.lock bytes
must equal frozen acquisition bytes. Preserve every unmodified base path/mode;
only explicit new regular100644 foundation files are permitted, no deletions.

Use canonical sorted-key compact JSON with ASCII escapes and NO trailing newline,
the existing artifact canonicalization convention. Return only frozen validated
manifest bytes and SHA-256. Supplied authority/approval/inventory hashes bind data;
they do not prove provenance, approve a plan, qualify a runtime or admit execution.
Actual acquisition assets are outputs of separately approved dependency prep.
Built output and implementation review are later receipts, never pre-build stubs.

Test first: positive immutable data; stale bindings/governance; unknown/duplicate/
noncanonical/malformed input; missing/extra/changed assets; complete package/lock
changes; unauthorized add/edit/delete; Git/tree/frame substitutions; mutable input
or field types; file/asset bounds. No subprocess, files, dependencies or model call
may be used by the parser or its fixtures. Independently review before publication.
