#!/usr/bin/env bash
# Test 11 (WO-HARNESS-JUNE-SHAPE-LANE-REBUILD-01): salvage is decided once, before
# publication. noninteractive-salvage commits only (no push, no PR create);
# commit-and-push runs once; one PR carries the salvaged work, run:blocked, the banner
# and both marker lines, and is readied last. The old fallback-PR, local-preservation
# and salvage lock-contention cases were removed with salvage's push and PR path.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$HERE/fixtures/june-shape-fixture.py" salvage
python3 "$HERE/fixtures/run-pr-fixture.py" stale
