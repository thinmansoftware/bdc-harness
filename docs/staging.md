# Cauldron Laptop Staging Instance

WO-HARNESS-CAULDRON-LAPTOP-STAGING-01 / board motion M-09: the laptop Cauldron
IS the harness staging environment. Every harness change is proven here with a
real canary fire BEFORE the same commit is rebuilt on Hetzner. No more
direct-to-prod deploys.

## Topology

| | Production | Staging (laptop) |
|---|---|---|
| Host | Hetzner 5.78.86.90 | Windows laptop, Docker Desktop |
| Container | archon-app-1 | archon-staging |
| Port | 3090 (behind CF Access) | 3091, 127.0.0.1 ONLY |
| Event store | /opt/bdc/archon-data/archon.db | ./staging-data/archon.db |
| Worktrees | prod /.archon volume | ./staging-data/worktrees (inside the same bind) |
| Operator token | prod ARCHON_OPERATOR_TOKEN | fresh random value in .env.staging (gitignored) |
| Telegram / Notion / n8n | wired | ABSENT by design |
| Image | archon (built on Hetzner) | archon-staging:<sha> (same Dockerfile, built locally) |

Isolation contract (WO section 6): staging never mounts prod paths, never
carries prod tokens, never binds beyond localhost, never autostarts at boot.

## Lifecycle

```powershell
# build at a ref (default origin/dev) + boot + health-wait + print deployed commit
powershell -File scripts/staging/staging-up.ps1 [-Ref origin/dev]

# first boot only: register the codebases canary fires bind against
powershell -File scripts/staging/register-codebases.ps1

# canary fire (atomic POST /api/conversations, dispatched:true = success)
powershell -File scripts/staging/staging-fire.ps1 -Wo <WO-ID> -Project <shortname> [-Workflow <lane>]

# health + last 5 runs from the staging event store
powershell -File scripts/staging/staging-status.ps1

# stop (event store persists across down/up)
powershell -File scripts/staging/staging-down.ps1
```

First `staging-up.ps1` run creates `.env.staging` from `.env.staging.example`
with a fresh random operator token, fills `GITHUB_TOKEN` from `gh auth token`
(the documented identity choice), and seeds Claude credentials from the
laptop's `~/.claude` into `staging-user-home/.claude/` so canary read-spec
nodes can run. All of those files are gitignored.

## The 5-step promote flow

Harness changes reach production ONLY via this ladder:

1. **Merge to dev.** PR lands on `origin/dev` (the integration branch) with its
   normal review gates.
2. **Stage at the merge commit.**
   `staging-up.ps1 -Ref <merge-sha>` builds the SAME Dockerfile at that exact
   commit and boots it on :3091. The script prints and records the deployed
   commit (`staging-data/DEPLOYED_COMMIT`); it must equal the merge SHA.
3. **Canary fire must pass.** `staging-fire.ps1` a real WO. The canary must
   pass `read-spec` (authority row written in the STAGING event store) and
   reach at least one implement iteration. Verify with `staging-status.ps1`.
   A canary failure here is the ENTIRE POINT -- fix on dev, go back to step 1.
4. **M-09 deploy motion.** File the deploy motion on the board citing the
   staging evidence: deployed commit, canary run id, read-spec pass, implement
   iteration reached. John's PROCEED gate applies as usual.
5. **Hetzner rebuild at the SAME SHA.** Prod is rebuilt at exactly the commit
   staging proved -- never a newer HEAD, never a cherry-pick.

## Worked example: the 2026-07-10 double outage

Both halves of the factory outage on 2026-07-10 would have died on a staging
canary instead of taking prod down twice:

- **Outage 1 -- run_authority loader bug (fixed by PR #391).** The workflow
  loader dropped `run_authority`, so the authority freeze never ran on `/run`
  dispatch and every fire died. Step 3 catches this class directly: the canary
  fire at the staged commit fails read-spec (no authority row in the staging
  db), the promote stops at step 3, prod never sees the commit.
- **Outage 2 -- missing jq in the image (fixed by PR #392).** The prod image
  was rebuilt without `jq`, breaking workflow nodes that shell out to it. This
  is an IMAGE bug, not a source bug -- exactly what step 2 exists for: staging
  builds the same Dockerfile at the same commit, so the broken image boots (or
  fails) on the laptop first, and the step 3 canary hits the missing binary on
  :3091 instead of on archon-app-1.

Retrospective proof (WO test scenario 3): stage the pre-#391 commit
(`fc052c68`), fire a canary, watch it fail read-spec on staging, tear down.
That is the demonstration that this instance would have caught the outage.

## Notes

- The staged ref MUST include PR #392 (jq in the Dockerfile) once merged;
  pre-#392 refs build images with the known-broken missing-jq state.
- Staging is yours to start/stop freely (M-09 rule 2). It is NOT supervised;
  autostart at boot is Phase 2 of the restructuring plan.
- There is no first-class instance-identity env var in the codebase (verified
  2026-07-10); isolation is port + volumes + token. `STAGING=1` is set in
  `.env.staging` purely as a human/log marker.
