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
canonical = (root / 'bdc-feature-development.yaml').read_text()
def cores(s, name):
    return re.findall(r'      # ---- BEGIN ' + name + r' core[^\n]*\n(.*?)      # ---- END ' + name + r' core ----', s, re.S)
for lane in lanes:
    s = lane.read_text()
    for name in ['rst', 'mec', 'sme', 'rpr']:
        assert cores(s, name) == cores(canonical, name), f'{lane.name}: {name} core drift'
        assert cores(s, name), f'{lane.name}: missing {name}'
    assert len(cores(s, 'rpr')) == 2 and cores(s, 'rpr')[0] == cores(s, 'rpr')[1]
    implement = s.split('  - id: implement\n', 1)[1].split('\n  - id:', 1)[0]
    assert 'Never run `gh pr create`' in implement, f'{lane.name}: missing prompt fence'
    for name in ['run-stop-tests']:
        actual = s.split('  - id: ' + name + '\n', 1)[1].split('\n  - id:', 1)[0]
        expected = canonical.split('  - id: ' + name + '\n', 1)[1].split('\n  - id:', 1)[0]
        assert actual == expected, f'{lane.name}: {name} drift'
    pattern = r'(?ms)^      # existing-pr-base-guard: begin\n.*?^      # existing-pr-base-guard: end'
    assert re.search(pattern, s).group() == re.search(pattern, canonical).group(), f'{lane.name}: adoption guard drift'
    pattern = r'(?ms)^      if git push -u origin "HEAD:\$\{BR\}".*?^      else\n        echo "SALVAGE=push-failed'
    assert re.search(pattern, s).group() == re.search(pattern, canonical).group(), f'{lane.name}: suppression drift'
    print('PASS: ' + lane.name + ' cores, PR guards and prompt fence')
PY
bun run scripts/generate-bundled-defaults.ts --check
