# Capability census slice 1

This is a **read-only slice 1 census — no capability enablement, no dark-lane activation**.
It inventories code-defined capabilities and reports the flags visible to the probe process. It
does not connect to a database, start a service, change pause state, or invoke authorization or
mutation paths.

Regenerate with `bun run generate:capability-census`; verify without writing with
`bun run check:capability-census`. The JSON artifact is the machine-readable source for these
rows. Owners are the responsible package paths and every deferral expiry is `null` because slice 1
has no in-repository deferral clock.

| Capability ID | Tier | Default live flag | Owner | Deferral expiry |
| --- | ---: | --- | --- | --- |
| `overseer.escalation` | 0 | on | `packages/overseer` | null |
| `overseer.repair` | 1 | on | `packages/overseer` | null |
| `overseer.branch` | 1 | on | `packages/overseer` | null |
| `overseer.lifecycle` | 1 | on | `packages/overseer` | null |
| `overseer.merge` | 1 | on | `packages/overseer` | null |
| `merge-manager.overseer-merge-manager-v1` | 1 | on | `packages/overseer` | null |
| `taskmaster.deliver_ruling` | 0 | on | `packages/server/src/taskmaster` | null |
| `taskmaster.nudge` | 0 | on | `packages/server/src/taskmaster` | null |
| `taskmaster.escalate_p0` | 0 | on | `packages/server/src/taskmaster` | null |
| `taskmaster.digest` | 0 | on | `packages/server/src/taskmaster` | null |

`off` means a direct enabling gate is disabled, while `deferred` means a capability flag is on but
a global emergency-stop or dry-run gate prevents live action. Taskmaster defaults to `on` at its
code-defined 60-second interval and is `off` only when `TASKMASTER_INTERVAL_MS=0`; its persisted
`PAUSED` / `HARD_PAUSE` state is intentionally not queried by this static, read-only slice.
