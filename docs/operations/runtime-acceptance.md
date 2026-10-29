# Automated runtime acceptance

The Docker job in Test Suite builds the exact GitHub checkout with its full
commit SHA embedded in the image environment and OCI revision label. It then
runs the same gate used on the Docker Desktop staging laptop:

```text
bun scripts/staging/verify-runtime.ts --image <candidate-image> --source-sha <full-commit> --output-dir <new-evidence-directory>
```

On the staging laptop, build and verify in one unattended command from a clean
candidate worktree:

```powershell
pwsh -NoProfile -File scripts/staging/build-and-verify.ps1 -SourceSha <full-commit> -OutputDirectory <new-evidence-directory>
```

The launcher rejects dirty or mismatched source, chooses a unique image tag,
and writes build and acceptance logs. It uses an isolated anonymous Docker
client configuration for public base-image pulls, so Windows credential-helper
logon sessions are not required over SSH. It does not change the normal Docker
client configuration, copy account credentials or restart the engine.

The gate needs only Bun and a working Docker CLI/engine on the operator host.
It runs all application tools inside the candidate image. No operator has to
log in, supply provider credentials, invoke a workflow, inspect logs manually,
or decide whether a check passed. Missing tools, bad image identity, unhealthy
boot, failed SQLite migration/integrity or digest queries, browser failure,
unclean shutdown and failed restart all return a nonzero exit code.

Each run creates one randomly named container with no network, credentials,
host ports or mounts. Automatic fires are disabled; Overseer remains stopped
with its emergency stop set. The gate checks the actual packaged digest loader,
captures installed tool versions, renders the packaged application in headless
Chromium, and requires its actual heading and empty-store API results, rather
than the static root element. Each shutdown requires fresh handler and database
close events from that boot with exit zero. It restarts the same container/store and verifies another clean
shutdown. Cleanup is limited to that run's own container.

The output contains receipt.json, boot/shutdown logs and browser DOM. CI uploads
the evidence even on failure. A healthy HTTP response alone cannot pass the job.
This gate does not test a provider workflow, migration rollback to an older
image, or production acceptance; those require their separate evidence.

## Tool versions

Bun 1.4.4 is pinned in .bun-version and Dockerfile, Node 24.22.1 LTS is copied
from the official Node image, and agent-browser 0.39.4 is pinned in Dockerfile.
These release versions were checked against their upstream releases on
2026-10-27. Lockfile installation remains frozen. Chromium, git, curl, jq,
ripgrep, ShellCheck, pytest and the guarded gh CLI are installed in the image
and their working versions are captured by the gate.

Upstream release records:
- https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4
- https://github.com/nodejs/node/releases/tag/v24.22.1
- https://github.com/vercel-labs/agent-browser/releases/tag/v0.39.4

The existing laptop Docker engine is not upgraded or restarted by this job;
that would interrupt unrelated services. Its version is recorded in evidence.
The gate fails closed if that engine cannot execute the required operations.

Bun 1.4 changed strict SQLite close to finalize outstanding statements. The
synthetic lifetime diagnostic asserts this documented contract on 1.4 and the
older busy-connection contract on 1.3; application adapter behavior is unchanged.
Reference: https://bun.com/reference/bun/sqlite/Database/close

## Definition of done for this runtime repair

- The real SQLite regression fails on old source and passes on the correction.
- The normal container entrypoint handles SIGTERM, closes the database and exits
  zero; a health-only smoke cannot qualify it.
- CI and the laptop run the same unattended gate on an image tied to the exact
  source SHA, recording its digest, tool versions and evidence automatically.
- Linux/Windows package tests, PostgreSQL integrations, types, lint and format
  remain required source checks. Deterministic workflow smoke uses the same Bun
  version file. A skipped or failed required check is not a passing release.
- Browser, migration/integrity/digest, restart and both shutdown checks produce
  machine-readable failure and preserved logs, with cleanup of owned resources.
- Final source review and CI results must correspond to the final candidate;
  laptop evidence alone does not establish GitHub CI success.

This is the runtime acceptance portion of the pipeline. A complete production
promotion still needs an approved staging canary and tested data-compatible
rollback, followed by its scoped production motion and post-deployment checks.
Routine verification needs no human log inspection; production authorization
remains a deliberate governance decision.

## Promotion boundary

PR CI, exact-image runtime evidence, live staged canary acceptance, rollback
readiness and production approval are distinct gates. This change automates the
runtime gate and retains existing PR checks; it does not silently create a
production deployment route. #3089 remains gated on the approved runtime and
the separate registry motion. No production or registry state is changed here.
