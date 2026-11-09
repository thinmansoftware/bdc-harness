"""Run real lane bash against local bare Git and a stateful, network-free gh stub."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[5]
YAML = ROOT / '.archon/workflows/defaults/bdc-feature-development.yaml'
WO = 'WO-ENV-FIXTURE'
REPO = 'fixture/repo'


def cmd(args, cwd, env=None, check=True):
    return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, check=check)


def node(name):
    lines = YAML.read_text().splitlines()
    start = lines.index('  - id: ' + name)
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith('  - id: ')), len(lines))
    start = next(i for i in range(start, end) if lines[i] == '    bash: |') + 1
    text = '\n'.join(line[6:] if line.startswith('      ') else '' for line in lines[start:end])
    for ref, value in {
        'block-reclassify': '{"status":"BLOCKED"}',
        'plan-review': '=== APPROVED_PLAN_BEGIN ===\nCommit message: fixture\n=== APPROVED_PLAN_END ===',
        'implement': 'fixture complete', 'war-council-validator': 'satisfied',
    }.items():
        text = text.replace('$' + ref + '.output', value)
    return text


STUB = '''import json, os, sys
from pathlib import Path
import subprocess
p=Path(os.environ['PR_FIXTURE_STATE']); d=json.loads(p.read_text()); a=sys.argv[1:]
def opt(flag): return a[a.index(flag)+1]
def save(): p.write_text(json.dumps(d))
if a[:2]==['api','user']: print('builder')
elif a[:2]==['pr','list']:
    items=[v for v in d['prs'] if v.get('state','OPEN')=='OPEN']
    if os.environ.get('PR_FIXTURE_HIDE_CREATED'): items=[v for v in items if v['number']<100]
    if '--head' in a: items=[v for v in items if v['headRefName']==opt('--head')]
    print(json.dumps(items))
elif a[:2]==['pr','view']:
    item=next(v for v in d['prs'] if str(v['number'])==a[2] or v['url']==a[2])
    print(json.dumps(item))
elif a[:2]==['pr','create']:
    n=100+len(d['prs']); branch=opt('--head')
    sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    d['prs'].append(dict(number=n,url='https://github.com/fixture/repo/pull/'+str(n),headRefName=branch,headRefOid=sha,baseRefName=opt('--base'),author={'login':'builder'},title=opt('--title'),body=Path(opt('--body-file')).read_text() if '--body-file' in a else opt('--body'),comments=[],state='OPEN'))
    save(); print(d['prs'][-1]['url'])
    if os.environ.get('PR_FIXTURE_HIDE_CREATED'): raise SystemExit(1)
elif a[:2]==['pr','comment']:
    item=next(v for v in d['prs'] if str(v['number'])==a[2] or v['url']==a[2])
    item['comments'].append({'body':Path(opt('--body-file')).read_text()}); save(); print('commented')
else: raise SystemExit('unexpected gh call: '+str(a))
'''


def fixture(t):
    bare = t / 'origin.git'
    wt = t / 'wt'
    cmd(['git', 'init', '--bare', '-q', str(bare)], t)
    cmd(['git', 'clone', '-q', str(bare), str(wt)], t)
    for key, value in [('user.name', 'Fixture'), ('user.email', 'fixture@example.invalid'), ('core.hooksPath', str(t / 'no-hooks'))]:
        cmd(['git', 'config', key, value], wt)
    cmd(['git', 'switch', '-c', 'dev'], wt)
    (wt / 'file').write_text('base\n')
    cmd(['git', 'add', 'file'], wt)
    cmd(['git', 'commit', '-qm', 'base'], wt)
    base = cmd(['git', 'rev-parse', 'HEAD'], wt).stdout.strip()
    cmd(['git', 'push', '-q', 'origin', 'dev'], wt)
    branch = 'archon/task-web-worker-fixture'
    cmd(['git', 'switch', '-c', branch], wt)
    (wt / 'file').write_text('first\n')
    cmd(['git', 'commit', '-qam', 'first'], wt)
    ancestor = cmd(['git', 'rev-parse', 'HEAD'], wt).stdout.strip()
    cmd(['git', 'push', '-q', 'origin', 'HEAD:' + branch], wt)
    (wt / 'file').write_text('final\n')
    cmd(['git', 'commit', '-qam', 'final'], wt)
    head = cmd(['git', 'rev-parse', 'HEAD'], wt).stdout.strip()
    unique = 'feat/wo-env-fixture-thread-unique'
    cmd(['git', 'push', '-q', 'origin', 'HEAD:' + unique], wt)
    artifacts = t / 'artifacts'; artifacts.mkdir()
    out = artifacts / 'node-out'; out.mkdir()
    (out / 'read-spec.out').write_text('WO_ID=' + WO + '\n')
    (out / 'decide-push-target.out').write_text('pr_required: true\nrepo: fixture/repo\nstaging_gate_required: false\n')
    (out / 'commit-and-push.out').write_text('unique_branch=' + unique + '\n')
    bindir = t / 'bin'; bindir.mkdir()
    (bindir / 'gh').write_text('#!/usr/bin/env bash\nexec python3 "' + (t / 'gh.py').as_posix() + '" "$@"\n')
    (t / 'gh.py').write_text(STUB)
    (bindir / 'gh').chmod(0o755)
    state = t / 'state.json'
    env = dict(os.environ, PATH=str(bindir) + os.pathsep + os.environ['PATH'], ARTIFACTS_DIR=str(artifacts), ARCHON_NODE_OUT=str(out), WORKFLOW_ID='fixture-run', WO_ID=WO, USER_MESSAGE=WO, RECORDED_BASE_BRANCH='dev', BASE_BRANCH='dev', PR_FIXTURE_STATE=str(state), CAULDRON_INTERACTIVE='false', TMPDIR=str(t), TEMP=str(t), TMP=str(t))
    return wt, bare, artifacts, state, env, branch, unique, ancestor, head, base


def primary(branch, sha, **updates):
    return dict(number=7, url='https://github.com/fixture/repo/pull/7', headRefName=branch, headRefOid=sha, baseRefName='dev', author={'login': 'builder'}, title=WO, body='original verified body', comments=[], state='OPEN', **updates)


def drive(t, wt, env, name, expected=0):
    script = t / (name + '.sh'); script.write_text(node(name))
    result = cmd(['bash', str(script)], wt, env, check=False)
    assert (result.returncode == 0) == (expected == 0), result.stdout + result.stderr
    return result.stdout


def run_adopt():
    for case in ['own-ancestor', 'unique-ancestor', 'unrelated-branch', 'other-author', 'wrong-base', 'non-ancestor', 'ambiguous-create']:
        if os.environ.get('PR_FIXTURE_CASE') and os.environ['PR_FIXTURE_CASE'] != case:
            continue
        with tempfile.TemporaryDirectory(prefix='.pr-fixture-', dir=ROOT) as tmp:
            t = Path(tmp)
            wt, bare, artifacts, state, env, branch, unique, ancestor, head, base = fixture(t)
            pr = primary(unique if case == 'unique-ancestor' else branch, ancestor)
            if case == 'unrelated-branch':
                pr['headRefName'] = 'feat/another-run'
                cmd(['git', 'push', '-q', 'origin', ancestor + ':refs/heads/feat/another-run'], wt)
            if case == 'other-author': pr['author'] = {'login': 'someone-else'}
            if case == 'wrong-base': pr['baseRefName'] = 'other-base'
            if case == 'non-ancestor': pr['headRefOid'] = 'f' * 40
            state.write_text(json.dumps({'prs': [] if case == 'ambiguous-create' else [pr]}))
            if case == 'ambiguous-create':
                env['PR_FIXTURE_HIDE_CREATED'] = '1'
                drive(t, wt, env, 'open-pr-if-needed', expected=1)
                drive(t, wt, env, 'open-pr-if-needed', expected=1)
                assert len(json.loads(state.read_text())['prs']) == 1
                assert not (artifacts / 'run-pr.lock').exists()
                print('PASS: ambiguous create is not repeated on replay', flush=True)
                continue
            before = cmd(['git', 'for-each-ref', '--format=%(refname) %(objectname)'], bare).stdout
            output = drive(t, wt, env, 'open-pr-if-needed')
            data = json.loads(state.read_text())
            if case in ['own-ancestor', 'unique-ancestor']:
                assert len(data['prs']) == 1, data
                assert 'PR_URL=' + pr['url'] in output, output
                assert cmd(['git', 'rev-parse', 'refs/heads/' + pr['headRefName']], bare).stdout.strip() == head
                assert json.loads((artifacts / 'run-pr.json').read_text())['number'] == 7
            else:
                assert len(data['prs']) == 2, data
                assert data['prs'][0] == pr, data
                assert cmd(['git', 'for-each-ref', '--format=%(refname) %(objectname)'], bare).stdout == before
            # A replay must reuse the record and must never open another PR.
            drive(t, wt, env, 'open-pr-if-needed')
            assert len(json.loads(state.read_text())['prs']) == len(data['prs'])
            assert not (artifacts / 'run-pr.lock').exists()
            if case == 'own-ancestor':
                data = json.loads(state.read_text())
                data['prs'][0]['author'] = {'login': 'someone-else'}
                state.write_text(json.dumps(data))
                drive(t, wt, env, 'open-pr-if-needed', expected=1)
                assert json.loads(state.read_text()) == data
                assert not (artifacts / 'run-pr.lock').exists()
            print('PASS: adoption ' + case + ' and replay', flush=True)


def run_fallback():
    for case in ['recorded', 'discovered', 'merged', 'none']:
        if os.environ.get('PR_FIXTURE_CASE') and os.environ['PR_FIXTURE_CASE'] != case:
            continue
        existing = case != 'none'
        with tempfile.TemporaryDirectory(prefix='.fallback-fixture-', dir=ROOT) as tmp:
            t = Path(tmp)
            wt, bare, artifacts, state, env, branch, unique, ancestor, head, base = fixture(t)
            # Salvage obtains the repo from origin; keep Git local with an insteadOf mapping.
            cmd(['git', 'config', 'url.' + bare.as_posix() + '.insteadOf', 'https://github.com/fixture/repo.git'], wt)
            cmd(['git', 'remote', 'set-url', 'origin', 'https://github.com/fixture/repo.git'], wt)
            pr = primary(branch, ancestor)
            if case == 'merged': pr['state'] = 'MERGED'
            state.write_text(json.dumps({'prs': [pr] if existing else []}))
            if case in ['recorded', 'merged']:
                (artifacts / 'run-pr.json').write_text(json.dumps(dict(number=7, url=pr['url'], head_branch=branch, base='dev', wo_id=WO, run_id='fixture-run', repo=REPO)))
            before = cmd(['git', 'rev-parse', 'refs/heads/' + branch], bare).stdout
            (wt / 'file').write_text('salvage bytes\n')
            output = drive(t, wt, env, 'noninteractive-salvage')
            data = json.loads(state.read_text())
            assert len(data['prs']) == 1, data
            assert cmd(['git', 'rev-parse', 'refs/heads/' + branch], bare).stdout == before
            assert cmd(['git', 'rev-parse', 'refs/heads/' + branch], wt).stdout.strip() == head
            salvage = cmd(['git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads/salvage/'], bare).stdout.strip()
            assert salvage.startswith('salvage/opus-repair-'), salvage
            assert cmd(['git', 'show', 'refs/heads/' + salvage + ':file'], bare).stdout == 'salvage bytes\n'
            if existing:
                assert data['prs'][0]['body'] == pr['body']
                assert len(data['prs'][0]['comments']) == 1
                assert salvage in data['prs'][0]['comments'][0]['body']
                events = [json.loads(line[len('BDC_RUN_EVENT '):]) for line in output.splitlines() if line.startswith('BDC_RUN_EVENT ')]
                assert len(events) == 1, output
                assert events[0]['event_type'] == 'duplicate_pr_suppressed'
                assert events[0]['existing_pr'] == 7 and events[0]['kind'] == 'fallback' and events[0]['salvage_branch'] == salvage
            else:
                assert data['prs'][0]['title'].startswith('FALLBACK:')
                assert 'BDC_RUN_EVENT ' not in output
                assert json.loads((artifacts / 'run-pr.json').read_text())['number'] == data['prs'][0]['number']
            assert not (artifacts / 'run-pr.lock').exists()
            drive(t, wt, env, 'noninteractive-salvage')
            assert len(json.loads(state.read_text())['prs'][0]['comments']) == (1 if existing else 0)
            print('PASS: fallback ' + case + ' ' + ('suppressed with branch/body unchanged, comment and event' if existing else 'opens and records one PR'), flush=True)


if __name__ == '__main__':
    {'adopt': run_adopt, 'fallback': run_fallback}[sys.argv[1]]()
