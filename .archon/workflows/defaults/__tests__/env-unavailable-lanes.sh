#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
cd "$ROOT"
python3 - <<'PY'
from pathlib import Path
import re
root = Path('.archon/workflows/defaults')
lanes = sorted(p for p in root.glob('bdc-feature-development*.yaml') if 'BEGIN rst core' in p.read_text())
assert len(lanes) == 13, f'expected 13 lanes, found {len(lanes)}'
# WO-HARNESS-JUNE-SHAPE-LANE-REBUILD-01: bdc-feature-development.yaml was rebuilt (one rpr copy in
# its single PR creation, salvage commits only, the adopt push through pubg_push), so the
# canonical copy of the shared blocks is the codex lane, and the rebuilt lane is excluded from
# exactly these comparisons: the rpr core, the adoption guard, the salvage suppression and
# run-stop-tests (its replay-checkout path was removed with evidence repair).
canonical = (root / 'bdc-feature-development-codex.yaml').read_text()
REBUILT = 'bdc-feature-development.yaml'
def cores(s, name):
    return re.findall(r'      # ---- BEGIN ' + name + r' core[^\n]*\n(.*?)      # ---- END ' + name + r' core ----', s, re.S)
for lane in lanes:
    s = lane.read_text()
    for name in ['rst', 'mec', 'sme'] + ([] if lane.name == REBUILT else ['rpr']):
        assert cores(s, name) == cores(canonical, name), f'{lane.name}: {name} core drift'
        assert cores(s, name), f'{lane.name}: missing {name}'
    if lane.name == REBUILT:
        assert len(cores(s, 'rpr')) == 1, f'{lane.name}: expected one rpr core (its single PR creation)'
        assert 'pubg_push "$(git rev-parse HEAD)" "$RPR_BRANCH"' in s, f'{lane.name}: adopt push not guarded'
    else:
        assert len(cores(s, 'rpr')) == 2 and cores(s, 'rpr')[0] == cores(s, 'rpr')[1]
    implement = s.split('  - id: implement\n', 1)[1].split('\n  - id:', 1)[0]
    assert 'Never run `gh pr create`' in implement, f'{lane.name}: missing prompt fence'
    for name in ([] if lane.name == REBUILT else ['run-stop-tests']):
        actual = s.split('  - id: ' + name + '\n', 1)[1].split('\n  - id:', 1)[0]
        expected = canonical.split('  - id: ' + name + '\n', 1)[1].split('\n  - id:', 1)[0]
        assert actual == expected, f'{lane.name}: {name} drift'
    if lane.name != REBUILT:
        pattern = r'(?ms)^      # existing-pr-base-guard: begin\n.*?^      # existing-pr-base-guard: end'
        assert re.search(pattern, s).group() == re.search(pattern, canonical).group(), f'{lane.name}: adoption guard drift'
        pattern = r'(?ms)^      if git push -u origin "HEAD:\$\{BR\}".*?^      else\n        echo "SALVAGE=push-failed'
        assert re.search(pattern, s).group() == re.search(pattern, canonical).group(), f'{lane.name}: suppression drift'
    print('PASS: ' + lane.name + ' cores, PR guards and prompt fence')
PY
bun run scripts/generate-bundled-defaults.ts --check
