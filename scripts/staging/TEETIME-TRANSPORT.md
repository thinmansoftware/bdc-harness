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
bun test packages/providers/src/codex/restricted-canary-transport.test.ts
bun test packages/providers/src/codex/restricted-provider.test.ts
bun test packages/providers/src/codex/restricted-run-factory.test.ts
bun test packages/providers/src/codex/restricted-sdk.test.ts
bun test packages/providers/src/codex/provider.test.ts
bun --filter @archon/providers type-check
```

## Provider entrypoint

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
app CI/CD and preview/rollback proof. Demo implementation remains on hold pending
Sean's feedback and John's scope confirmation.
