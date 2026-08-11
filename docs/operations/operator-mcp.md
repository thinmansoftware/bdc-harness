# Operator MCP server

The operator MCP is a stdio process intended to run over an existing SSH session. It calls the
Cauldron REST API and uses three independent credentials: inspect, dispatch-message, and fire.
Workflow fire additionally requires an API-side approval from a principal in
`ARCHON_OPERATOR_FIRE_APPROVERS` and a non-empty reason.

Configure a fresh Claude Code session with this exact command (replace the SSH host if needed):

```bash
claude mcp add --transport stdio archon-operator -- ssh hetzner-prod \
  'cd /app && bun packages/mcp-operator/src/server.ts'
```

The remote process reads `ARCHON_API_BASE_URL` (default `http://localhost:3090`) and
`ARCHON_OPERATOR_TOKEN_INSPECT`, `ARCHON_OPERATOR_TOKEN_MESSAGE`, and
`ARCHON_OPERATOR_TOKEN_FIRE` from its environment. Do not put token values in the MCP client
configuration. Use `get_run` for the first connectivity check against a known run ID.

`fire_workflow` requires `approved_by` and `approval_reason`. The API validates these fields;
possessing the fire token alone is not approval.
