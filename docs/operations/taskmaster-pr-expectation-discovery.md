# Taskmaster PR expectation discovery

Date: 2026-10-18. Source proposal for bdc-xo#3258 Defect14; no runtime activation.

Only the existing pr_opened evidence probe changes. It uses core-metered REST
open pulls instead of Search. Case-sensitive head.ref equality and title prefix
matching remain conjunctive when both predicates exist. A branch can belong to a
fork owner. With neither predicate, any open PR remains sufficient. The public
schema, other evidence kinds and absence policy are unchanged.

The probe validates the repository before interpolation. No owner-qualified branch
contract was found; colon-qualified values remain UNKNOWN instead of acquiring
new semantics or reporting absence. Every row must carry a safe positive PR
number, open state, title and exact repository/number GitHub evidence URL; a
usable head reference is required when a branch predicate exists. Identical
duplicates are allowed; conflicting identity is UNKNOWN.

Pagination reuses nextPageUrl and the server Link header, with 100 rows per page
and a 100-page cap. Each next request must retain the API origin, repository
endpoint and exactly the five single-valued state/per_page/sort/direction/page
parameters. State remains open, sort created ascending and numeric page identity
must advance sequentially. Extra filters, duplicate keys, cycles, ambiguous next
links and malformed pagination are UNKNOWN before another authenticated request.
A short page with a next link is followed; completion requires no next link.

Every page and row is validated before returning either proof or absence. HTTP,
JSON, shape, pointer and pagination failures throw; an advertised next page at
the cap also throws. The existing per-expectation catch leaves supervision active
without met/failed transitions, redispatch or escalation. Tests exercise those
no-side-effect paths directly. No new controller, cache or meter is introduced.

The bounded cost is up to 100 sequential core requests per probe. This does not
establish reduced total traffic or acceptable live load. Full source tests and
fake HTTP evidence are distinct from runtime activation. Remaining Defect14 work
includes Taskmaster work-SOR and Overseer reconcile Search, reset-aware admission
waiting/cancellation and the 60-minute normal-traffic window with zero Search403
responses plus an authorized actual recorded workflow run. No merge or deployment
is authorized by this patch.
