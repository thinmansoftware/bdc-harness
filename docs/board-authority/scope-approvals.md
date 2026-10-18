# CE scope approvals

CE scope approvals are append-only records bound to an exact repository, pull request, head SHA, and live base SHA. Only the authenticated `xo` or `john` principal that owns the current unexpired XO lease can record or revoke one. The stamped authority is always `john`; it is not a client field.

Run record and revoke commands in the application container so the operator token is read from its environment and is never pasted into a transcript:

```sh
curl -sS -X POST http://localhost:3090/api/board/scope-approvals \
  -H "Authorization: Bearer ${ARCHON_OPERATOR_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"principal_token":"PRINCIPAL_TOKEN","holder_id":"HOLDER_ID","holder_token":"HOLDER_TOKEN","fencing_token":1,"repo":"thinmansoftware/lspro-react","pr_number":626,"head_sha":"HEAD_SHA_40","conditions":"verbatim approval conditions","evidence_url":"https://example.test/evidence"}'

curl -sS -X POST http://localhost:3090/api/board/scope-approvals/APPROVAL_ID/revoke \
  -H "Authorization: Bearer ${ARCHON_OPERATOR_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"principal_token":"PRINCIPAL_TOKEN","holder_id":"HOLDER_ID","holder_token":"HOLDER_TOKEN","fencing_token":1,"reason":"John withdrew"}'

curl -sS 'http://localhost:3090/api/public/board/scope-approvals?repo=thinmansoftware%2Flspro-react&pr_number=626&head_sha=HEAD_SHA_40&base_sha=BASE_SHA_40'
```

The server obtains the target branch and base SHA from the live GitHub PR. If a force push moves away from an approved head and later returns, the approval is usable only if the base tip is unchanged. A new base requires a new record.

After revocation the harness selects the newest `pull_request_target` run for `.github/workflows/ce-change-scope-gate.yml` whose head SHA and head branch match the live PR. `requested` means the rerun API accepted it, `unavailable` means no trusted run or denied permission, and `failed` means another transport failure. Revocation remains effective immediately in the automated pre-merge recheck in every case.

Human, shared-account, UI, and direct API merge paths remain bounded by GitHub branch protection rather than the harness executor. The separate staging proof must close that residual window before production adoption. Cloudflare Access service-token or bypass configuration for the public read route is also a separate C3 operator action.

## Rebuild verification

Before rebuild, back up `/opt/bdc/archon-data/archon.db`, then capture both values:

```sh
ssh hetzner-prod 'sqlite3 /opt/bdc/archon-data/archon.db "select count(*) from board_audit_events"'
ssh hetzner-prod 'sqlite3 /opt/bdc/archon-data/archon.db "select id,event_type,created_at,details from board_audit_events order by id" | sha256sum'
```

After rebuild, both outputs must be exactly identical. Then verify the public denial and widened schema:

```sh
ssh hetzner-prod 'curl -s "http://localhost:3090/api/public/board/scope-approvals?repo=thinmansoftware/lspro-react&pr_number=1&head_sha=0000000000000000000000000000000000000000&base_sha=0000000000000000000000000000000000000000"'
ssh hetzner-prod 'sqlite3 /opt/bdc/archon-data/archon.db "select count(*) from sqlite_master where name='"'"'board_audit_events'"'"' and sql like '"'"'%manual_initiation_recorded%'"'"'"'
```

Expected results are `{"decision":"deny","reason":"no_record"}` and `1`. Runtime proof remains pending until the acting XO records this evidence.
