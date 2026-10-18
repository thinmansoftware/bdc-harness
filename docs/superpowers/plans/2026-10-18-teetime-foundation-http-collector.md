# Tee-time foundation HTTP collector - unregistered source slice

Parent: bdc-xo#3332. Pre-build review approves source and bounded localhost fixture
tests only. No real app/server qualification, shared-host/laptop resource, container,
account, provider, model, registry, workflow or admission action.

Implement no-argument collect_foundation_http(): fixed IPv4 loopback127.0.0.1:3187,
the nine source-owned checker cases, one request each, no proxy/URL selection,
redirect-following or retry. Use fixed headers and Accept-Encoding:identity.
Check status and header constraints before bounded read1 body reads. Reject short
Content-Length and incomplete chunk framing even after valid expected text.

Freeze supported CPython3.12, recording its actual patch version as data only.
Confirm _MAXLINE65536/_MAXHEADERS100 before any network call; changed limits fail.
These bound prevalidation status/header parsing to approximately6.5 MiB, not total
process memory. The16 KiB/64-header acceptance limits are checked immediately
after parsing; do not claim a16 KiB physical read/allocation cap. No custom parser.

Use one15-second collection deadline and2-second socket-idle ceiling. Connection
establishment uses min(idle ceiling, remaining overall time). After establishment,
each deadline watchdog captures that exact socket object; never an fd or mutable
current-socket pointer. Cancel/join before releasing/replacing ownership. Shutdown
and close on expiry, including status/header/chunk trickles. If the deadline passes
before socket publication, close that later socket immediately and reject.
Response/connection closure runs on all paths; timer cleanup is bounded.

Derive completion from transport state and final checks, never supplied booleans.
HEAD/204 empty returned bodies are http.client observations, not proof of zero
stray wire bytes. Return immutable validated observations and runtime-version data;
no success/approval/admission flags or server-custody claims.

TDD with an owned127.0.0.1 ephemeral fake server only. Patch the constructor to
assert the production endpoint before redirecting to that fixture. Cover normal,
chunked, redirects, short/oversized/incomplete data, bad headers, idle/whole-deadline
trickles, late socket publication and cancellation races, plus connection/timer
cleanup. Ensure fixture threads terminate; do not run the collector unpatched.

## Invocation and evidence

The owning verifier may eventually import collect_foundation_http from
scripts/staging/teetime_foundation_http_collect.py. This source slice registers
no runtime caller or CLI. The only currently authorized invocation is:

`python -m unittest discover -s scripts/staging -p test_teetime_foundation_http_collect.py`

The suite redirects the fixed endpoint to its own ephemeral fixture. Never invoke
the collector directly against a process already listening on3187. It does not
start, identify, attest, terminate or otherwise establish custody of that process.
The final owning verifier must establish that separate trust boundary.

The first run failed because the collector module did not exist. Implementation
then passed the original five fixture tests. Added a real cancellation race,
shared nine-request deadline and sanitized cleanup failures. Timer-start failure
regression initially reproduced skipped cleanup and a lingering fixture thread;
the fix distinguishes unstarted timers and closes resources regardless of timer
cleanup failure. Nine collector tests now pass on local CPython3.12; CI remains a
separate pending result. No native app, canary, approval or admission claim.
