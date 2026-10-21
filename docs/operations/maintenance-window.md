# Overnight maintenance window

Housekeeping runs at most once in the half-open `01:00-05:00` window in
`America/New_York`. It does not run at service startup. Configure the schedule with
`MAINTENANCE_WINDOW_START`, `MAINTENANCE_WINDOW_END` (`HH:MM`), and
`MAINTENANCE_WINDOW_TZ`. `MAINTENANCE_GIT_CONCURRENCY` controls housekeeping git
processes and defaults to `4`; it does not limit builds.

An operator can bypass the time window (but not the single-run guard):

```sh
curl -X POST -H 'x-archon-operator-token: <OPERATOR_TOKEN>' http://localhost:3000/api/maintenance/cleanup
```

The endpoint returns `409` if cleanup is already running. Git-check failures preserve
worktrees. Resource exhaustion stops further git processes for that run and emits one
`maintenance_git_resource_exhausted` diagnostic with thread and in-flight counts.

Useful log messages are `cleanup_started`, `maintenance_window_skip`,
`maintenance_git_resource_exhausted`, and `worktree_sweep_prune_refused_outside_workspaces`.

Removal, quarantine deletion, and `git worktree prune` are allowed only for canonical
paths beneath the container workspaces root (`/.archon/workspaces`). In particular,
`/opt/bdc/archon` is never a cleanup or prune target.

After merge and rebuild, XO verifies that no afternoon cleanup occurs, the next
overnight run has no threaded-lstat errors, and the stale worktree backlog decreases.
