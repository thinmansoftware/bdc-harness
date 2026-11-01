# Run completion report

Read-only report of build-lane completion, so every seat counts the harness completion rate with one ruler.

## Invocation (inside archon-app-1)

    docker exec archon-app-1 bun run /app/scripts/run-completion-report.ts --days 7 [--as-of 'YYYY-MM-DD HH:MM:SS'] [--db PATH] [--json]

Flags: `--days N` (required, positive integer); `--as-of` UTC, default now; `--db` default `/.archon/archon.db`; `--json` machine output.
Exit codes: 0 ok, 2 bad arguments (usage on stderr), 3 database unopenable or table missing.
The window is [as_of minus N days, as_of). Runs are the `bdc-feature-development%` lanes; the denominator is runs, never outcome rows. A lane or overall total under 20 prints the rate as `insufficient` (counts still print). The database is opened read-only with `PRAGMA query_only = ON`; nothing is written.

## Fixture SQL (the contract)

Shown with AS_OF = '2026-11-01 14:30:00', DAYS = 7. Note `started_at` is 'YYYY-MM-DD HH:MM:SS' while `overseer_actions.created_at` is ISO with Z, so F5 goes through strftime.

    -- F1 per lane
    select workflow_name, count(*) as total, sum(status='completed') as completed
    from remote_agent_workflow_runs
    where workflow_name like 'bdc-feature-development%'
      and started_at >= datetime('2026-11-01 14:30:00','-7 days') and started_at < '2026-11-01 14:30:00'
    group by workflow_name order by workflow_name;

    -- F2 overall
    select count(*) as total, sum(status='completed') as completed
    from remote_agent_workflow_runs
    where workflow_name like 'bdc-feature-development%'
      and started_at >= datetime('2026-11-01 14:30:00','-7 days') and started_at < '2026-11-01 14:30:00';

    -- F3 per failing step (distinct runs)
    select coalesce(e.step_name,'(null)') as step_name, count(distinct e.workflow_run_id) as runs
    from remote_agent_workflow_events e
    join remote_agent_workflow_runs r on r.id = e.workflow_run_id
    where r.workflow_name like 'bdc-feature-development%'
      and r.started_at >= datetime('2026-11-01 14:30:00','-7 days') and r.started_at < '2026-11-01 14:30:00'
      and e.event_type = 'node_failed'
    group by coalesce(e.step_name,'(null)') order by runs desc, step_name;

    -- F4 failed or escalated runs with no outcome row
    select count(*) as failed_without_outcome
    from remote_agent_workflow_runs r
    where r.workflow_name like 'bdc-feature-development%'
      and r.started_at >= datetime('2026-11-01 14:30:00','-7 days') and r.started_at < '2026-11-01 14:30:00'
      and r.status in ('failed','escalated')
      and not exists (select 1 from remote_agent_run_outcomes o where o.run_id = r.id);

    -- F5 Overseer action counts (not lane-filtered)
    select action, count(*) as count from overseer_actions
    where created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','2026-11-01 14:30:00','-7 days')
      and created_at <  strftime('%Y-%m-%dT%H:%M:%fZ','2026-11-01 14:30:00')
    group by action order by action;

## Hand-check procedure (post-merge acceptance)

After the governed rebuild, pick one AS_OF value T (UTC) and run both on the host at the same time:

    docker exec archon-app-1 bun run /app/scripts/run-completion-report.ts --days 7 --as-of 'T' --json
    sqlite3 -readonly /opt/bdc/archon-data/archon.db < f1-f5.sql

Every count in the JSON must equal the matching sqlite3 row. Record both outputs on the issue.
