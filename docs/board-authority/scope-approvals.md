# CE scope approvals

CE scope approvals bind an open `thinmansoftware/lspro-react` pull request to its exact
head commit and the current base commit. Only the authenticated principal holding the
live XO lease, with seat `xo` or `john`, can record or revoke one. The server always
sets authority to `john` and derives target branch and base SHA from GitHub.

Read the operator token from the running container environment. Do not paste it into
shell history or documentation:

```sh
OPERATOR_TOKEN="$(docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN)"
```

Record an approval:

```sh
curl -sS -X POST http://localhost:3090/api/board/scope-approvals \
  -H "Authorization: Bearer ${OPERATOR_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"principal_token":"PRINCIPAL_TOKEN","holder_id":"HOLDER_ID","holder_token":"HOLDER_TOKEN","fencing_token":1,"repo":"thinmansoftware/lspro-react","pr_number":626,"head_sha":"0123456789abcdef0123456789abcdef01234567","conditions":"no production regression","evidence_url":"https://example.test/evidence"}'
```

`principal_token` authenticates the board principal. `holder_id`, `holder_token`, and
`fencing_token` prove current ownership of the unexpired XO lease. The lease must be
bound to the same principal. Conditions are preserved verbatim, must be nonblank, and
are limited to 4000 characters. The approval id, authority, recorder, lease identity,
target branch, base SHA, and recording time are server-controlled.

The same repository, PR, head, and base is idempotent and returns the original record.
If the base advances, a new authenticated POST creates a new approval while preserving
the old audit event.

Revoke an approval:

```sh
curl -sS -X POST http://localhost:3090/api/board/scope-approvals/APPROVAL_UUID/revoke \
  -H "Authorization: Bearer ${OPERATOR_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"principal_token":"PRINCIPAL_TOKEN","holder_id":"HOLDER_ID","holder_token":"HOLDER_TOKEN","fencing_token":1,"reason":"John withdrew"}'
```

Revocation is idempotent. After committing the append-only event, the harness selects
the newest `pull_request_target` run for the pinned CE gate workflow path, exact head,
and live head branch and requests a rerun. `rerun` is `requested`, `unavailable`, or
`failed`; rerun failure never undoes revocation. The response names the credential
class, never its value.

Read the exact decision without an operator token:

```sh
curl -sS 'http://localhost:3090/api/public/board/scope-approvals?repo=thinmansoftware/lspro-react&pr_number=626&head_sha=0123456789abcdef0123456789abcdef01234567&base_sha=89abcdef0123456789abcdef0123456789abcdef'
```

Malformed input, absent or mismatched records, revocation, empty stored conditions,
and store errors all deny. The public response contains no principal or lease secret.

The automated executor is protected by the immediate recheck, but human/API GitHub
merges remain bounded by branch protection; C2 is not closed by this work order and
must be proven by the lspro-react staging work before production adoption.
