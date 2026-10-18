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

## Standalone capture prototype

The source-only capture prototype uses a fixed synchronous writer, not a model.
It is not connected to authenticated workers, registry, workflows or admission.
Previously submitted asynchronous I/O and Docker API operations that complete
after a timed-out client remain separate admission questions. Pausing tasks and
matching exports are not a claim of a general immutable filesystem snapshot.

teetime_snapshot_exporter.py traverses a readonly volume with bounded Linux
descriptor-relative no-follow operations. Underlying .codex/.agents directories
must be ordinary and empty; links, special entries, multiple hard links and
out-of-scope files fail. A canonical framed inventory precedes bounded USTAR data.
The controller independently checks scope and exact inventory through the existing
parser, then computes the pure Git tree identity. Ignore rules are never loaded.

probe_teetime_snapshot_capture.py accepts --docker, --image (exact immutable ID),
--source (exact prototype commit) and one fixed --case. It requires an image with
TEETIME_CAPTURE_SOURCE_SHA and matching immutable helper hashes. This is a
prototype-specific derivative, not a full-source image or an authenticated image
promotion. Before volume copy-up, its image /workspace must be empty and owned by
UID1001. Runtime containers use no network, credentials, host binds or Docker socket.
The worker owns one unique local volume; the separate exporter mounts it readonly.
Exact configurations and exclusive volume references are checked before workloads
start, then before/after each paused export. Exporter code lives outside the volume.

An independently pinned-controller watchdog arms before resources are created.
The controller stops Docker operations after25 seconds; cleanup starts no later
than45 seconds, verifies controller exit (terminating only that pinned process if
necessary), and reconciles owned resources until absence is observed twice.
There is no unpause path. Result receipts are retained in the unique owner folder.
These bounds are prototype budgets, not changes to the authenticated launcher.

Cases: clean captures twice with an advancing-then-paused counter; shadow,
symlink and hardlink require the exact expected rejection; unpaused must fail
before export; delayed-create must reject creation after its execution cutoff.
forced-exit and controller-stall intentionally terminate the operator process;
their result is the independent watchdog receipt plus fresh owned-resource absence,
not an exit0 controller result. Never treat generic process failure as a successful
negative test. Run each once after source review, not as an automatic retry loop.

Required Linux unit command (no skipping on Windows):

```text
python3 -m unittest discover -s /app/scripts/staging -p test_teetime_snapshot_exporter.py
```

The initial tests failed before implementation. Local controller tests pass;
the exact5d9d16f317d6934b73db62b6f08f304c4a3c6a2d prototype subsequently passed
13 Linux tests and all eight cases on image
sha256:ad9cca8535c33c98650eeda6f56a395842656d3600fb3210c05b7e4a29f8c156.
Hosted isolation CI39128002700 passed separately. See the owning bdc-xo record
docs/tee-time/tee-time-capture-prototype-20261018.md for receipts and limits.

## Proposed source-data contract amendment

This is a reviewed source-only alternative to capturing an untrusted model
workspace. It does not modify the active version1 policy or register a provider.
The builder's workspace, Git metadata, ignore rules and claimed test results
never supply candidate source. Instead, a future stream collector must accept
exactly one bounded assistant artifact message, then one successful result and
normal iterator completion. Extra assistant messages, warnings, fallback, errors,
abort, missing completion and iterator exceptions fail. Actual CodexProvider
assistant chunks contain item.completed agent_message text; its result chunk
does not contain that text. Do not use structuredOutput or concatenate messages.
The stream collector/installed-SDK fixture is a separate unqualified next slice.

teetime_artifact_contract.py exports parse_artifact(raw, base_files=...,
expected_binding=..., allowed_paths=...). raw must be immutable strict UTF-8 JSON
bytes, at most65536 bytes, nesting at most8 and one to32 explicit operations.
Duplicate keys at every object level, BOM, fences and trailing payload fail.
Only version1, binding and operations fields are accepted.

Binding fields: runId, nodeId, attempt, authorityHash, policyHash, baseManifestHash.
The controller supplies their expected values from frozen authority and the
complete trusted base; echoed values grant no authority. Manifest SHA-256 is
distinct from the Git SHA-1 tree ID. allowed_paths maps fixed canonical paths to
tuples of permitted100644/100755 modes, without wildcards.

Each write has action, path, baseHash, mode and ASCII content. baseHash is the
existing content's SHA-256 or null for explicit absence. Each delete has action,
path and the existing baseHash. Only one operation per canonical path is allowed;
absent deletes, stale hashes, out-of-scope paths/modes, NUL content and ineffective
changes fail. Unmentioned base files are preserved byte-for-byte, including binary
files. Existing file/count/total bounds and final candidate collision checks apply.

The returned frozen candidate contains complete file records, canonical manifest,
manifest hash, tree ID and raw artifact/binding hashes. It performs no filesystem,
subprocess, repository, approval or publication action and cannot authenticate its
caller. Pure tests are invoked with:

```text
python -m unittest discover -s scripts/staging -p test_teetime_artifact_contract.py
```

STOP POINT: parser success does not qualify the SDK message contract or admit a
builder. Next separately review and qualify the real installed-SDK loopback
fixture, trusted synchronous materialization into a new controller-owned volume,
and separate readonly/noauth/nonetwork testing. The qualified reviewer's6000-byte
wire bound, replay-safe approval consumption, policy/workflow revision and exact
CI/staging gates remain binding. Do not activate this amendment by aliasing the
old filesystem canary or ordinary provider identities.

## Unregistered artifact stream qualification candidate

teetime-artifact-stream.ts collects exact bytes from one assistant message, then
one successful provider result and normal iterator completion. It bounds the whole
stream to64 chunks, reasoning to16384 UTF-8 bytes and artifact text to65536 bytes.
It rejects lone UTF-16 surrogates before encoding. Reasoning is untrusted discarded
data and may only precede the artifact. Tools, system/warnings, rate limits,
routing, unknown/malformed fields, extra messages/results, abort and iterator
exceptions fail. The collector neither parses JSON nor grants source authority.
It returns the exact bytes for the separate strict parser.

Its observable boundary is the provider iterator: Codex's normalizer returns at
the first turn.completed, so raw SDK events not exposed by it are not attested.
Direct collector tests cover post-terminal provider chunks. The caller must impose
a deadline and abort/reap the owned process when an iterator stalls or is rejected.

The fixed no-auth selector is:

```text
python probe-teetime-filesystem.py --docker <operator-docker-path> --image sha256:<exact-image-id> --expected-sha <base-ARCHON_BUILD_SHA> --artifact-fixture --artifact-source <exact-artifact-commit> --artifact-case success --pids-budget 128
```

Use duplicate as the separately executed negative case. The composite image keeps
base ARCHON_BUILD_SHA and adds TEETIME_ARTIFACT_SOURCE_SHA. The controller verifies
both, plus immutable hashes of the fixture, collector, parser, snapshot/Git helpers,
actual restricted factory/provider/policy/types and logger. It retains all existing
no-network, nonroot, readonly root, metadata masks, seccomp, memory/CPU/PID and
bounded output/cleanup checks. Existing filesystem/patch selectors remain unchanged.

The loopback worker loads the real SDK before a test-only module wrapper. Original
constructor and thread options must exactly match unchanged restricted helpers.
Only loopback base URL, dummy API credential and proxy removal may differ; the
real factory/provider, SDK and pinned CLI run unchanged. Module interception and
exact option deltas are verified. Pino is silenced before provider import.
SSE messages use the inspected pinned responses.rs::ev_assistant_message helper.
Success requires one assistant, one result, normal provider end, exact raw bytes,
strict parser/candidate checks and unchanged synthetic auth/model workspace.
Duplicate assistant messages must reject without any candidate.

Nine collector tests/43 assertions and the full local scripts typecheck pass.
Linux SDK fixture execution is still pending at this source-preparation point;
it must not be inferred from unit tests or the prior filesystem canary. No
authenticated request, materializer, registration or workflow activation is
performed by these helpers. The source-data contract remains unqualified until
its exact reviewed runtime evidence is accepted separately.

The first Linux success case at b1978e69 failed before SDK construction or any
HTTP request. Evidence: teetime-fs-6c00314aad99/result.json, image
sha256:f1c3f260bc750e68b69a8439e1b80e59cd1a92e195392811e43e320cdfa9c2fe.
Cleanup passed; auth/workspace remained unchanged. No duplicate case was run.
Exact-source hosted CI39130185734 passed separately. An import-only local check
reproduced MODULE_NOT_FOUND from CommonJS resolution of the import-only SDK;
ES-module resolution loaded the actual Codex constructor. The fixture now uses
that resolution and fixed initialization phases/allowlisted error categories.
No raw errors, stacks or environment values are emitted. Another runtime run
requires separately reviewed source and exact CI; the failed case is retained.

## Trusted complete-candidate transfer candidate

The next source-only slice is teetime_materialization_frame.py and
teetime_materializer.py. It is not connected to dispatch or publication.
encode_frame/decode_frame use a canonical ASCII JSON frame, at most12 MiB,
with strict duplicate/field/type/base64 validation. Complete candidate files
remain bounded to128 files,1 MiB/file and8 MiB total. Encoder and decoder
independently recompute manifest SHA-256 and Git tree identity, comparing both
against trusted controller inputs. Binary files and executable modes survive.

The Linux UID1001 writer reads bounded stdin, validates all records first, then
requires a new empty owned root. It creates descriptor-relative nofollow/exclusive
files, handles short writes, sets modes explicitly and fsyncs files/directories.
It never reads model workspace files. Any failure invalidates the entire volume;
the caller must discard it, never resume partial materialization. No cleanup or
exclusive writer custody is established by this helper itself.

Fixed future worker invocation (not a runtime admission command):

```text
python3 -I /app/scripts/staging/teetime_materializer.py --manifest-hash <trusted-sha256> --source-tree <trusted-git-tree> < complete-candidate-frame.json
```

The source root is fixed to /candidate. There is no arbitrary root, executable,
test command, dependency installation, model call or repository publication.
Required tests are test_teetime_materialization_frame.py (pure) and
test_teetime_materializer.py (Linux UID1001; skips do not qualify it).

STOP POINT: a separately reviewed lifecycle must remove the normally exited
sole writable container and verify all volume references before readonly testing.
The fixed test-worker command/output, actual EROFS write denial, independent
before/after complete identities and bounded receipts are not implemented here.

The separate image-owned teetime_materialization_check.py source now implements
complete inventory/content/mode verification and fixed fixture assertions without
importing or executing candidate code. It checks before/after manifest/tree IDs
and requires an actual EROFS response to an attempted source write. Its six Linux
unit tests include extra/missing files, links, metadata directories, byte/mode
drift, actual writable-root rejection and mocked error categories. Mocked EROFS
does not prove a real readonly mount. Descriptor traversal assumes the controller
has already removed every writer and inspected that mount; it grants no custody.

Source invocation for the future fixed fixture test worker:

```text
python3 -I /app/scripts/staging/teetime_materialization_check.py --manifest-hash <trusted-sha256> --source-tree <trusted-git-tree> < complete-candidate-frame.json
```

The future operator must reject frames above65536 bytes before resource creation,
because its existing bounded subprocess transport has that smaller input limit.
This fixed small fixture does not qualify12 MiB operator transport. Writer removal,
exclusive volume lifecycle, real readonly mount, process-status receipts, watchdog
failure cases and actual Linux runtime remain separate qualification gates.

The808e1579 diagnostics-only runtime case also failed. The container stopped with
exit1 and no stdout; cleanup passed. Receipt: teetime-fs-4ec83cce2a2e/
execution-failure.json. Exact-source CI39130869507 passed separately, including
the required Linux writer tests. No duplicate, authenticated or successful SDK
qualification result is inferred. Both failed runs remain in the audit record.

The next diagnostics source moves logger import inside the protected block and
snapshots both SDK exports before installing the mock, avoiding a live-namespace
spread. That mock interaction is a hypothesis, not a proven cause of the failure.
teetime_fixture_diagnostics.py consumes bounded ASCII newline-delimited records,
strict ordered phases and one exact final result. It rejects duplicate keys,
unknown fields/phases/error categories, incomplete/oversized records and results
after termination. Nonzero/unknown process exit cannot accept a valid final.
Timeout, queue deadline, process failure and malformed protocol emit one fixed
failure receipt with the last validated phase; raw stderr/errors are discarded.
Budgets and acceptance criteria are unchanged. Eleven pure synthetic protocol
tests pass. Preparing this source does not authorize another runtime attempt.

The fixed --artifact-import-only selector prepares an initialization diagnostic
with no HTTP server, auth file, provider construction, thread or query. It loads
the real logger, policy, SDK, explicit saved-export mock and actual factory module.
Ordered phase records end in a separate import-only-result schema. That marker
never grants artifact acceptance. The same frozen source/image/helper checks,
networknone, metadata masks, nonroot/readonly worker, bounds and cleanup apply.
The worker checks HOME/workspace remain unchanged. Invocation after separate
source/runtime review and exact CI/image qualification:

```text
python -I probe-teetime-filesystem.py --docker <operator-docker-path> --image sha256:<exact-image-id> --expected-sha <base-ARCHON_BUILD_SHA> --artifact-import-only --artifact-source <exact-artifact-commit> --pids-budget 128
```

Source1d28e81d0d3ffcb2c299b663974d24cd6bcd6d88 passed exact hosted CI39131304783,
including the six Linux checker tests. This is distinct from actual Docker
readonly mount or complete materialization qualification, which remain pending.
