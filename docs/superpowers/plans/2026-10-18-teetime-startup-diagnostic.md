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

## October 19 source correction after capture39235275411

That one approved capture failed before retaining a private packet. Its finite
grant is consumed. Cleanup passed; no actual native ThreadStart boundary or cause
was established. The separate reviewer fixture39232400259 also remains failed;
this correction does not explain that fixture or the authenticated diagnostic.

The startup wrapper incorrectly required synchronous Bun signalCode to be null.
Bun1.3.11 declares SyncSubprocess.signalCode optional; a harmless local Bun1.3.13
child successfully exiting0 has that field absent. The regression failed against
the old guard. Accept only null/undefined no-signal with success:true, exit0,
no timeout/buffer-limit flag and the unchanged combined output-byte bound.
The same harmless regression must pass under CI's pinned Bun1.3.11. References:
https://github.com/oven-sh/bun/blob/bun-v1.3.11/packages/bun-types/bun.d.ts
https://bun.com/reference/bun/SyncSubprocess/signalCode

Failure-v2 adds only a fixed current-phase enum, emitted independently of dynamic
imports. It indicates the observed operation boundary, not the cause or proof that
initialization/reaping completed. Python strictly validates the nonzero-exit frame
before any public projection; malformed/unknown output yields a generic phase.
No raw error, stderr, RPC value, path, stack or arbitrary property is published.
The successful private packet remains version1 and its custody/schema are unchanged.
A failure frame never becomes a successful capture or private upload.

Offline regressions cover the actual harmless synchronous child, termination and
output limits, context/import failure through the real stdin entry and independent
Python validator, synthetic initialize/thread-start boundaries, private-marker
rejection and cleanup uncertainty. No Codex executable is started by these tests.
No native capture, account delivery, turn/query, fallback, policy relaxation,
implementation attempt or production action is authorized by this source change.


## Consumed capture 3 and closed rejection evidence successor

Run39239917881 at XOactivation87ab8b87cecab469cb4d789c7115626067224c99
and helperd5e1f8d33b76eb0e699e8f674e296687c3e23d05 failed at the fixed
thread-start-exchange boundary. Owned cleanup passed, private artifact count0.
That finite grant is consumed. This proves initialize validation reached the
callback before writing thread/start; it does not prove the write completed,
thread creation began, or a particular native error occurred.

An offline actual-parser replay reproduces a coverage gap: valid configWarning
between initialize and response2 is rejected, while the same sequence without it
succeeds. Pinned upstream b1a547b1f73ce86205d9222ac19cff334b3b7a2e emits
ConfigWarning during initialization (initialize_processor.rs161-179), declares
wire method configWarning (protocol/common.rs1928), and its notification shape
in protocol/v2/config.rs1117-1130. This is a supported hypothesis, not the observed
cause. Do not broaden accepted notifications or alter native settings on that basis.

Independent architect approved source implementation/offline tests only. Add
internally branded fixed rejection categories to the existing protocol file:
write, utf8-json, notification-shape, response-envelope, response-payload,
output-bound, eof-incomplete, deadline, stream, unknown. Preserve only internal
brands, never arbitrary error names/messages/properties/causes. Keep the first
observed primary category; cleanup uncertainty cannot erase it.

The failure-only observer is finalized once after bounded cleanup. It receives a
snapshot with category, response2Observed, acceptedNotifications, observedBytes
and reapUncertain. A parsed object with exact numeric id2 establishes observed,
not accepted. Count notifications only after existing validation; at most1 is
accepted. Byte count saturates65537, which means at least65537, not exact length.
Cleanup-only failure uses unknown/reapUncertaintrue and cannot return success.
Late streams cannot mutate emitted evidence; a throwing observer is contained.

Entry emits strict failure-v3 with explicit exchange:null if exchange evidence
was not finalized, otherwise only this closed metadata. Non-null exchange is
valid only in initialize-exchange/thread-start-exchange phases. The independent
Python projector requires exact keys, known enums, actual bool/int types and
bounds, preserving historical v2 parsing. Invalid packets retain only fixed
unknown metadata, never raw output. Successful private v1 custody is unchanged;
a failed capture still cannot create/upload a successful private artifact.

TDD first demonstrated missing observations and unsupported v3 frames. Offline
coverage includes configWarning rejection, malformed envelopes/payloads/UTF8/JSON,
EOF, overflow, writes/streams, no spoofed category, uncertain reaping, observer
failure, late settlement, and existing deadline/private RPC error behavior.
Synthetic stdin main replaces native preflight/spawn only in the test fixture,
then uses the actual exchange/emitter and independent Python parser. No native
Codex executable, account, query, provider or booking is involved in these tests.

All request payloads, models, auth, confinement, limits, timeouts, fallback policy
and successful packet paths remain unchanged. No new runtime helper dependency.
Source publication needs actual independent review and checks. Any later native
capture needs separately reviewed activation and a fresh finite execution grant.
No authenticated diagnostic or fifth implementation attempt is authorized here.


## Pinned ConfigWarning conformance correction source plan

Actual capture39245375824 at activation401e556d24b67e1bc3c1c7cfdea9ecab502844aa
and helper91cf085976aa630f55f318025e2e276666f0a61b failed with v3
thread-start-exchange/notification-shape, response2Observedfalse,
acceptedNotifications0, observedBytes1846, reapUncertainfalse. Owned cleanup
passed and artifact count0. Its finite grant is consumed, no retry authorized.
This proves local notification rejection, not that configWarning was received.

The independent replay and pinned native protocol establish a separate real
conformance gap. The independent architect approved source preparation and offline
tests for a narrow correction, without another metadata-only capture first.
Warning text must remain privately inspectable: a count alone could conceal a
configuration warning needed to interpret the eventual thread-start result.

Reuse StartupProtocol. Accept only method configWarning during the existing
thread-exchange state with a validated closed notification envelope. Parameters:
summary:string, details:required string|null, path:optional string, range:optional
object with exactly start/end positions. Each position has exactly line/column,
positive safe integers per the pinned 1-based documentation. Do not invent a
position-ordering rule. Keep unknown methods and malformed shapes rejected.

Permit at most4 warnings and16384 total UTF-8 bytes of retained warning JSON,
within the existing65536 aggregate output bound and unchanged exchange deadline.
Keep thread/started count separate. No request, native config, model, auth,
confinement, resource, timeout, retry or fallback change.

Introduce an explicitly versioned private capture envelope for validated warning
objects and the existing v1 outcome. Reuse v1 validation internally; its exact
fields/meaning and historical reader path stay unchanged. Version public capture
metadata/counters explicitly if changed. Public evidence permits only a fixed
known-warning kind/count, never summary/details/path/range values or arbitrary
method strings. Retain warnings only through validated private custody, with
whole-envelope hashes/byte bounds and unchanged ownership/exclusive-file cleanup.
A warning is neither approval nor proof of configuration correctness or thread
creation. Require private inspection before interpreting captured warnings.

The initial slice should keep failed exchange handling unsuccessful and closed;
no new artifact-on-failure bypass. If response2 cannot be captured and reaped,
absence of a private warning artifact is a limitation, not permission to retry.
Success capture may contain a valid native RPC error, as in the existing design;
it still cannot imply a successful thread or qualify a real account/builder.

TDD: replay warning then valid RPC error/success, null details, omitted optional
fields, complete ranges; reject wrong keys/types, null optional objects, unsafe
integers, count and retained-byte overflow, malformed/unknown notifications.
Verify separate counts and existing bounds, private v1 historical acceptance,
strict versioned envelope validation, no warning text/path in public metadata,
and actual synthetic entry-to-independent-host projection without native code.

Source publication needs independent actual-diff review and new exact CI. Any
later activation and single native capture require their own recorded review and
fresh finite exact-case approval. No account, query or implementation attempt is
authorized by this source plan. The full simulated demo remains the goal.


### ConfigWarning source verification

TDD observed the existing protocol rejecting valid ConfigWarning, the absent
independent v2 validator, and the actual private emitter failing the new host
projection before implementation. Local verification after correction:
26 Bun tests /256 assertions passed;13 packet tests passed with3 POSIX-only
skips on Windows;10 control tests passed with1 POSIX-only skip. Scripts TypeScript
check exited0. Changed code ASCII and git diff whitespace checks passed.

Independent Codex intake_architect inspected all8 changed files against91cf0859
and approved SOURCE PUBLICATION ONLY, no required findings. Reviewer did not
rerun tests. New exact CI must establish actual Linux/POSIX custody results before
activation review. No native capture, account operation, dispatch or retry was
approved or performed. Failed-exchange v3 counters retain their prior meaning:
acceptedNotifications counts thread/started only, never configuration warnings.


## Controller interruption evidence and proposed bounded source correction

Consumed run39250421265 at activationdeb12f8ea30c2afcc61e8e847d6eac4c9485a5ad
and helper42e1755b49a0aaa11f01058a6e1ac9619cb3ce49 ended FAILURE. Actual source
validation and image build passed, imagee387ac2d96367a81f68daa660024389f8a61b8c0f53cb0e9e6d44131e0f86b2f.
Shell reports the host Python controller Killed, exit137, about103 seconds into
capture step. No controller/native receipt, zero artifacts. Always-cleanup and
post steps were skipped. Original hosted runner is inaccessible; owned resource
absence is UNVERIFIED. Run/job annotations establish only137, not OOM, timeout,
parser progress or native cause. Do not infer absent counters are healthy.

Independent architect inspected source and evidence: first flushed receipt is
after attach/inspect; individual Docker calls have120s bounds without one overall
controller deadline. SIGKILL prevents Python finally; workflow always cannot
promise cleanup if the runner cannot continue. No retry is approved.
Oracle lookup found no directly applicable controller/137 contract or prior fix.

Proposed source-only slice, pending prebuild review:

- Extend existing teetime_startup_control.py with StartupController, used only
  by startup route of run-codex-sandbox-probe.py. Preserve private-context check
  before any controller/Docker work; leave other probe routes unchanged.
- One monotonic120s main-operation budget plus reserved30s cleanup window,
  absolute cutoff at start+150s; cleanup deadline is min(entry+30s, absolute).
  Each subprocess gets at most its old120s Docker or90s attach cap,
  further limited by remaining phase budget minus5s reserved owned-child reaping.
  Reject exhausted budget before spawning. Cleanup switches to the reserved
  window in finally and cannot claim success without actual removal/readback.
  Native exchange12s/reap5s, auth/config/resource/output/policy remain unchanged.
- Startup Docker calls use existing bounded capture with131072 host-command
  output cap; attach retains65536. No change to shared capture implementation.
  Command classification has fixed known kinds only: image inspection, create,
  inspect, start, attach, owned inventory/remove. No arbitrary command text public.
- Flush closed milestones BEFORE/AFTER or fixed failure for every blocking
  startup host operation. Fixed kind/phase/edge, bounded elapsed time, exact
  owner and generated container name, optional bounded int exit status only.
  No raw stdout/stderr/native packet/arguments/image environment or errors.
  Bounded event count. A missing end receipt is uncertainty, not a completed
  command, successful cleanup or a native-stage diagnosis.
- Bounded host counters before creation and after attempted cleanup: fixed
  MemAvailable, filesystem free bytes and visible-cgroup oom_kill count only.
  Missing/unreadable/malformed values are null, never healthy or OOM evidence.
  State visible scope; no arbitrary paths/environment, process or customer data.
- TDD with synthetic child/fake Docker operations: milestone precedes spawn,
  blocked command, shared-deadline exhaustion, attach timeout/output overflow,
  cleanup reserve and failure, unknown command/phase, public redaction, and
  synthetic controller termination. No native Codex/account/container run.
- Existing control test discovery supplies offline CI; no new trigger or native
  execution. Source publication needs actual diff review/new CI. Later activation
  and any one capture require separate exact-case review. Keep historical cleanup
  UNVERIFIED; never use a new host to claim absence on the old runner.


### Controller source implementation verification

Prebuild architect approved source/offline work with anchored deadlines, outer
cleanup protection before first Docker command, bounded telemetry/event count,
visible-controller cgroup scope, and no invented status for uncertain reaping.
These clarifications are implemented in the existing startup control module and
startup-only runner route; other probe routes/shared capture remain unchanged.
At most64 milestones of1024 bytes, bounded owner/name and elapsed/exit scalars.
Telemetry missing/malformed/unreadable values remain null; logging failure stops
new main work but cannot prevent owned cleanup. Cleanup status reflects actual
owned inventory/removal checks, not process termination or a finally intention.

TDD observed absent controller class, first Docker failure bypassing outer
cleanup, and unbounded public owner identity before correction. Synthetic tests
exercise blocked/overflowing Python children and their reaping, terminated fake
controller with a flushed start/no completion, deadline exhaustion, cleanup
reserve exhaustion, observer failure, and uncertain creation with exact owned-ID
reconciliation before removal. No native executable/container/account was run.
Local22 control tests passed with1 Windows POSIX-only skip;13 packet tests with3
POSIX-only skips,9 bounded process tests and9 reviewer probe tests passed.
Historical run39250421265 cleanup stays UNVERIFIED and grant consumed. No new
runtime approval follows. Source publication needs independent actual-diff review.


Independent actual-diff review approved SOURCE PUBLICATION ONLY with no blocking
findings. Clarification:150s bounds startup-controller subprocess budgets; it is
not a hard whole-process deadline. Synchronous telemetry/logging and the existing
post-cleanup private-context check are outside this enforcement. No SIGKILL-safe
wall-clock or cleanup guarantee is claimed. Source review did not rerun tests;
new Linux/POSIX CI is required. No activation or execution grant is conveyed.


### Resource-precondition correction after capture 39254781844

Capture39254781844 is terminal failure/exit137. Container create, inspect and
start completed; attach started at855ms, without an end receipt before the host
controller was killed. Precreation MemAvailable177405952bytes is about169MiB.
DiskFreeBytes4970270720 and visible-cgroup oom-kill count null do not prove an
OOM cause. No native result/private artifact; cleanup remains UNVERIFIED.
The finite capture grant is consumed; this source increment authorizes no retry.

Independent prebuild review approved source-only startup headroom checks inside
the protected block: before first Docker command and again immediately before
create. Provisional floors are1536MiB memory (worker768MiB plus768MiB allowance
for controller/daemon/runner) and2GiB disk. These are admission floors, not
demonstrated sizing, reserved resources, production capacity or an OOM guarantee.
Disk uses the runner root filesystem; it does not claim to measure a separately
mounted Docker data root. Samples are non-atomic and cannot reserve resources.

Effective memory is the minimum of MemAvailable and every supported finite
ancestor's max(0,memory.max-memory.current). The read-only collector supports a
single cgroup2 hierarchy mounted at/sys/fs/cgroup with root/ and an exempt root
without memory.max. It requires the memory controller; root cgroup.type is not
required because the kernel exposes that file only on non-root cgroups. Other
layouts, hidden roots, duplicate/overlaid mounts, v1, symlinks, malformed/missing
descendant counters or unknown measurements fail closed. This is a supported
layout check, not general proof that namespace virtualization is impossible.
Membership and mount records are read again after collection; changes reject.
At most32 ancestors; fixed ASCII inputs/read bounds and safe decimal integers.
Unknown never becomes zero or unlimited. Known exempt/unlimited paths use a
safe-integer ceiling only after complete supported-layout validation.

The gate emits only closed resource-gate start/end/failure milestones. Logging
failure also stops forward work; existing owned cleanup remains available.
Historical cleanup is not inferred from these offline tests. Tests cover exact
floors/one-byte-below, unknown/malformed counters, tighter ancestors with unlimited
descendants, usage above limit, root exemption, hidden/duplicate mounts, symlinks,
depth overflow, changing membership/mounts, bounded ASCII reads, logging failure,
and second-check failure preventing create/start/attach while cleanup executes.

The proposed individually owned BuildKit build/teardown is a separate source
correction. No privileged builder, build, native executable, account, workflow
activation or dispatch is authorized by this increment. Existing auth/model,
worker768MiB/no-swap128pids1CPU confinement and command budgets remain unchanged.

Client clarification: this is an MVP demonstration of the planned app, not a
production launch. Prioritize the simulated golfer walkthrough and its stated
approval/price-change/unavailable/uncertain-result behaviors. Defer production
scaling, operational hardening, live integrations and release work. This guard
only prevents repeating a capture on a demonstrably resource-starved runner;
it does not add a production-readiness requirement to demo acceptance.
