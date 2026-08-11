---
title: Operator MCP
description: Configure the scoped Cauldron and Dispatch operator tools.
category: operations
area: operations
audience: [operator]
status: current
sidebar:
  order: 20
---

The operator MCP is a stdio server that wraps the existing Archon HTTP API. Run it on the same host as Archon so the API does not need another network-exposed endpoint.

## Configure Claude Code

On `archon-app-1`, from the bdc-harness checkout, register the server with the tokens needed by that session:

```bash
claude mcp add --transport stdio \
  --env ARCHON_API_BASE_URL=http://localhost:3090 \
  --env ARCHON_OPERATOR_TOKEN_INSPECT="$ARCHON_OPERATOR_TOKEN_INSPECT" \
  --env ARCHON_OPERATOR_TOKEN_MESSAGE="$ARCHON_OPERATOR_TOKEN_MESSAGE" \
  --env ARCHON_OPERATOR_TOKEN_FIRE="$ARCHON_OPERATOR_TOKEN_FIRE" \
  archon-operator -- bun --cwd packages/mcp-operator start
```

Set only the scoped token variables the session needs. Inspect grants run, node-event, dashboard-run, and dispatch-list reads. Message grants dispatch lifecycle mutations. Fire grants only workflow initiation and still requires `approved_by` plus `approval_reason`; the principal must appear in the API process's comma-separated `ARCHON_OPERATOR_FIRE_APPROVERS` allowlist.

Verify discovery in a fresh session:

```bash
claude mcp get archon-operator
```

Then call `get_run` with a real run ID. The returned JSON is the response from `GET /api/workflows/runs/{runId}`.
