# Tee-time non-query thread-start diagnostic - preparation plan

Status: SOURCE DESIGN ONLY. No new runtime attempt is approved by this document.
Parent: bdc-xo#3332. No Claude/Fable, real auth, model turn, app build or admission.

The last reviewed full fixture at4a7ef3d3697621e8a3d5ace75440240fa7a093fb
failed thread/start in CI39152721524, before any observed HTTP or SDK event.
The complete854-byte stderr had no recognized nested cause. Stop extending that
classifier or repeating the full-query fixture automatically.

## Approved source-design direction

Prepare a separate native app-server initialization plus ONE thread/start,
matching the pinned exec parameters/capabilities as closely as source permits.
Document unavoidable in-process/stdio differences. No turn/start, prompt, resume,
model response server, SDK query or tool request. Preserve exact restricted config,
catalog and synthetic-only auth in the inspected owned network-none container.

Pinned source: openai/codex b1a547b1f73ce86205d9222ac19cff334b3b7a2e,
exec/src/lib.rs:1177-1204 and app-server request_processors/thread_processor.rs.
Config/read success does not prove thread/start configuration/trust reload success.
Do not alter permissions/login policy to make creation pass.

## Storage boundary

Live repository metadata verifies bdc-harness is PUBLIC and bdc-xo PRIVATE.
Raw structured RPC error data must never enter public harness CI logs/artifacts.
Only pure source tests run by default there.

The private writer requires a fresh runner-owned 0700 parent inaccessible to the
container and concurrent untrusted host actors. Ancestor-replacement attacks on
an adversarial shared filesystem are outside this diagnostic's storage contract.

A proposed dispatch-only private XO diagnostic workflow may check out the exact
reviewed public harness SHA with pinned actions/persist-credentials:false and
read-only permissions. It must independently fail closed on repository visibility
and literal source identity, pass no GitHub token/host environment/Docker socket
into the container, and use the existing owned confinement/cleanup controls.

Retain one bounded strict RPC error packet in a fresh owner-only RUNNER_TEMP
directory, exact file mode600, no symlinks/overwrite or directory/glob upload.
Raw data must not be echoed, included in exception text, cached or posted to PRs.
Only that exact validated file may be uploaded with minimal private retention,
after rechecking private visibility. Authorized repository users can access private
artifacts; do not describe them as operator-exclusive. Download read-only into
the local audit workspace and treat all contents as untrusted data.

Public metadata may include only fixed kind, hash/length/RPC code, source/image
identities and cleanup outcome. No model verdict, passed:true or approval follows
from a captured startup error or successfully created diagnostic thread.

## Implementation and review sequence

1. TDD a pure strict packet validator/metadata projector and exclusive private
   writer. Cover duplicate/extra keys, byte/depth/Unicode bounds, error vs success,
   arbitrary data remaining private, foreign output path/symlink/overwrite and
   owner-only permissions where the OS can actually enforce them.
2. Add the separately bounded non-query worker, explicitly closing/reaping its
   child after the one response. Reuse pinned catalog and existing isolation.
3. Extend only the governed probe kind/controller path needed for private capture.
   Preserve all existing reviewer/default behavior and failure cleanup.
4. Prepare the private XO dispatch workflow without running or activating it.
   Pin actions, harness source and private artifact path/retention; cleanup remains
   independent of upload or collection success. No automatic retry.
5. Independently review concrete code, packet transport/storage, exact case and
   private workflow before publication or one separately approved execution.

No runtime execution, workflow creation/activation, account transfer or foundation
admission is authorized by the source-design review itself.

## Frozen identities and source notes

Read-only npm package inspection verified the bun.lock SRI for
@openai/codex@0.153.3-linux-x64. The129261109-byte package has SHA-512 base64
CyLvuM9Ij7sQuNtnHrzHtF+DtNISaauZZakyhy+MoFS1XxKTGv3FN4/qh6c94YZtLStZ7aUmfYQz59V3PV4zng==.
The package/vendor/x86_64-unknown-linux-musl/bin/codex entry is258638944 bytes,
SHA-256 f9d4eab23d0e0726340e084ed22d668885c1dcabeb29ec508b8962e5e29b8dc6.
The package was inspected, not installed or executed on Windows.
The derived complete restricted catalog is SHA-256
e5a56e880294de40cfd546abc67943839247ef41f9fea095c6ffc93ca4f53e14.
The controller independently checks both frozen hashes before retention.

The app-server stdio InitializeResponse must have exactly userAgent, codexHome,
platformFamily and platformOs. Require the fixed home and unix/linux, plus the
bounded printable-ASCII compiled-version prefix and client suffix. The native
environment excludes CODEX_INTERNAL_ORIGINATOR_OVERRIDE; user-agent text alone
does not attest executable identity.

Pinned source links:
- https://github.com/openai/codex/blob/b1a547b1f73ce86205d9222ac19cff334b3b7a2e/codex-rs/app-server-protocol/src/protocol/v1.rs#L68
- https://github.com/openai/codex/blob/b1a547b1f73ce86205d9222ac19cff334b3b7a2e/codex-rs/app-server/src/request_processors/initialize_processor.rs#L94
- https://github.com/openai/codex/blob/b1a547b1f73ce86205d9222ac19cff334b3b7a2e/codex-rs/login/src/auth/default_client.rs#L164

Equivalence limits: native app-server stdio initialization is not exec's internal
SessionSource::Exec server, which enables CODEX_API_KEY environment handling
internally. This reproduction supplies the same fixed synthetic auth file and a
closed native environment with a synthetic CODEX_API_KEY. Its fixed loopback
endpoint has no response server. A diagnostic thread success does not qualify
SDK transport or reviewer operation. No history fallback/retry is permitted.
