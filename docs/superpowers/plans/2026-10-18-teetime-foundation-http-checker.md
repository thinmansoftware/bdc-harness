# Tee-time foundation HTTP checker - source-only slice

Parent: bdc-xo#3332. Approved pre-build scope: pure checker and tests only.
No CLI, socket, server, container, model, workflow registration or admission.
The separate localhost collector requires its own reviewed source slice.

The source-owned nine-case enumeration follows the actual foundation draft plan:
GET /200 HTML; GET /api/health200 exact status:ok/mode:simulated JSON and no-store;
HEAD health200 no body/no-store; OPTIONS health204 no body/Allow GET HEAD OPTIONS;
POST,PUT,PATCH,DELETE health405; GET /__teetime_missing__404 bounded HTML.

Consume an immutable tuple of closed typed observations: case ID, method, path,
integer status, raw header-pair tuple, body bytes, completed:true,truncated:false.
Require exactly the source-owned case order; reject partial/duplicate/substituted
cases, redirects, transport failure, invalid UTF-8 and ambiguous singleton headers.
Reuse existing strict JSON duplicate/depth checks, accepting legal whitespace and
key order for health JSON. Parse HTTP lists/directives outside quoted strings.
Require an actual no-store directive, not a substring in an extension's value.

Freeze platform limits:64 headers/16 KiB total headers per case; root512 KiB,
missing-page64 KiB, other bodies4 KiB; aggregate1 MiB. The enumerated per-case maxima
already sum below the aggregate ceiling; do not invent an unreachable overflow
test or claim independent branch coverage for that redundant guard.

Root HTML checks only decoded text presence, allowing HTML entities. This cannot
prove visibility, accessibility, layout, absence of external requests or mutation
prevention. HEAD checks zero observed bytes; its Content-Length may describe GET.
Actual socket/process/source/image custody remains the qualified controller's job.
Return immutable observations and hashes only, with no approval/readiness flags.

TDD: complete matrix; exact/duplicate/extra health JSON; directive/Allow ambiguity;
wrong statuses/redirects; missing/duplicate cases; type, encoding, completion and
size failures; immutable result after caller mutation. Review before publication.
