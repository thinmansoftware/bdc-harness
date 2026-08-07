---
title: Taskmaster
---
Taskmaster Slice 1 monitors stalled work and sends only allowlisted mailbox messages. Set `TASKMASTER_INTERVAL_MS=0` and restart for rollback; production cadence is `60000`.

```bash
curl -H "Authorization: Bearer $ARCHON_OPERATOR_TOKEN" http://localhost:3000/api/taskmaster/status
curl -X POST -H "Authorization: Bearer $ARCHON_OPERATOR_TOKEN" -H 'Content-Type: application/json' -d '{"reason":"maintenance"}' http://localhost:3000/api/taskmaster/pause
curl -X POST -H "Authorization: Bearer $ARCHON_OPERATOR_TOKEN" -H 'Content-Type: application/json' -d '{"reason":"John authorized resume"}' http://localhost:3000/api/taskmaster/resume
sqlite3 /opt/bdc/archon-data/archon.db "SELECT count(*) FROM tm_journal WHERE outcome='sent' AND grade='useful'"
```
Resume is John-authorized, increments the pause epoch, and never replays parked proposals.
