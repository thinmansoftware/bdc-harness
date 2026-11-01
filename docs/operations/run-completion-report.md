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

## Outcomes (last 24h)

Added by WO-HARNESS-DAILY-OUTCOME-REPORT-01. Health checks watch liveness; this section watches outcomes. For each harness mechanism it prints INPUT (what went in) against OUTCOME (what came out) over the 24 hours ending at `--as-of`. The window is always 24 hours, whatever `--days` is.

Where the output goes: stdout only, the same as the rest of this report (text, or the `outcomes` and `outcome_flag_line` keys with `--json`). The FIRST line of text output is the owner-visible flag line, `outcome_flags: none` or `outcome_flags: <n> (<flag>, ...)`. The script posts nowhere and never writes to the `operator` mailbox. A scheduled daily run that posts the flag line to the `t3-desktop` results queue is a separate follow-up.

| Mechanism | Input | Outcome |
|---|---|---|
| `taskmaster_escalate_p0` | tm_journal escalate_p0 proposals | proposals with outcome `sent` |
| `overseer_review` | run_review messages to `overseer-reviewer` | `pr_review_submit_receipt` bodies with disposition `approved` or `changes_requested` (any recipient: `operator` before the 2026-11-01 cut-off, `pr-review-log` after) |
| `overseer_repair` | overseer_actions `escalate_with_evidence` | overseer_actions whose action contains `repair` or `refire` |
| `overseer_merge` | overseer_actions `flag_merge_ready` | overseer_actions `merged` (all bases: the store does not record the PR base, so production bases are not separated) |
| `cauldron_runs` | build-lane runs started | of those, status `completed` |
| `mailbox_<r>` for `operator`, `xo`, `t3-desktop` | rows queued to r | rows to r acknowledged in the window |

Mailbox depth: for each of those recipients, all `queued` rows with no `acknowledged_at` (`depth`), the live part of it (`depth_live`; for `operator`, rows created on or after `OPERATOR_HISTORY_CUTOFF` 2026-11-01T00:00:00.000Z only, because older rows are fenced history), the oldest live row, and its age in hours.

Flags:
- `dead_mechanism:<name>` when input > 0 and outcome = 0.
- `stale_mailbox:<recipient>` when the oldest live unacknowledged row is more than 24 hours old.

### Fixture SQL O1-O7 (the contract)

Shown with AS_OF = '2026-11-01 14:30:00'; WS = '2026-10-31T14:30:00.000Z', WE = '2026-11-01T14:30:00.000Z' (strftime('%Y-%m-%dT%H:%M:%fZ', AS_OF, '-1 days') and strftime('%Y-%m-%dT%H:%M:%fZ', AS_OF)).

    -- O1 taskmaster_escalate_p0
    select count(*) as input, coalesce(sum(outcome='sent'),0) as outcome
    from tm_journal where action_type='escalate_p0' and created_at >= WS and created_at < WE;

    -- O2 overseer_review
    select (select count(*) from agent_dispatch_messages
            where task_type='run_review' and recipient='overseer-reviewer'
              and created_at >= WS and created_at < WE) as input,
           (select count(*) from agent_dispatch_messages
            where created_at >= WS and created_at < WE and json_valid(body)
              and json_extract(body,'$.kind')='pr_review_submit_receipt'
              and json_extract(body,'$.disposition') in ('approved','changes_requested')) as outcome;

    -- O3 overseer_repair
    select coalesce(sum(action='escalate_with_evidence'),0) as input,
           coalesce(sum(action like '%repair%' or action like '%refire%'),0) as outcome
    from overseer_actions where created_at >= WS and created_at < WE;

    -- O4 overseer_merge (all bases)
    select coalesce(sum(action='flag_merge_ready'),0) as input, coalesce(sum(action='merged'),0) as outcome
    from overseer_actions where created_at >= WS and created_at < WE;

    -- O5 cauldron_runs
    select count(*) as input, coalesce(sum(status='completed'),0) as outcome
    from remote_agent_workflow_runs
    where workflow_name like 'bdc-feature-development%'
      and started_at >= datetime('2026-11-01 14:30:00','-1 days') and started_at < '2026-11-01 14:30:00';

    -- O6 mailbox_<r>, r in ('operator','xo','t3-desktop')
    select (select count(*) from agent_dispatch_messages where recipient=:r and created_at >= WS and created_at < WE) as input,
           (select count(*) from agent_dispatch_messages where recipient=:r and acknowledged_at >= WS and acknowledged_at < WE) as outcome;

    -- O7 mailbox depth for r
    select count(*) as depth,
           coalesce(sum(:r <> 'operator' or created_at >= '2026-11-01T00:00:00.000Z'),0) as depth_live,
           min(case when :r <> 'operator' or created_at >= '2026-11-01T00:00:00.000Z' then created_at end) as oldest_live
    from agent_dispatch_messages
    where recipient=:r and status='queued' and acknowledged_at is null and created_at < WE;

Age: round((julianday(AS_OF) - julianday(oldest_live)) * 24, 1).

### Live outcome check (after the governed rebuild)

    docker exec archon-app-1 bun run /app/scripts/run-completion-report.ts --days 1 --json

Every `outcomes.mechanisms` and `outcomes.mailboxes` value must equal O1-O7 run with `sqlite3 -readonly /opt/bdc/archon-data/archon.db` at the same AS_OF. Record both outputs on the issue.
