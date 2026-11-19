#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$HERE/fixtures/run-pr-fixture.py" fallback
python3 "$HERE/fixtures/run-pr-fixture.py" concurrent
python3 "$HERE/fixtures/run-pr-fixture.py" stale
python3 "$HERE/fixtures/run-pr-fixture.py" local
