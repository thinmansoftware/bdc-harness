# Tee-time canary transport candidate

Governance: bdc-xo#3332, WO-HARNESS-TEETIME-CONFINEMENT-01.
This is an unregistered staging candidate. It does not admit a lane, run a model,
authorize production, or start the tee-time demo. Claude and Fable are excluded.

## Credential-free invocation

From a disposable receipt directory on the staging Docker host:

```text
python path/to/run-teetime-transport-probe.py --docker path/to/docker --image sha256:EXACT_IMAGE --expected-sha EXACT_BUILD_SHA
```

Keep teetime_connect_proxy.py beside the launcher. Python 3.11+ is required.
The image must contain Python with a working trust store and carry the matching
ARCHON_BUILD_SHA. No credentials are supplied. The launcher creates uniquely
owned internal and egress networks and two restricted containers, verifies their
configuration, runs a TLS and destination-denial probe, then removes its resources.
Receipt files contain network identities, source hash, sanitized outcomes and
cleanup results. Nonzero exit or nonempty cleanup errors fail this qualification.

Add `--sandbox` to verify pinned CLI 0.153.3 sandbox child and nested-child denial
against the actual proxy. Keep probe-teetime-proxy-sandbox.py and the three
codex-probe/moby seccomp policy files beside the launcher. The worker uses owned
tmpfs and read-only project config masks. A successful unsandboxed curl control
is required before denial can pass. Curl's CONNECT User-Agent is suppressed to
match the strict header allowlist; the proxy itself is not weakened.

Laptop run teetime-transport-cc92f0d50f5a passed both child denial checks and the
control on the prior pinned e9d8d071 image, with cleanup errors empty. Earlier
attempts stopped at the curl control and do not count as isolation passes.
This proves CLI sandbox confinement for these probes, not CLI application HTTP
compatibility or the forthcoming credentialed worker lifecycle.

Add `--metadata` together with `--sandbox` for the pinned CLI's negative remote
metadata check. Keep probe-teetime-cli-metadata.py beside the launcher. It creates
an unmistakably invalid synthetic login in owned tmpfs, initializes app-server,
and calls only account/rateLimits/read. A terminal 401/unauthorized response is
required; no thread, turn, execution or inference request is sent. The child
process group is killed on exit and the synthetic auth file is removed. This
mode must never be adapted to accept real credentials or retain account output.

Laptop run teetime-transport-0522566710b0 passed this check together with the
sandbox controls. It used the prior e9d8d071 image and reported no cleanup errors.
This verifies CLI metadata transport, not successful authentication or inference.

The worker has only the internal network. The gateway accepts only CONNECT to
chatgpt.com:443 and connects to a validated public IPv4 address without a second
hostname lookup. It neither decrypts TLS nor logs payloads. The first-byte check
rejects obvious plaintext; it is not TLS or SNI validation. CLI certificate and
hostname verification must remain enabled. Header, connection, byte, idle and
five-minute process limits bound the probe.

## Source tests

Run each Bun command as a separate process. SDK mocks are global and contaminate
the real-SDK synthetic executable test if combined into one invocation.

```text
python -m unittest discover -s scripts/staging -p test_teetime_connect_proxy.py
python -m unittest discover -s scripts/staging -p test_teetime_auth_receiver.py
bun test packages/providers/src/codex/restricted-canary-transport.test.ts
bun test packages/providers/src/codex/restricted-provider.test.ts
bun test packages/providers/src/codex/restricted-run-factory.test.ts
bun test packages/providers/src/codex/restricted-sdk.test.ts
bun test packages/providers/src/codex/provider.test.ts
bun --filter @archon/providers type-check
```

## Credential receiver candidate (not integrated)

teetime_auth_receiver.py is a receiver candidate for a future inspected worker.
It is not an operator-host command and must never run on the desktop. It accepts
only stdin, requires Linux uid1001 and the exact home tmpfs mount, creates a fresh
0700 directory and exclusive0600 file, rejects alternate credentials, duplicate
JSON keys and nonfinite/near-expiry access-token claims, and prints only a boolean
receipt. An expiry claim is a precondition, not JWT signature verification.
The ten-second alarm raises a controlled exception so failure cleanup executes.

The actual receiver subprocess can be tested with synthetic data only:

```text
python scripts/staging/test-teetime-auth-receiver-linux.py --docker path/to/docker --image sha256:EXACT_IMAGE
```

The test creates an owned no-network container and destroys it afterward. Seven
Linux cases passed on the prior pinned e9d8d071 image: installation/modes/owner,
malformed, oversized, expired, existing directory, symlink, and alarm cleanup.
Four payload unit tests pass. This does not qualify the complete credential
delivery lifecycle. A reviewed launcher must stop all model processes until
receipt, preserve the original login, detect auth-copy changes in memory without
logging hashes, and destroy the credential-bearing container on every exit.

## Independent watchdog candidate

The Windows SSH service can terminate ordinary detached descendants when the
session exits. The first no-auth crash test demonstrated this, leaving the owned
test worker behind; ownership-checked cleanup then removed that worker/network.
The probe now requires CREATE_BREAKAWAY_FROM_JOB as well as detached/new-process
group flags. It must fail before credentials if process creation is rejected.

```text
python -m unittest discover -s scripts/staging -p test_teetime_watchdog.py
python scripts/staging/probe-teetime-watchdog.py --docker path/to/docker --image sha256:EXACT_IMAGE
```

This no-auth probe deliberately exits23 after establishing an independent
watchdog. With --disconnect it instead waits so the operator can terminate the
SSH client. The watchdog accepts exact full resource IDs and an owner label,
binds READY to the manifest hash, publishes READY atomically, converts its fixed
deadline to monotonic time, and records verified cleanup or explicit failures.
The launcher checks watchdog liveness and remaining time before trusting READY.

Laptop crash receipt teetime-auth-c1b98684e369 and separate killed-SSH receipt
teetime-auth-1afd56fe0496 both reported cleanupVerified true with no errors.
Fresh Docker listings confirmed each worker absent. Both used a sleeping worker
on the prior e9d8d071 image and no credentials or Codex model. Six unit tests pass.

The watchdog deadline is when cleanup begins, not proof of deletion at that
instant. The credentialed launcher must reserve cleanup time within its total
five-minute budget. Docker unavailability is a containment failure, never green.
This standalone watchdog is not yet integrated into an authenticated launcher.

## Local staging image derivative

```text
python scripts/staging/build-teetime-derivative.py --docker path/to/docker --repo path/to/checkout --base-image sha256:EXACT_BASE_IMAGE --base-sha EXACT_BASE_COMMIT --target-sha EXACT_TARGET_COMMIT
```

The target commit must already be present in the checkout object database. The
helper accepts only regular-file additions/modifications under the canary paths,
copies exact Git blobs, checks the base image's source identity, and verifies each
changed file's hash in the result. The local base tag is unique, checked against
the immutable image ID before/after build and removed afterward. No registry
login, base pull, dependency change or checkout switch is performed.

Target824479580affab678310ef066b98f538a6373a6c produced local derivative image
sha256:d13e1c6075b547f9dc638ef647d98d9124727dba4c8129ad461a324ea281b55c.
Receipt: teetime-derivative-824479580aff-9a0316. The helper itself was supplied as
an operator-side candidate for this build. This is a local derivative, not the
full hosted CI image, and has not performed an authenticated canary.

## Provider entrypoint contract

createRestrictedCanaryWorkerProvider is a dedicated, unregistered entrypoint.
Its constructor-owned teetime-connect-v1 transport fixes HTTP_PROXY and HTTPS_PROXY
to http://teetime-proxy:3128. Callers cannot select an endpoint or inherit host
environment. The offline default is unchanged. Resume is rejected at both factory
and direct provider boundaries. Harness subprocess retries and harness auth
refresh are disabled for this transport. This does not prove absence of internal
CLI request retries or auth recovery.

## Evidence and remaining gates

The credential-free laptop probe teetime-transport-dddb9f18e443 succeeded against
image sha256:08a9be651cffe7d5958899cbbd413ef05f33f16aee9c178962b71768abc8f979,
build e9d8d0715c309a8d061290c9f6ffa2caf502a9d0. It verified TLS, rejected four
forbidden authorities, and denied direct worker connection to 1.1.1.1:443.
It does not prove all private/host routes are denied or pinned CLI compatibility.
The proxy source hash was
ae7e31bd30bbce054dab9272b253060b2366e09e4fc87918f94dc269223aae85.
The launcher reported no cleanup errors. This image predates the new TS changes.

John authorized existing Codex login reuse for the isolated canary. No credentials
were transferred for this probe. Before any transfer, qualify the pinned CLI and
sandboxed child/nested-child denial against the actual proxy, inspect CLI retry
and refresh behavior, and review the concrete receiver and effective managed
configuration checks. Deliver auth only through nonlogging stdin into owned tmpfs;
never host staging, argv, environment, image, repository or receipt files.
Require access-token validity beyond 30 minutes immediately before delivery and
bound the run to five minutes. Deny auth.openai.com, stop on auth failure, do not
sync back or change the desktop login, and compare disposable auth in memory.

Separate outstanding gates include immutable evidence capture, approval validation,
plan review, policy/workflow registration, trusted publication, end-to-end canary,
app CI/CD and preview/rollback proof. On October 18 John instructed this session
to continue until the demo is ready for verification. This supersedes the prior
demo implementation hold; all admission gates and simulation-only bounds remain.

## Authenticated launcher candidate

The complete launcher is a source candidate until the exact-image rehearsal and
independent review pass. It is not a registered general-purpose builder.

```text
python scripts/staging/invoke-teetime-auth-canary.py --image sha256:EXACT_IMAGE --expected-sha EXACT_COMMIT --synthetic
python scripts/staging/invoke-teetime-auth-canary.py --image sha256:EXACT_IMAGE --expected-sha EXACT_COMMIT --disconnect-before-auth
python scripts/staging/invoke-teetime-auth-canary.py --image sha256:EXACT_IMAGE --expected-sha EXACT_COMMIT
```

Operator files must be installed at the existing BDC laptop's
teetime-config-diagnostic directory, with the same reviewed helper bytes as the
image. The SSH host is fixed to bdc-server and known-host checking is mandatory.
The real invocation reads only the existing desktop .codex/auth.json after READY
validates exact image/source, nonce, resource IDs and helper hashes. It neither
copies that file to a host path nor updates it. Binary framing rejects partial,
oversized, trailing or duplicate data. The receiver installs into worker tmpfs.

The remote controller inspects isolation and arms the breakaway watchdog before
READY. Docker logging is disabled. The watchdog starts cleanup at 210 seconds;
the model call has its own 90-second abort and 100-second process cutoff. Raw
authenticated subprocess responses stay in bounded memory; only allowlisted
booleans and invocation counts are reported. Both source and disposable auth
bytes must remain unchanged. Any cleanup failure fails the canary.

Preflight checks the pinned CLI, effective restricted profile, empty extension
catalogs, account/read with refreshToken false and authenticated rate-limit
metadata. One factory invocation may create only canary.txt with fixed content.
The trusted wrapper checks file type, exact content and directory membership.
Served-model identity is explicitly unverified because this SDK does not expose
it. Synthetic invalid auth must fail before any model invocation and still clean
up. This task does not implement the app or publish any artifact.

The first real-login attempt, teetime-auth-3e7f2a65698d on source76c8bc40,
passed all six authenticated preflight checks but failed the task stage. Its
disposable and original authentication remained unchanged and cleanup verified.
This remains a FAILED canary. No raw authenticated diagnostic was retained.

Source inspection then found the task rejecting the provider's normal successful
file-change message and requiring a sessionId captured before fresh-stream
initialization. The corrected task accepts only the exact single canary-path
success notification, preserves normal terminal/error checks, and uses Pino's
actual silent level before creating provider child loggers. It reports only fixed
failure categories. The wrapper checks the artifact independently on failures;
overall success still requires every preflight, task, artifact and auth check.
These source defects do not prove the first attempt's sole failure cause.

The second attempt, teetime-auth-05fc79cd2196 on source332a08c0/image3042606f,
also passed preflight/auth preservation and cleanup but failed on an unexpected
system notification, before a verified artifact. Its receipt does not distinguish
task progress from failed file changes. It remains FAILED, not an approval.

The next candidate classifies rejected system events using fixed categories and
independently reports artifact existence/type/content, workspace entries and
accepted terminal count. Known task-list progress is discarded as data after a
test through the actual provider normalizer. Warnings, failbacks, extra file
changes and invalid terminals still fail. No raw diagnostics leave the worker.

The third attempt, teetime-auth-1f4d051e7e44 on sourced9c31e4e/image42e48cf2,
passed all six preflight checks and preserved authentication and cleanup, but
reported provider_failed with no accepted terminal or verified artifact. The
receipt did not identify an abort, proxy failure or resource cause. Duration
alone does not establish which limit was reached. This remains FAILED.

The diagnostic candidate reports the actual abort signal, bounded task elapsed
time, fixed exception hints and cgroup OOM-kill delta (null when unavailable).
taskDiagnosticsPresent distinguishes missing task output from an actual receipt.
The gateway emits fixed readiness and final traffic counters through bounded
capture; no payloads, request headers or raw errors are retained. Its immutable
source bytes are checked before credential READY. SIGINT shutdown must produce a
quiescent counter receipt, and the capture thread must stop after owned cleanup.
Traffic rules, model settings, budgets and canary acceptance remain unchanged.
Independent review authorizes commit and synthetic rehearsal only at this point;
another model request requires review of those exact-image rehearsal results.

No-auth apply-patch receipt teetime-patch-c5064e868c60 resolves a misleading
success report: the helper created an outside-looking path in a private sandbox
filesystem (device145), not the original HOME (device155). The original file was
absent, synthetic auth unchanged/invisible, shell HOME/tmp writes denied, and the
workspace contained only the exact canary file. This used constructor-generated
policy overrides on image3042606f. An earlier exit-code-only interpretation as an
original-HOME write was incorrect; no filesystem-policy expansion was applied.
The operator probe is scripts/staging/probe-teetime-apply-patch.py and uses no auth
or model. It is a diagnostic, not an admission gate based on helper exit alone.
