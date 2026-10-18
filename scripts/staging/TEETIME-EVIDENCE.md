# Tee-time evidence candidates

These helpers are unregistered source candidates. They construct no SDK, read no
credentials and do not dispatch, approve publication or deploy. The controller
must supply trusted authority, exact identities and complete evidence. Metadata
validation cannot authenticate its caller or prevent concurrent replay.

## Deterministic checks

```text
python -m unittest discover -s scripts/staging -p test_teetime_snapshot.py
python -m unittest discover -s scripts/staging -p test_teetime_git_objects.py
bun test packages/providers/src/community/pi/restricted-review-evidence.test.ts
bun test packages/providers/src/community/pi/restricted-review-transport.test.ts
bun test packages/providers/src/community/pi/restricted-review.test.ts
```

Run each Bun file in its own process because installed-SDK mocks are global.
The hosted offline-qualification workflow includes the new deterministic checks.

## Review package and terminal gate

packages/providers/src/community/pi/restricted-review-evidence.ts exports
validateReviewEvidence. Supply expectedBinding from controller-owned persisted
run authority and reviewed configuration, never from model output. Builder,
test and reviewer images are separate. Authority/policy hashes use the existing
sha256: prefix; artifact/output/schema/manifest hashes use bare SHA-256 hex.
Commit/tree identities remain actual Git object IDs, not directory hashes.

The input includes the exact package text, an actual serialized SDK request,
required check IDs and command hashes, complete trusted receipts and one trusted
reviewer result envelope. The tests artifact must contain the exact complete
serialized receipts. Missing, duplicate, failed, skipped, truncated, aborted or
zero-assertion checks fail. The wire helper verifies the frozen package text,
injects the unchanged private response schema and enforces its final UTF-8
6000-byte bound. Oversized evidence fails; do not summarize or omit it to fit.

The schema hash is derived from the serialized source-owned schema, and model
digest must equal the qualified fixed reviewer digest. Only one normally
completed, nonerror, strict APPROVED terminal with all three evidence IDs returns
a bound approval candidate. A future trusted controller must consume it atomically
and recheck source/run custody before any side effect. This function grants no
publication authority and does not prove the current reviewer can fit real WOs.

## Snapshot archive parser

scripts/staging/teetime_snapshot.py exports read_snapshot(raw, approved_paths).
approved_paths is the trusted EXACT candidate inventory, not an allowlist that
permits silently missing members. Establish it after reaping all model processes
while the container and its tmpfs remain alive; docker exec cannot export a stopped
container. Scope and quiescence checks are separate, still unimplemented gates.

The parser accepts only bounded regular-file USTAR data with checksums, padding,
an explicit terminator and every inventory member present. It rejects traversal,
links, extension records, sparse/device/FIFO entries, unexpected/missing members,
Windows reserved names, alternate streams, case and file-directory collisions,
metadata/instruction paths and credential-file names. No archive is extracted.
File bytes and executable semantics are retained in immutable records.

snapshot_manifest accepts only unchanged validated parser output. Its canonical
manifest includes every regular file, including additions, with mode, size and
content hash. It is not a validator for arbitrary constructed records. Compare
against a trusted frozen base to represent deletions explicitly; that comparison,
trusted Git commit construction, runtime export, readonly test mounts,
before/after source checks and replay-safe approval consumption remain separate
work. Never let a model-written .gitignore choose what evidence to omit.
Pure Git tree construction is implemented in the next section; its existence
does not establish runtime capture custody.

## Pure Git tree identity

scripts/staging/teetime_git_objects.py exports build_git_objects(files,
expected_format='sha1'). The keyword is required; other object formats fail.
Supply the complete unchanged tuple from read_snapshot, never a partial diff.
The helper preserves exact binary bytes and executable modes, applies Git's
directory ordering, deduplicates identical blobs and returns immutable bounded
blob/tree records plus the root tree ID. It creates no commits, refs or repository
state and invokes no subprocess. Git SHA-1 object IDs are distinct from the
canonical SHA-256 snapshot manifest. Additional structural checks do not prove
runtime provenance or authenticate the caller.

The tests independently compare every object and complete root tree against
trusted Git hash-object/update-index/write-tree in fresh bare repositories with
isolated configuration, empty hooks/templates, disabled attributes and no remote
protocols. They cover empty, nested, executable, binary, ordering, additions,
deletions and deterministic deduplication. Trusted Git is required; no skipped
check may stand in for this comparison. The source-only constructor does not
resolve the runtime execution barrier, inventory custody or test-worker gates.
