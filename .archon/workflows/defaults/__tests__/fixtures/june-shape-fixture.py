"""june-shape-fixture.py -- drives the REAL bash of the rebuilt bdc-feature-development lane
(WO-HARNESS-JUNE-SHAPE-LANE-REBUILD-01) against a local bare Git remote and a stateful,
network-free gh stub that records every call in order.

Usage: python3 june-shape-fixture.py <scenario>
Prints "PASS: <label>" / "FAIL: <label>" lines; exit status is the failure count (capped).
Node bash is extracted from the YAML and substituted the way the engine does before bash
runs: workflow variables ($ARTIFACTS_DIR, $WORKFLOW_ID, $BASE_BRANCH, $USER_MESSAGE) as
whole identifiers, then $<node>.output references shell-quoted. ASCII only.
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
YAML = Path(os.environ.get('JUNE_SHAPE_YAML') or (ROOT / '.archon/workflows/defaults/bdc-feature-development.yaml'))
GUARD = ROOT / 'scripts/lane/prod-base-guard.sh'
BASH = (str(Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe')
        if os.name == 'nt' else 'bash')
WO = 'WO-FIX-01'
REPO = 'fixture/repo'
RUN_ID = '0123456789abcdef0123456789abcdef'
THREAD = 'abcd1234'
BANNER = 'RUN BLOCKED -- not lane-verified'
RESULTS = {'pass': 0, 'fail': 0}
# A synthetic AWS-style access key id that matches gitleaks' default aws-access-token rule. Test
# data only, never a real credential; built from two parts so this file itself does not match.
KEY = 'AKIA' + 'Z7Q3XW2RB4NPLM5K'
SECRET = 'aws_access_key_id = ' + KEY + '\n'
UNIQUE = 'feat/wo-fix-01-thread-%s-run-%s' % (THREAD, RUN_ID[:12])


def check(label, cond, detail=''):
    if cond:
        RESULTS['pass'] += 1
        print('PASS: ' + label, flush=True)
    else:
        RESULTS['fail'] += 1
        print('FAIL: ' + label + ((' -- ' + detail[:1500]) if detail else ''), flush=True)


def write_lf(path, text):
    path.write_bytes(text.replace('\r\n', '\n').encode('utf-8'))


def cmd(args, cwd, env=None, check_rc=True):
    return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, check=check_rc)


def node_text(name):
    lines = YAML.read_text(encoding='utf-8').replace('\r\n', '\n').split('\n')
    start = lines.index('  - id: ' + name)
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith('  - id: ')), len(lines))
    start = next(i for i in range(start, end) if lines[i] == '    bash: |') + 1
    return '\n'.join(line[6:] if line.startswith('      ') else '' for line in lines[start:end])


STUB = r'''import json, os, subprocess, sys
from pathlib import Path
p = Path(os.environ['JSF_STATE']); d = json.loads(p.read_text()); a = sys.argv[1:]
with open(os.environ['JSF_CALLS'], 'a') as log: log.write(json.dumps(a) + '\n')
def opt(flag, default=None): return a[a.index(flag) + 1] if flag in a else default
def save(): p.write_text(json.dumps(d))
def find(key):
    for v in d['prs']:
        if str(v['number']) == key or v['url'] == key: return v
    raise SystemExit('no such PR ' + key)
def live(v):
    r = subprocess.run(['git', '--git-dir', os.environ['JSF_BARE'], 'rev-parse', '--verify', '-q', 'refs/heads/' + v['headRefName']], text=True, capture_output=True)
    if r.stdout.strip(): v['headRefOid'] = r.stdout.strip()
    return v
def show(v, fields):
    out = {}
    for f in fields.split(','):
        if f == 'labels': out[f] = [{'name': n} for n in v.get('labels', [])]
        elif f in v: out[f] = v[f]
    return out
def jq(obj, expr):
    if expr in ('.body', '.baseRefName', '.login', '.number', '.headRefOid'):
        val = obj.get(expr[1:], '')
        return '' if val is None else str(val)
    if expr == '.isDraft': return 'true' if obj.get('isDraft') else 'false'
    if 'isCrossRepository' in expr:
        return '\t'.join([obj['state'], obj['headRefName'], 'false', d.get('owner', 'fixture'), d.get('name', 'repo'), obj['headRefOid']])
    if expr.startswith('.[0].number'): return '42'
    raise SystemExit('unsupported jq ' + expr)
def emit(obj):
    if '--jq' in a: print(jq(obj, opt('--jq')))
    else: print(json.dumps(obj))
if a[:2] == ['api', 'user']: emit({'login': 'builder'})
elif a[:2] == ['pr', 'list']:
    items = [live(v) for v in d['prs'] if v.get('state', 'OPEN') == 'OPEN' and not v.get('hidden')]
    if '--head' in a: items = [v for v in items if v['headRefName'] == opt('--head')]
    print(json.dumps([show(v, opt('--json')) for v in items]))
elif a[:2] == ['pr', 'view']:
    v = live(find(a[2]))
    emit(show(v, opt('--json')) if '--jq' not in a or 'isCrossRepository' not in opt('--jq') else v)
elif a[:2] == ['pr', 'create']:
    n = 100 + len(d['prs']); branch = opt('--head')
    sha = subprocess.check_output(['git', '--git-dir', os.environ['JSF_BARE'], 'rev-parse', 'refs/heads/' + branch], text=True).strip()
    v = dict(number=n, url='https://github.com/fixture/repo/pull/' + str(n), headRefName=branch, headRefOid=sha,
             baseRefName=opt('--base'), author={'login': 'builder'}, title=opt('--title'), state='OPEN',
             body=Path(opt('--body-file')).read_text(), labels=[], comments=[], isDraft='--draft' in a)
    if os.environ.get('JSF_CREATE_LOST'): v['hidden'] = True
    d['prs'].append(v); save()
    if os.environ.get('JSF_CREATE_LOST'): raise SystemExit('fixture: create response lost')
    print(v['url'])
elif a[:2] == ['pr', 'edit']:
    v = find(a[2])
    if '--add-label' in a:
        if os.environ.get('JSF_LABEL_FAIL'): raise SystemExit('fixture: label call failed')
        if opt('--add-label') not in v['labels']: v['labels'].append(opt('--add-label'))
    if '--body-file' in a:
        body = Path(opt('--body-file')).read_text()
        if os.environ.get('JSF_DROP_BANNER'): body = '\n'.join(l for l in body.split('\n') if l != 'RUN BLOCKED -- not lane-verified')
        v['body'] = body
    save()
elif a[:2] == ['pr', 'ready']:
    if os.environ.get('JSF_READY_FAIL'): raise SystemExit('fixture: ready failed')
    find(a[2])['isDraft'] = False; save()
elif a[:2] == ['pr', 'comment']:
    find(a[2])['comments'].append(Path(opt('--body-file')).read_text()); save()
elif a[:2] == ['label', 'create']: pass
elif a[:2] == ['issue', 'comment']:
    d.setdefault('issue_comments', []).append({'issue': a[2], 'body': Path(opt('--body-file')).read_text()}); save()
elif a[:2] == ['issue', 'edit']: pass
elif a[:2] == ['issue', 'list']: print('42')
else: raise SystemExit('unexpected gh call: ' + str(a))
'''

PLAN = ('=== APPROVED_PLAN_BEGIN ===\nCommit message: feat: fixture change\n- file\n'
        '=== APPROVED_PLAN_END ===\nPLAN_REVIEW_PASS=true\nPLAN_REVIEW_APPROVED')
DECIDE = ('push_target: feature-branch:feat/wo-fix-01\npr_required: true\n'
          'staging_gate_required: false\nrepo: fixture/repo')
SPEC = 'WO Class: CODE\ntarget_repo: fixture/repo\nBase branch: dev\n\n# ' + WO + '\n'


class Fixture:
    def __init__(self, tmp, base='dev'):
        self.t = Path(tmp)
        t = self.t
        self.bare = t / 'origin.git'
        self.wt = t / 'wt'
        cmd(['git', 'init', '--bare', '-q', str(self.bare)], t)
        cmd(['git', 'clone', '-q', str(self.bare), str(self.wt)], t)
        for key, value in [('user.name', 'Fixture'), ('user.email', 'fixture@example.invalid'),
                           ('core.hooksPath', str(t / 'no-hooks')), ('core.autocrlf', 'false'),
                           ('url.' + self.bare.as_posix() + '.insteadOf', 'https://github.com/fixture/repo.git')]:
            self.git(['config', key, value])
        self.git(['switch', '-q', '-c', base])
        write_lf(self.wt / 'file', 'base\n')
        self.git(['add', 'file']); self.git(['commit', '-qm', 'base'])
        self.base_sha = self.git(['rev-parse', 'HEAD'])
        self.git(['push', '-q', 'origin', base])
        self.git(['remote', 'set-url', 'origin', 'https://github.com/fixture/repo.git'])
        self.git(['switch', '-q', '-c', 'archon/thread-' + THREAD])
        self.art = t / 'runs' / RUN_ID
        self.out = self.art / 'node-out'
        self.out.mkdir(parents=True)
        (self.art / 'authority').mkdir()
        write_lf(self.art / 'authority' / 'work-order.md', SPEC)
        write_lf(self.art / 'run-start-sha.txt', self.base_sha + '\n')
        bindir = t / 'bin'; bindir.mkdir()
        write_lf(bindir / 'gh', '#!/usr/bin/env bash\nexec python3 "' + (t / 'gh.py').as_posix() + '" "$@"\n')
        write_lf(t / 'gh.py', STUB)
        for tool in ('ssh', 'curl'):
            write_lf(bindir / tool, '#!/usr/bin/env bash\nexit 97\n')
        # Fake clock for the origin-visibility waits: with JSF_FAST_SLEEP set, sleep returns at once.
        write_lf(bindir / 'sleep', '#!/usr/bin/env bash\n[ -n "${JSF_FAST_SLEEP:-}" ] && exit 0\nexec /usr/bin/sleep "$@"\n')
        # The private host mount /host-artifacts (the docker-compose bind mount), mapped into the run.
        self.host = t / 'host-artifacts'
        self.host.mkdir()
        self.failed_nodes = ''
        for f in bindir.iterdir():
            f.chmod(0o755)
        self.state = t / 'state.json'
        self.calls = t / 'calls.jsonl'
        self.state.write_text(json.dumps({'prs': []}))
        self.calls.write_text('')
        shell_path = str(Path(BASH).parent) + os.pathsep if os.name == 'nt' else ''
        env = dict(os.environ, PATH=str(bindir) + os.pathsep + shell_path + os.environ['PATH'],
                   ARTIFACTS_DIR=self.art.as_posix(), ARCHON_NODE_OUT=self.out.as_posix(),
                   WORKFLOW_ID=RUN_ID, USER_MESSAGE=WO + ' issue=42', RECORDED_BASE_BRANCH=base,
                   BASE_BRANCH=base, CAULDRON_INTERACTIVE='false', JSF_STATE=str(self.state),
                   JSF_CALLS=str(self.calls), JSF_BARE=str(self.bare), BDC_PROD_BASE_GUARD_SCRIPT=GUARD.as_posix(),
                   GH_CONFIG_DIR=str(t / 'gh-empty'), TMPDIR=str(t), TEMP=str(t), TMP=str(t))
        (t / 'gh-empty').mkdir()
        for key in ('GH_TOKEN', 'GITHUB_TOKEN', 'WO_ID', 'BASH_ENV', 'ENV'):
            env.pop(key, None)
        for key in list(env):
            if key.startswith('BASH_FUNC_'):
                env.pop(key, None)
        if os.name == 'nt':
            env['PATH'] = cmd([BASH, '-c', 'cygpath -u -p "$JSF_NATIVE"'], self.wt, dict(env, JSF_NATIVE=env['PATH'])).stdout.strip()
        self.env = env
        self.outputs = {}
        self.set_out('read-spec', 'WO_ID=%s\nSPEC_PATH=docs/work-orders/%s.md\nRUN_START_SHA=%s\n\n%s' % (WO, WO, self.base_sha, SPEC))
        self.set_out('checkout-repair-target', 'REPAIR_TARGET=none')
        self.set_out('plan-review', PLAN)
        self.set_out('decide-push-target', DECIDE)
        self.set_out('implement', 'COMPLETE')
        self.set_out('assert-implement-produced-work', 'BUILD_OUTCOME=REAL_BUILD')
        self.set_out('lane-scope-check', 'LANE_SCOPE=ok')
        self.set_out('stamp-manifest-pr', 'WO: %s\nBuilder: Major Build\nTests: 1/1 (fixture)\nPRs: pending\nVALIDATION: PASS' % WO)
        # The run's first node defines the guarded publisher (pubg core) and saves it.
        rc, out, err = self.run('preflight-github-auth')
        if rc != 0 or not (self.art / 'evidence' / 'pubg.core.sh').is_file():
            raise RuntimeError('preflight-github-auth did not save the pubg core: ' + out + err)

    def git(self, args, cwd=None):
        return cmd(['git'] + args, cwd or self.wt).stdout.strip()

    def set_out(self, name, value):
        self.outputs[name] = value
        write_lf(self.out / (name + '.out'), value)

    def drop_out(self, name):
        self.outputs.pop(name, None)
        f = self.out / (name + '.out')
        if f.exists():
            f.unlink()

    def script(self, name):
        return self.substitute(node_text(name))

    def substitute(self, text):
        text = text.replace('/host-artifacts', self.host.as_posix())
        text = text.replace('$_run.output.failed_nodes', shlex.quote(self.failed_nodes))
        for var, value in [('WORKFLOW_ID', RUN_ID), ('USER_MESSAGE', self.env['USER_MESSAGE']),
                           ('ARTIFACTS_DIR', self.art.as_posix()), ('BASE_BRANCH', self.env['BASE_BRANCH'])]:
            text = re.sub(r'\$' + var + r'(?![A-Za-z0-9_])', lambda m, v=value: v, text)
        text = re.sub(r'\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output(?![A-Za-z0-9_.])',
                      lambda m: shlex.quote(self.outputs.get(m.group(1), '')), text)
        return text

    def run(self, name, extra=None, text=None):
        path = self.t / (name + '.sh')
        write_lf(path, self.script(name) if text is None else self.substitute(text))
        res = cmd([BASH, str(path)], self.wt, dict(self.env, **(extra or {})), check_rc=False)
        out = res.stdout[:-1] if res.stdout.endswith('\n') else res.stdout
        if res.returncode == 0:
            self.set_out(name, out)
        return res.returncode, out, res.stderr

    def gh_calls(self):
        return [json.loads(l) for l in self.calls.read_text().splitlines() if l.strip()]

    def prs(self):
        return json.loads(self.state.read_text())['prs']

    def commit_change(self, text='implemented\n', msg='impl'):
        write_lf(self.wt / 'file', text)
        self.git(['commit', '-qam', msg])

    def commit_file(self, name, text, msg, cwd=None):
        cwd = Path(cwd or self.wt)
        write_lf(cwd / name, text)
        self.git(['add', name], cwd)
        self.git(['commit', '-qm', msg], cwd)
        return self.git(['rev-parse', 'HEAD'], cwd)

    def merge_secret(self, cwd=None):
        """A merge whose RESULT adds the secret; neither parent has it."""
        cwd = Path(cwd or self.wt)
        cur = self.git(['branch', '--show-current'], cwd)
        side = 'side-' + cur.replace('/', '-')
        self.git(['switch', '-q', '-c', side], cwd)
        self.commit_file('side.txt', 'side\n', 'side', cwd)
        self.git(['switch', '-q', cur], cwd)
        self.commit_file('main.txt', 'main\n', 'main', cwd)
        self.git(['merge', '-q', '--no-ff', '--no-commit', side], cwd)
        write_lf(cwd / 'cfg.txt', SECRET)
        self.git(['add', 'cfg.txt'], cwd)
        self.git(['commit', '-qm', 'merge side'], cwd)
        return self.git(['rev-parse', 'HEAD'], cwd)

    def path_without_gitleaks(self):
        probe = ('p="$PATH"; n=0; while d=$(PATH="$p" command -v gitleaks 2>/dev/null) && [ -n "$d" ] && [ "$n" -lt 50 ]; do '
                 'n=$((n + 1)); p=$(printf "%s" "$p" | tr ":" "\\n" | grep -vxF "${d%/*}" | paste -sd: -); done; printf "%s" "$p"')
        return cmd([BASH, '-c', probe], self.wt, self.env).stdout

    def remote_refs(self):
        return cmd(['git', 'for-each-ref', '--format=%(refname) %(objectname)'], self.bare).stdout

    def remote_tip(self, branch):
        return cmd(['git', 'rev-parse', '--verify', '-q', 'refs/heads/' + branch], self.bare, check_rc=False).stdout.strip()

    def remote_has(self, sha):
        return cmd(['git', 'cat-file', '-e', sha + '^{commit}'], self.bare, check_rc=False).returncode == 0

    def record(self):
        f = self.art / 'evidence' / 'pubg-record.txt'
        return f.read_text() if f.exists() else ''


def mutating(call):
    return call[:2] in (['pr', 'create'], ['pr', 'edit'], ['pr', 'ready'], ['pr', 'comment'],
                        ['issue', 'comment'], ['issue', 'edit'], ['label', 'create'])


def publish_chain(f, label, extra=None, stop_at=None, skip_hold=False):
    rcs = {}
    names = ['noninteractive-salvage', 'commit-and-push', 'open-pr-if-needed', 'patch-pr-body', 'hold-if-findings']
    for name in names[:-1] if skip_hold else names:
        rc, out, err = f.run(name, extra if name == stop_at or stop_at is None else None)
        rcs[name] = (rc, out, err)
        if rc != 0 and name != 'hold-if-findings':
            break
    return rcs


def scenario_blocked(tmp):
    """Test 1 and Test 7 (lane order): unattended blocked run with code."""
    f = Fixture(tmp)
    f.commit_change()
    f.set_out('block-reclassify', '{"status":"BLOCKED","note":"opus-made-changes-rereview-failed"}')
    rcs = publish_chain(f, 'blocked')
    for name, (rc, out, err) in rcs.items():
        check('T1 %s exits 0 (run not failed)' % name, rc == 0, out + err)
    calls = f.gh_calls()
    creates = [c for c in calls if c[:2] == ['pr', 'create']]
    check('T1 exactly one PR create', len(creates) == 1, str(creates))
    check('T1/T7 PR created as a draft', bool(creates) and '--draft' in creates[0])
    prs = f.prs()
    pr = prs[0] if prs else {}
    head = pr.get('headRefName', '')
    check('T1 head branch ends -run-<12 hex>', re.fullmatch(r'feat/wo-fix-01-thread-%s-run-%s' % (THREAD, RUN_ID[:12]), head) is not None, head)
    body = pr.get('body', '').split('\n')
    check('T1/T7 body starts with both marker lines', body[:2] == ['Cauldron-Run: ' + RUN_ID, 'Cauldron-Lane: bdc-feature-development'], str(body[:3]))
    check('T1 body carries the banner', BANNER in body)
    check('T1 run:blocked applied', 'run:blocked' in pr.get('labels', []), str(pr.get('labels')))
    check('T1 block reason under Findings (not lane-verified)', '## Findings (not lane-verified)' in body and any('opus-made-changes-rereview-failed' in l for l in body), '\n'.join(body))
    check('T1 no merge-hold anywhere', 'merge-hold' not in json.dumps(calls) and 'merge-hold' not in pr.get('labels', []))
    check('T1 PR ready at the end', pr.get('isDraft') is False)
    ready_idx = [i for i, c in enumerate(calls) if c[:2] == ['pr', 'ready']]
    readback_idx = [i for i, c in enumerate(calls) if c[:2] == ['pr', 'view'] and '--json' in c and 'labels' in c[c.index('--json') + 1]]
    label_idx = [i for i, c in enumerate(calls) if c[:2] == ['pr', 'edit'] and '--add-label' in c]
    check('T1/T7 ready exactly once, after the label and the read-back', len(ready_idx) == 1 and label_idx and readback_idx and ready_idx[0] > max(label_idx) and ready_idx[0] > max(readback_idx), str(calls))
    check('T1/T7 ready is the last write of the run (only a read follows)', bool(ready_idx) and not any(mutating(c) for c in calls[ready_idx[0] + 1:]), str(calls[ready_idx[0]:] if ready_idx else calls))
    return f


def scenario_hold_failures(tmp_factory):
    """Test 2 (a)-(d)."""
    for variant, env in [('a', {'JSF_LABEL_FAIL': '1'}), ('b', {'JSF_DROP_BANNER': '1'})]:
        with tmp_factory() as tmp:
            f = Fixture(tmp)
            f.commit_change()
            f.set_out('block-reclassify', '{"status":"BLOCKED","note":"fixture"}')
            rcs = publish_chain(f, variant, env, stop_at='hold-if-findings')
            rc = rcs.get('hold-if-findings', (0, '', ''))[0]
            calls = f.gh_calls()
            prs = [p for p in f.prs() if p['headRefName'].endswith('-run-' + RUN_ID[:12])]
            check('T2(%s) hold-if-findings exits nonzero' % variant, rc != 0, str(rcs.get('hold-if-findings')))
            check('T2(%s) gh pr ready never called' % variant, not any(c[:2] == ['pr', 'ready'] for c in calls))
            check('T2(%s) exactly one PR on the run branch, still a draft' % variant, len(prs) == 1 and prs[0]['isDraft'] is True, str(prs))
    with tmp_factory() as tmp:
        f = Fixture(tmp)
        f.commit_change()
        f.set_out('block-reclassify', '{"status":"PROCEED"}')
        f.outputs['diff-review-final'] = 'DIFF_REVIEW_FINAL=satisfied'
        rcs = publish_chain(f, 'c', skip_hold=True)
        (f.art / 'findings').mkdir(exist_ok=True)
        write_lf(f.art / 'findings' / 'manifest-evidence-check.txt', 'FINDING=HARNESS_REFUSED: fixture late evidence finding\n')
        rc, out, err = f.run('hold-if-findings', {'JSF_LABEL_FAIL': '1'})
        prs = f.prs()
        check('T2(c) clean PROCEED created a draft without a hold', len(prs) == 1 and 'run:blocked' not in prs[0]['labels'])
        check('T2(c) a later finding that cannot be labelled fails the step', rc != 0, out + err)
        check('T2(c) gh pr ready never called', not any(c[:2] == ['pr', 'ready'] for c in f.gh_calls()))
        check('T2(c) one PR, still a draft', len(prs) == 1 and prs[0]['isDraft'] is True)
    with tmp_factory() as tmp:
        f = Fixture(tmp)
        f.commit_change()
        f.set_out('block-reclassify', '{"status":"BLOCKED","note":"fixture"}')
        f.run('noninteractive-salvage'); f.run('commit-and-push')
        rc, out, err = f.run('open-pr-if-needed', {'JSF_CREATE_LOST': '1'})
        calls = f.gh_calls()
        check('T2(d) open-pr-if-needed exits nonzero when the create response is lost', rc != 0, out + err)
        check('T2(d) no retry: exactly one create call', sum(1 for c in calls if c[:2] == ['pr', 'create']) == 1, str(calls))
        check('T2(d) no adoption: no edit, ready or record after the lost create', not any(c[:2] in (['pr', 'edit'], ['pr', 'ready']) for c in calls) and not (f.art / 'run-pr.json').exists())
        check('T2(d) the record says a draft PR may exist on the run branch', 'a draft PR may exist on the run branch' in err, err)


def open_pr_only(f, decide, recorded, extra=None):
    f.env['RECORDED_BASE_BRANCH'] = recorded
    f.env['BASE_BRANCH'] = recorded
    f.set_out('decide-push-target', decide)
    f.commit_change()
    unique = 'feat/wo-fix-01-thread-%s-run-%s' % (THREAD, RUN_ID[:12])
    f.git(['push', '-q', 'origin', 'HEAD:refs/heads/' + unique])
    f.set_out('commit-and-push', 'unique_branch=%s\npushed_sha=%s' % (unique, f.git(['rev-parse', 'HEAD'])))
    f.set_out('block-reclassify', '{"status":"PROCEED"}')
    return f.run('open-pr-if-needed', extra)


def scenario_prod_guard(tmp_factory):
    """Test 3."""
    cases = [
        ('default path to shopops master', 'push_target: feature-branch:feat/wo-fix-01\npr_required: true\nstaging_gate_required: false\nrepo: thinmansoftware/shopops', 'master', 'refuse', None),
        ('override path to shopops master', 'push_target: feature-branch:feat/wo-fix-01\npr_required: true\nstaging_gate_required: false\nbase_branch_override: master\nrepo: thinmansoftware/shopops', 'master', 'refuse', None),
        ('staging-gate path to shopops staging', 'push_target: feature-branch:feat/wo-fix-01\npr_required: true\nstaging_gate_required: true\nrepo: thinmansoftware/shopops', 'staging', 'create', 'staging'),
        ('dev_OVERRIDE is not an override', DECIDE + '\nbase_branch_override: dev_OVERRIDE', 'dev', 'create', 'dev'),
        ('main_OVERRIDE is not an override', DECIDE + '\nbase_branch_override: main_OVERRIDE', 'dev', 'create', 'dev'),
        ("empty '' is not an override", DECIDE + "\nbase_branch_override: ''", 'dev', 'create', 'dev'),
    ]
    for label, decide, recorded, want, base in cases:
        with tmp_factory() as tmp:
            f = Fixture(tmp, base=recorded)
            rc, out, err = open_pr_only(f, decide, recorded)
            creates = [c for c in f.gh_calls() if c[:2] == ['pr', 'create']]
            if want == 'refuse':
                check('T3 %s: refused with production_base_refused' % label, rc != 0 and 'production_base_refused' in err, out + err)
                check('T3 %s: no gh pr create' % label, not creates, str(creates))
            else:
                check('T3 %s: PR opened' % label, rc == 0 and len(creates) == 1, out + err)
                check('T3 %s: base %s and no override emitted' % (label, base), bool(creates) and creates[0][creates[0].index('--base') + 1] == base and 'Base branch override' not in (f.prs() or [{}])[0].get('body', ''), str(creates))


def scenario_markers(tmp):
    """Test 7: the two marker lines survive a patch-pr-body rewrite."""
    f = Fixture(tmp)
    f.commit_change()
    f.set_out('block-reclassify', '{"status":"BLOCKED","note":"fixture"}')
    f.run('noninteractive-salvage'); f.run('commit-and-push'); f.run('open-pr-if-needed')
    st = json.loads(f.state.read_text())
    pr = st['prs'][0]
    pr['body'] = 'Rewritten by a person\nCauldron-Run: someone-else\n\nmore prose\n' + pr['body']
    f.state.write_text(json.dumps(st))
    rc, out, err = f.run('patch-pr-body')
    body = f.prs()[0]['body'].split('\n')
    check('T7 patch-pr-body exits 0', rc == 0, out + err)
    check('T7 marker lines first after the rewrite', body[:2] == ['Cauldron-Run: ' + RUN_ID, 'Cauldron-Lane: bdc-feature-development'], str(body[:4]))
    check('T7 no stale marker line kept', sum(1 for l in body if l.startswith('Cauldron-Run: ')) == 1)
    rc, out, err = f.run('hold-if-findings')
    body = f.prs()[0]['body'].split('\n')
    check('T7 hold-if-findings keeps markers first, then the banner', rc == 0 and body[:4] == ['Cauldron-Run: ' + RUN_ID, 'Cauldron-Lane: bdc-feature-development', '', BANNER], str(body[:5]) + err)


def scenario_repair(tmp):
    """Test 7: repair-in-place pushes its exact branch, adopts PR #12, opens no second PR."""
    f = Fixture(tmp)
    branch = 'feat/x-thread-ab'
    f.git(['push', '-q', 'origin', 'HEAD:refs/heads/' + branch])
    lease = f.git(['rev-parse', 'HEAD'])
    write_lf(f.art / 'authority' / 'work-order.md', SPEC + 'Repair target: PR #12 (branch %s)\n' % branch)
    f.state.write_text(json.dumps({'prs': [dict(number=12, url='https://github.com/fixture/repo/pull/12', headRefName=branch, headRefOid=lease, baseRefName='dev', author={'login': 'builder'}, title='held', state='OPEN', body='Cauldron-Run: older\nheld body', labels=['run:blocked'], comments=[], isDraft=False)]}))
    f.set_out('checkout-repair-target', 'REPAIR_TARGET=#12\nREPAIR_TARGET_BRANCH=%s\nREPAIR_TARGET_LEASE_SHA=%s' % (branch, lease))
    f.set_out('decide-push-target', DECIDE.replace('feat/wo-fix-01', branch) + '\nrepair_target_pr: #12\nrepair_target_branch: %s\nrepair_target_authorized_by_spec: #12' % branch)
    f.set_out('plan-review', PLAN.replace('- file\n', '- file\nrepair_target_authorized_by_spec: #12\n'))
    f.set_out('block-reclassify', '{"status":"BLOCKED","note":"fixture"}')
    f.commit_change('repaired\n', 'repair')
    rcs = publish_chain(f, 'repair')
    ok = all(v[0] == 0 for v in rcs.values())
    check('T7 repair-in-place chain exits 0', ok, json.dumps({k: v[0] for k, v in rcs.items()}) + ''.join(v[2] for v in rcs.values()))
    heads = cmd(['git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], f.bare).stdout.split()
    check('T7 repair pushed exactly its branch (no rename, no -run- branch)', branch in heads and not any('-run-' in h for h in heads), str(heads))
    check('T7 repair branch holds the repair commit', f.git(['rev-parse', 'HEAD']) == cmd(['git', 'rev-parse', 'refs/heads/' + branch], f.bare).stdout.strip())
    calls = f.gh_calls()
    check('T7 repair opens no second PR', not any(c[:2] == ['pr', 'create'] for c in calls) and len(f.prs()) == 1)
    check('T7 repair keeps its lease (output names it)', ('REPAIR_TARGET_LEASE_SHA=' + lease) in rcs['commit-and-push'][1], rcs['commit-and-push'][1][-800:])


def scenario_scope(tmp_factory):
    """Test 10: lane-scope-check refuses doctrine-only and a missing declared base."""
    for label, spec, want_ok in [
        ('doctrine-only spec', 'WO Class: DOCTRINE\ntarget_repo: fixture/repo\n', False),
        ('declared base that does not exist', 'WO Class: CODE\ntarget_repo: fixture/repo\nBase branch: no-such-base\n', False),
        ('declared base that exists', SPEC, True),
    ]:
        with tmp_factory() as tmp:
            f = Fixture(tmp)
            write_lf(f.art / 'authority' / 'work-order.md', spec)
            rc, out, err = f.run('lane-scope-check')
            if want_ok:
                check('T10 %s: LANE_SCOPE=ok' % label, rc == 0 and out == 'LANE_SCOPE=ok', out + err)
            else:
                check('T10 %s: exits nonzero, out_of_scope' % label, rc != 0 and 'out_of_scope' in err, out + err)


def scenario_salvage(tmp_factory):
    """Test 11 (a) a failed checkpoint stage, (b) no push target handed over."""
    for variant in ['a', 'b']:
        with tmp_factory() as tmp:
            f = Fixture(tmp)
            f.commit_change()
            write_lf(f.wt / 'salvaged.txt', 'left uncommitted by the build\n')
            f.set_out('block-reclassify', '{"status":"BLOCKED","note":"fixture"}')
            if variant == 'a':
                (f.art / 'findings').mkdir()
                write_lf(f.art / 'findings' / 'checkpoint-diff-repair.txt', 'FINDING=checkpoint_diff_repair_stage_failed path=salvaged.txt (salvaged by noninteractive-salvage)\n')
            else:
                f.drop_out('decide-push-target')
            before_refs = cmd(['git', 'for-each-ref'], f.bare).stdout
            rc, out, err = f.run('noninteractive-salvage')
            calls_after_salvage = f.gh_calls()
            check('T11(%s) salvage exits 0' % variant, rc == 0, out + err)
            check('T11(%s) salvage makes no push' % variant, cmd(['git', 'for-each-ref'], f.bare).stdout == before_refs)
            check('T11(%s) salvage makes no gh call (no PR create)' % variant, calls_after_salvage == [], str(calls_after_salvage))
            msg = f.git(['log', '-1', '--format=%B'])
            check('T11(%s) salvage commits on the run branch with the trailer' % variant, 'Cauldron-Role: salvage' in msg and f.git(['branch', '--show-current']) == 'archon/thread-' + THREAD, msg)
            if variant == 'b':
                f.set_out('decide-push-target', 'repo: fixture/repo\npr_required: true\nstaging_gate_required: false')
            runs = 0
            for name in ['commit-and-push', 'open-pr-if-needed', 'patch-pr-body', 'hold-if-findings']:
                rc, out, err = f.run(name)
                runs += name == 'commit-and-push'
                check('T11(%s) %s exits 0' % (variant, name), rc == 0, out + err)
            prs = f.prs()
            pr = prs[0] if prs else {}
            check('T11(%s) commit-and-push ran once and one PR exists' % variant, runs == 1 and len(prs) == 1, str(prs))
            want = r'feat/wo-fix-01-thread-%s-run-%s' % (THREAD, RUN_ID[:12])
            check('T11(%s) branch %s' % (variant, 'derived in-node' if variant == 'b' else 'from push target'), re.fullmatch(want, pr.get('headRefName', '')) is not None, pr.get('headRefName', ''))
            tree = cmd(['git', 'ls-tree', '--name-only', pr.get('headRefOid', 'HEAD')], f.bare, check_rc=False).stdout.split()
            check('T11(%s) the PR contains the salvaged file' % variant, 'salvaged.txt' in tree, str(tree))
            body = pr.get('body', '').split('\n')
            check('T11(%s) run:blocked, banner and both markers' % variant, 'run:blocked' in pr.get('labels', []) and BANNER in body and body[:2] == ['Cauldron-Run: ' + RUN_ID, 'Cauldron-Lane: bdc-feature-development'], str(pr.get('labels')) + str(body[:4]))
            calls = f.gh_calls()
            check('T11(%s) readied last' % variant, pr.get('isDraft') is False and [c[:2] for c in calls if mutating(c)][-1] == ['pr', 'ready'])


def scenario_evidence(tmp):
    """Test 9: evidence and consistency findings do not end the run; both go in the body."""
    f = Fixture(tmp)
    f.commit_change()
    f.set_out('block-reclassify', '{"status":"PROCEED"}')
    f.outputs['diff-review-final'] = 'DIFF_REVIEW_FINAL=satisfied'
    for name in ['noninteractive-salvage', 'commit-and-push', 'open-pr-if-needed']:
        f.run(name)
    f.set_out('run-stop-tests-final', 'TESTS_CLASS=CODE\nTESTS_STATUS=passed\nTESTS_EXIT=0')
    f.set_out('run-stop-greps', 'GREP_DECLARED=2\nGREP_STATUS=all_dropped\nGREP_EXECUTED=0\nGREP_DROPPED=2\nGREP_UNPARSED=0\nGREP_MISMATCH=0')
    f.set_out('stamp-manifest-evidence', 'Tests: 1/1 (fixture)\nGrep assertions: none executed')
    rc, out, err = f.run('manifest-evidence-check')
    check('T9 manifest-evidence-check exits 0 with a FINDING (HARNESS_REFUSED)', rc == 0 and out.startswith('FINDING=HARNESS_REFUSED'), out + err)
    f.set_out('stamp-manifest-pr', 'WO: %s\nFiles created: docs/missing.md\nFiles modified: none\nPRs: x\nVALIDATION: PASS' % WO)
    helper = f.t / 'pr-files.sh'
    write_lf(helper, '#!/usr/bin/env bash\necho file\n')
    rc, out, err = f.run('manifest-consistency-check', {'BDC_PR_FILES_HELPER': helper.as_posix()})
    check('T9 manifest-consistency-check exits 0 with a FINDING (missing path)', rc == 0 and 'FINDING=PR_CONTENT_ERROR' in out and 'OK' not in out.split('\n'), out + err)
    rc, out, err = f.run('patch-pr-body')
    body = f.prs()[0]['body']
    sect = body.split('## Findings (not lane-verified)')[-1] if '## Findings (not lane-verified)' in body else ''
    check('T9 patch-pr-body writes both findings under the heading', rc == 0 and 'HARNESS_REFUSED' in sect and 'PR_CONTENT_ERROR' in sect, body)
    rc, out, err = f.run('hold-if-findings')
    pr = f.prs()[0]
    check('T9 hold-if-findings holds the PR (run:blocked) and readies it', rc == 0 and 'run:blocked' in pr['labels'] and pr['isDraft'] is False, out + err)


def scenario_returned(tmp):
    """Correction F, lane: a question with no code returns to the author, no push, no PR."""
    f = Fixture(tmp)
    f.set_out('plan-review', 'UNATTENDED_QUESTION=true')
    f.drop_out('implement')
    (f.art / 'questions').mkdir()
    write_lf(f.art / 'questions' / 'plan-review.md', 'Which base should the PR target?\n')
    rc, out, err = f.run('assert-implement-produced-work')
    check('F assert-implement-produced-work returns to author (exact one-line output)', rc == 0 and out == 'BUILD_OUTCOME=RETURNED_TO_AUTHOR', out + err)
    f.set_out('block-reclassify', '{"status":"BLOCKED","note":"opus-could-not-resolve"}')
    rc, out, err = f.run('blocked-issue')
    st = json.loads(f.state.read_text())
    comments = st.get('issue_comments', [])
    check('F blocked-issue posts the question on the issue', rc == 0 and comments and 'Which base should the PR target?' in comments[0]['body'], out + err)
    ev = [json.loads(l[len('BDC_RUN_EVENT '):]) for l in out.split('\n') if l.startswith('BDC_RUN_EVENT ')]
    check('F run_outcome=returned_to_author event', len(ev) == 1 and ev[0].get('event_type') == 'run_outcome' and ev[0].get('outcome') == 'returned_to_author', out)
    check('F no push and no PR', not f.prs() and cmd(['git', 'for-each-ref', 'refs/heads/'], f.bare).stdout.count('\n') == 1)


# ---------------------------------------------------------------------------------------------
# Slice 2: the guarded publication core (pubg_push), Tests 4, 13, 20 and rule 1b.
# ---------------------------------------------------------------------------------------------

PROCEED = '{"status":"PROCEED"}'
VARIANTS = ['clean', 'secret', 'tracking', 'absent', 'shape', 'lease', 'merge']
WORKER = 'archon/task-web-worker-1790865294847-n1qba8'


def variant_commits(f, v, cwd=None, tracking=()):
    """Apply one variant's commits in cwd (default the run worktree); returns extra env."""
    env = {}
    if v == 'secret':
        f.commit_file('cfg.txt', SECRET, 'add config', cwd)
    elif v == 'tracking':
        # C1 carries the secret; C2 removes it. Only local remote-tracking refs claim C1 is on the
        # remote; a bound taken from them would scan C2 alone and pass.
        c1 = f.commit_file('cfg.txt', SECRET, 'add config', cwd)
        f.commit_file('cfg.txt', 'clean = 1\n', 'clean config', cwd)
        for ref in tracking:
            f.git(['update-ref', 'refs/remotes/origin/' + ref, c1])
    elif v == 'merge':
        f.merge_secret(cwd)
    else:
        f.commit_file('feature.txt', 'feature\n', 'feature', cwd)
    if v == 'absent':
        env['PATH'] = f.path_without_gitleaks()
    return env


def p_checkpoint(f, v):
    env = variant_commits(f, v, tracking=('dev',))
    write_lf(f.wt / 'dirty.txt', 'checkpoint me\n')
    if v == 'shape':
        env['WO_ID'] = 'WO..BAD'

    def ok():
        heads = [l.split() for l in f.remote_refs().splitlines() if ' ' in l]
        return any(r.startswith('refs/heads/wip/' + WO + '-') and s == f.git(['rev-parse', 'HEAD']) for r, s in heads)
    return (lambda: f.run('checkpoint-push', env)), ok


def p_backup(f, v):
    holder = f.t / 'holder'
    f.git(['worktree', 'add', '-q', '-b', 'feat/x', str(holder)])
    env = variant_commits(f, v, cwd=holder, tracking=('feat/x', 'dev'))
    write_lf(holder / 'dirty.txt', 'holder work\n')
    text = node_text('checkout-repair-target')
    core = text[text.index('# ---- BEGIN rtw core'):text.index('# ---- END rtw core ----')]
    after = text[text.index('# ---- END rtw core ----'):text.index('rtw_checkout_repair_branch "$SPEC_REPAIR_BRANCH"')]
    branch = 'a..b' if v == 'shape' else 'feat/x'
    script = ('set -euo pipefail\n' + core + after + 'holder=%s\nbranch=%s\nbest_id=deadbeefcafe\nrtw_backup_dirty_holder\n'
              % (shlex.quote(holder.as_posix()), shlex.quote(branch)))

    def ok():
        heads = [l.split() for l in f.remote_refs().splitlines() if ' ' in l]
        hit = [s for r, s in heads if r.startswith('refs/heads/backup/feat/x-dirty-')]
        return len(hit) == 1 and 'dirty.txt' in cmd(['git', 'ls-tree', '--name-only', hit[0]], f.bare).stdout.split()
    return (lambda: f.run('rtw-backup', env, text=script)), ok


def p_cap_plain(f, v):
    env = variant_commits(f, v, tracking=(UNIQUE, 'dev'))
    f.set_out('block-reclassify', PROCEED)
    if v == 'shape':
        f.set_out('decide-push-target', DECIDE.replace('feature-branch:feat/wo-fix-01', 'feature-branch:main'))
    return (lambda: f.run('commit-and-push', env)), (lambda: f.remote_tip(UNIQUE) == f.git(['rev-parse', 'HEAD']))


def setup_repair(f, branch='feat/x-thread-ab'):
    f.git(['push', '-q', 'origin', 'HEAD:refs/heads/' + branch])
    lease = f.git(['rev-parse', 'HEAD'])
    write_lf(f.art / 'authority' / 'work-order.md', SPEC + 'Repair target: PR #12 (branch %s)\n' % branch)
    f.state.write_text(json.dumps({'prs': [dict(number=12, url='https://github.com/fixture/repo/pull/12', headRefName=branch, headRefOid=lease, baseRefName='dev', author={'login': 'builder'}, title='held', state='OPEN', body='Cauldron-Run: older\nheld body', labels=['run:blocked'], comments=[], isDraft=False)]}))
    f.set_out('checkout-repair-target', 'REPAIR_TARGET=#12\nREPAIR_TARGET_BRANCH=%s\nREPAIR_TARGET_LEASE_SHA=%s' % (branch, lease))
    f.set_out('decide-push-target', DECIDE.replace('feat/wo-fix-01', branch) + '\nrepair_target_pr: #12\nrepair_target_branch: %s\nrepair_target_authorized_by_spec: #12' % branch)
    f.set_out('plan-review', PLAN.replace('- file\n', '- file\nrepair_target_authorized_by_spec: #12\n'))
    return lease


def p_cap_lease(f, v):
    branch = 'feat/x-thread-ab'
    lease = setup_repair(f, branch)
    env = variant_commits(f, v, tracking=(branch, 'dev'))
    if v == 'lease':
        moved = f.git(['commit-tree', lease + '^{tree}', '-p', lease, '-m', 'moved by someone else'])
        f.git(['push', '-q', '-f', 'origin', moved + ':refs/heads/' + branch])
    if v == 'shape':
        f.set_out('checkout-repair-target', 'REPAIR_TARGET=#12\nREPAIR_TARGET_BRANCH=main\nREPAIR_TARGET_LEASE_SHA=%s' % lease)
        f.set_out('decide-push-target', DECIDE.replace('feat/wo-fix-01', 'main') + '\nrepair_target_pr: #12\nrepair_target_branch: main\nrepair_target_authorized_by_spec: #12')
    f.set_out('block-reclassify', PROCEED)
    return (lambda: f.run('commit-and-push', env)), (lambda: f.remote_tip(branch) == f.git(['rev-parse', 'HEAD']))


def p_opr_recovery(f, v):
    env = variant_commits(f, v, tracking=(UNIQUE, 'dev'))
    out = 'unique_branch=%s' % ('main' if v == 'shape' else UNIQUE)
    if v == 'lease':
        f.git(['push', '-q', 'origin', f.base_sha + ':refs/heads/' + UNIQUE])
        out += '\nREPAIR_TARGET_LEASE_SHA=' + 'f' * 40
    f.set_out('commit-and-push', out)
    f.set_out('block-reclassify', PROCEED)
    env['JSF_FAST_SLEEP'] = '1'

    def ok():
        return f.remote_tip(UNIQUE) == f.git(['rev-parse', 'HEAD']) and sum(1 for c in f.gh_calls() if c[:2] == ['pr', 'create']) == 1
    return (lambda: f.run('open-pr-if-needed', env)), ok


def p_opr_adopt(f, v):
    target = 'main' if v == 'shape' else WORKER
    if v != 'shape':
        f.git(['switch', '-q', '-c', WORKER])
    f.git(['push', '-q', 'origin', 'HEAD:refs/heads/' + target])
    f.state.write_text(json.dumps({'prs': [dict(number=7, url='https://github.com/fixture/repo/pull/7', headRefName=target, headRefOid=f.base_sha, baseRefName='dev', author={'login': 'builder'}, title=WO, state='OPEN', body='Cauldron-Run: ' + RUN_ID + '\nbody', labels=[], comments=[], isDraft=True)]}))
    env = variant_commits(f, v, tracking=(target, 'dev'))
    unique = 'main' if v == 'shape' else UNIQUE
    f.git(['push', '-q', '-f', 'origin', 'HEAD:refs/heads/' + unique])  # what commit-and-push already published
    out = 'unique_branch=' + unique
    if v == 'lease':
        out += '\nREPAIR_TARGET_LEASE_SHA=' + 'f' * 40
    f.set_out('commit-and-push', out)
    f.set_out('block-reclassify', PROCEED)
    env['JSF_FAST_SLEEP'] = '1'

    def ok():
        return f.remote_tip(WORKER) == f.git(['rev-parse', 'HEAD']) and not any(c[:2] == ['pr', 'create'] for c in f.gh_calls())
    return (lambda: f.run('open-pr-if-needed', env)), ok


PUB_PATHS = [
    ('checkpoint-push wip/', p_checkpoint, False),
    ('checkout-repair-target backup/', p_backup, False),
    ('commit-and-push plain', p_cap_plain, False),
    ('commit-and-push lease', p_cap_lease, True),
    ('open-pr recovery re-push', p_opr_recovery, True),
    ('open-pr adopt push', p_opr_adopt, True),
]


def scenario_publication(tf):
    """Test 13 (and Test 4 on commit-and-push): every publication path x every variant."""
    for label, driver, has_lease in PUB_PATHS:
        for v in VARIANTS:
            if v == 'lease' and not has_lease:
                continue  # this path never carries a lease (no lease argument reaches pubg_push)
            with tf() as tmp:
                f = Fixture(tmp)
                run, ok = driver(f, v)
                before = f.remote_refs()
                rc, out, err = run()
                text = out + err + f.record()
                tag = 'T13 %s [%s]' % (label, v)
                check(tag + ': synthetic key text never printed', KEY not in text, text[-600:])
                if v == 'clean':
                    check(tag + ': clean range pushes (exit 0)', rc == 0 and ok(), text[-1500:])
                    check(tag + ': published head recorded', (f.art / 'evidence' / 'published.head').exists() and 'pubg_published:' in f.record(), f.record())
                    continue
                check(tag + ': step exits nonzero', rc != 0, text[-1500:])
                check(tag + ': nothing reaches the remote', f.remote_refs() == before, f.remote_refs() + '\n--\n' + before)
                if v in ('secret', 'tracking', 'merge'):
                    check(tag + ': refused as secret_found naming file and rule', 'secret_found:' in text and 'file=cfg.txt' in text and 'rule=aws-access-token' in text, text[-1500:])
                if v == 'absent':
                    check(tag + ': missing scanner refuses', 'scanner_missing' in text, text[-1500:])
                if v == 'lease':
                    # commit-and-push's own HARD repair check (repair_target_head_moved, kept from
                    # dev) sees the moved branch before pubg_push; the other lease paths reach
                    # pubg_push's lease_mismatch.
                    check(tag + ': lease mismatch refuses', any(m in text for m in ('lease_mismatch', 'repair_target_lease_rejected', 'repair_target_head_moved')), text[-1500:])


def core_script(body):
    return 'set -uo pipefail\n. "$ARTIFACTS_DIR/evidence/pubg.core.sh"\n' + body + '\n'


def scenario_pubg_core(tf):
    """pubg_push itself: the ref shape, the default/base refusal, the full-history bound, no-op."""
    with tf() as tmp:
        f = Fixture(tmp)
        f.commit_file('feature.txt', 'feature\n', 'feature')
        for dest, why in [('main', 'not a run branch'), ('dev', 'the base branch'), ('release/x', 'not a run branch')]:
            before = f.remote_refs()
            rc, out, err = f.run('core-' + dest.replace('/', '-'), text=core_script('pubg_push HEAD %s' % dest))
            check('pubg refuses %s (%s)' % (dest, why), rc == 1 and 'bad_ref' in err and f.remote_refs() == before, err)
        cmd(['git', 'symbolic-ref', 'HEAD', 'refs/heads/feat/default'], f.bare)
        f.git(['push', '-q', 'origin', f.base_sha + ':refs/heads/feat/default'])
        before = f.remote_refs()
        rc, out, err = f.run('core-default', text=core_script('pubg_push HEAD feat/default'))
        check('pubg refuses the remote default branch', rc == 1 and 'default branch' in err and f.remote_refs() == before, err)
        rc, out, err = f.run('core-ok', text=core_script('pubg_push HEAD feat/ok-thread-x'))
        head = f.git(['rev-parse', 'HEAD'])
        check('pubg publishes a clean run branch bounded by the base tip', rc == 0 and f.remote_tip('feat/ok-thread-x') == head and 'scanned=remote tip of base dev' in err, err)
        check('pubg writes the published head', (f.art / 'evidence' / 'published.head').read_text().strip() == head)
        calls = len(f.gh_calls())
        rc, out, err = f.run('core-noop', text=core_script('pubg_push HEAD feat/ok-thread-x'))
        check('pubg: a ref already at the SHA publishes nothing new and exits 0', rc == 0 and 'pubg_published:' in err and 'scanned=' not in err.split('pubg_published:')[-1], err)
        check('pubg makes no gh call', len(f.gh_calls()) == calls)
    with tf() as tmp:
        f = Fixture(tmp)
        # An unrelated history: no remote tip is an ancestor, so the whole history is scanned. The
        # secret sits in the orphan root, two commits below the pushed SHA.
        f.git(['switch', '-q', '--orphan', 'orphan'])
        f.commit_file('cfg.txt', SECRET, 'orphan root with config')
        f.commit_file('cfg.txt', 'clean = 1\n', 'clean config')
        f.commit_file('other.txt', 'x\n', 'other')
        before = f.remote_refs()
        rc, out, err = f.run('core-full', text=core_script('pubg_push HEAD feat/orphan-thread-x'))
        check('pubg: no provable bound scans the full history and refuses the old secret', rc == 1 and 'secret_found' in err and 'full history' in err and f.remote_refs() == before, err)
        check('pubg: key text never printed (full history)', KEY not in out + err + f.record())
    with tf() as tmp:
        f = Fixture(tmp)
        f.git(['switch', '-q', '--orphan', 'orphan'])
        f.commit_file('a.txt', 'a\n', 'orphan a')
        rc, out, err = f.run('core-full-clean', text=core_script('pubg_push HEAD feat/orphan-thread-y'))
        check('pubg: a clean unrelated history is scanned in full, then pushed', rc == 0 and 'scanned=full history' in err and f.remote_tip('feat/orphan-thread-y') == f.git(['rev-parse', 'HEAD']), err)


def rmtree_force(path):
    """Delete a tree, including Git's read-only object files (Windows)."""
    def onerror(func, p, exc):
        os.chmod(p, 0o700)
        func(p)
    shutil.rmtree(path, onerror=onerror)


def publish_through_open_pr(f):
    f.commit_change()
    f.set_out('block-reclassify', PROCEED)
    f.outputs['diff-review-final'] = 'DIFF_REVIEW_FINAL=satisfied'
    for name in ['noninteractive-salvage', 'commit-and-push', 'open-pr-if-needed']:
        rc, out, err = f.run(name)
        if rc != 0:
            raise RuntimeError(name + ' failed: ' + out + err)


def scenario_refused_edit(tf):
    """Test 20, refused-push variants: an edit authored after publication is refused, preserved in
    the host mount, and recovered from the bundle alone after the worktree is released."""
    for variant in ['secret', 'lease', 'no-mount']:
        with tf() as tmp:
            f = Fixture(tmp)
            publish_through_open_pr(f)
            published = (f.art / 'evidence' / 'published.head').read_text().strip()
            pr_before = f.prs()[0]
            if variant == 'lease':
                write_lf(f.wt / 'file', 'edited by the in-run Overseer\n')
            else:
                write_lf(f.wt / 'cfg.txt', SECRET)
            f.git(['add', '-A'])
            f.git(['commit', '-qm', 'fix: in-run Overseer edit\n\nCauldron-Role: overseer-repair'])
            edit = f.git(['rev-parse', 'HEAD'])
            authored = cmd(['git', 'diff', '--binary', edit + '^', edit], f.wt).stdout
            if variant == 'no-mount':
                shutil.rmtree(f.host)
            lease = ' ' + 'f' * 40 if variant == 'lease' else ''
            rc, out, err = f.run('look-push', text=core_script('pubg_push "$(git rev-parse HEAD)" %s%s' % (UNIQUE, lease)))
            text = out + err + f.record()
            tag = 'T20(%s)' % variant
            check(tag + ' the push of the edit is refused (nonzero)', rc != 0, text[-1500:])
            check(tag + ' the fake remote holds no commit of the edit', not f.remote_has(edit) and f.remote_tip(UNIQUE) == published)
            check(tag + ' key text never printed', KEY not in text)
            rc, out, err = f.run('hold-if-findings')
            calls = f.gh_calls()
            pr = f.prs()[0]
            check(tag + ' hold-if-findings fails the run', rc != 0 and 'not the published head' in err, out + err)
            check(tag + ' gh pr ready never called', not any(c[:2] == ['pr', 'ready'] for c in calls))
            check(tag + ' the PR stays a draft at its last published head', pr['isDraft'] is True and pr['headRefOid'] == published and pr['number'] == pr_before['number'] and len(f.prs()) == 1)
            bundle = f.host / RUN_ID / ('unpublished-%s.bundle' % edit[:12])
            if variant == 'no-mount':
                check(tag + ' the run record says the edit was not preserved, with the reason', 'pubg_not_preserved' in f.record() and edit in f.record() and 'absent' in f.record(), f.record())
                continue
            check(tag + ' the run record names the edit head SHA and the bundle path', ('pubg_preserved: bundle=%s head=%s' % (bundle.as_posix(), edit)) in f.record(), f.record())
            check(tag + ' the bundle exists in the host mount', bundle.is_file())
            rmtree_force(f.wt)  # the lane's cleanup releases the worktree
            check(tag + ' the worktree is released', not f.wt.exists())
            probe = f.t / 'probe'
            cmd(['git', 'init', '-q', str(probe)], f.t)
            check(tag + ' git bundle verify passes on the bundle alone', cmd(['git', 'bundle', 'verify', str(bundle)], probe, check_rc=False).returncode == 0)
            rec = f.t / 'recovered.git'
            cmd(['git', 'clone', '-q', '--bare', str(bundle), str(rec)], f.t)
            check(tag + ' the clone has the edit commit at the recorded SHA', cmd(['git', 'cat-file', '-e', edit + '^{commit}'], rec, check_rc=False).returncode == 0)
            check(tag + ' with the same trailer', 'Cauldron-Role: overseer-repair' in cmd(['git', 'log', '-1', '--format=%B', edit], rec).stdout)
            check(tag + ' and its diff equals the authored change byte for byte', cmd(['git', 'diff', '--binary', edit + '^', edit], rec).stdout == authored)


def scenario_rule_1b(tf):
    """Rule 1b: a run with one failed node and no finding is labelled run:blocked before ready."""
    for failed, want in [('checkpoint-push', True), ('', False)]:
        with tf() as tmp:
            f = Fixture(tmp)
            publish_through_open_pr(f)
            rc, out, err = f.run('patch-pr-body')
            f.failed_nodes = failed
            rc, out, err = f.run('hold-if-findings')
            pr = f.prs()[0]
            body = pr['body'].split('\n')
            tag = '1b failed_nodes=%s' % (failed or "''")
            check(tag + ': hold-if-findings exits 0 and readies the PR', rc == 0 and pr['isDraft'] is False, out + err)
            if want:
                check(tag + ': run:blocked and the banner are applied', 'run:blocked' in pr['labels'] and BANNER in body, str(pr['labels']))
                check(tag + ': the failed node is the stated reason', 'recorded failed: checkpoint-push' in out, out)
                calls = f.gh_calls()
                label_idx = [i for i, c in enumerate(calls) if c[:2] == ['pr', 'edit'] and '--add-label' in c]
                ready_idx = [i for i, c in enumerate(calls) if c[:2] == ['pr', 'ready']]
                check(tag + ': labelled and read back before ready', label_idx and ready_idx and ready_idx[0] > label_idx[-1])
            else:
                check(tag + ': a clean PROCEED with no failed node is readied without run:blocked', 'run:blocked' not in pr['labels'] and BANNER not in body, str(pr['labels']) + out)


def scenario_unpublished(tf):
    """The ready check: an uncommitted change or an unpublished commit keeps the PR a draft."""
    for kind in ['uncommitted', 'unpublished-commit']:
        with tf() as tmp:
            f = Fixture(tmp)
            publish_through_open_pr(f)
            if kind == 'uncommitted':
                write_lf(f.wt / 'left-behind.txt', 'never published\n')
            else:
                f.commit_file('late.txt', 'late\n', 'late commit')
            rc, out, err = f.run('hold-if-findings')
            pr = f.prs()[0]
            check('ready check (%s): hold-if-findings fails' % kind, rc != 0, out + err)
            check('ready check (%s): no ready call, the PR stays a draft' % kind, not any(c[:2] == ['pr', 'ready'] for c in f.gh_calls()) and pr['isDraft'] is True)


class TmpFactory:
    def __call__(self):
        return tempfile.TemporaryDirectory(prefix='.june-shape-', dir=ROOT, ignore_cleanup_errors=True)


def once(tf, fn):
    with tf() as tmp:
        fn(tmp)


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    tf = TmpFactory()
    table = {
        'blocked': lambda: once(tf, scenario_blocked),
        'hold-failures': lambda: scenario_hold_failures(tf),
        'prod-guard': lambda: scenario_prod_guard(tf),
        'markers': lambda: once(tf, scenario_markers),
        'repair': lambda: once(tf, scenario_repair),
        'scope': lambda: scenario_scope(tf),
        'salvage': lambda: scenario_salvage(tf),
        'evidence': lambda: once(tf, scenario_evidence),
        'returned': lambda: once(tf, scenario_returned),
        'publication': lambda: scenario_publication(tf),
        'pubg-core': lambda: scenario_pubg_core(tf),
        'refused-edit': lambda: scenario_refused_edit(tf),
        'rule-1b': lambda: scenario_rule_1b(tf),
        'unpublished': lambda: scenario_unpublished(tf),
    }
    names = list(table) if which == 'all' else [which]
    for name in names:
        try:
            table[name]()
        except Exception as exc:  # a crashed scenario is a failure, never a pass
            check('scenario %s completed' % name, False, '%s: %s' % (type(exc).__name__, exc))
    print('june-shape-fixture %s: %d passed, %d failed' % (which, RESULTS['pass'], RESULTS['fail']))
    sys.exit(min(RESULTS['fail'], 100))


if __name__ == '__main__':
    main()
