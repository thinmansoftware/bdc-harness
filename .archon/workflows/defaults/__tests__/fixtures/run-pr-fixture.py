"""Run real lane bash against local bare Git and a stateful, network-free gh stub."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

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
if os.environ.get('PR_FIXTURE_GH_FAIL'): raise SystemExit('fixture GitHub unreachable')
if a[:2]==['api','user']: print('builder')
elif a[:2]==['pr','list']:
    if os.environ.get('PR_FIXTURE_LIST_FAIL'): raise SystemExit('fixture PR lookup unavailable')
    items=[v for v in d['prs'] if v.get('state','OPEN')=='OPEN']
    if os.environ.get('PR_FIXTURE_HIDE_CREATED'): items=[v for v in items if v['number']<100]
    if '--head' in a: items=[v for v in items if v['headRefName']==opt('--head')]
    print(json.dumps(items))
elif a[:2]==['pr','view']:
    item=next(v for v in d['prs'] if str(v['number'])==a[2] or v['url']==a[2])
    print(json.dumps(item))
elif a[:2]==['pr','create']:
    attempts=Path(str(p)+'.attempts')
    count=int(attempts.read_text())+1 if attempts.exists() else 1
    attempts.write_text(str(count))
    if count<=int(os.environ.get('PR_FIXTURE_TRANSIENT_FAILURES','0')):
        print('HTTP 502: transient fixture failure',file=sys.stderr); raise SystemExit(1)
    if os.environ.get('PR_FIXTURE_CREATE_GATE'):
        import time
        gate=Path(os.environ['PR_FIXTURE_CREATE_GATE'])
        gate.with_suffix('.entered').touch()
        deadline=time.monotonic()+30
        while not gate.exists():
            if time.monotonic()>deadline: raise SystemExit('fixture create gate timed out')
            time.sleep(0.05)
    n=100+len(d['prs']); branch=opt('--head')
    if any(v['headRefName']==branch and v.get('baseRefName')==opt('--base') and v['state']=='OPEN' for v in d['prs']):
        print('a pull request already exists for this head/base',file=sys.stderr); raise SystemExit(1)
    sha=subprocess.check_output(['git','ls-remote','origin','refs/heads/'+branch],text=True).split()[0]
    if os.environ.get('PR_FIXTURE_WRONG_BASE_AFTER_CREATE') and count==1:
        d['prs'].append(dict(number=7,url='https://github.com/fixture/repo/pull/7',headRefName=branch,headRefOid=sha,baseRefName='main',author={'login':'builder'},title='other base',body='unrelated base body',comments=[],state='OPEN'))
        save(); raise SystemExit(1)
    d['prs'].append(dict(number=n,url='https://github.com/fixture/repo/pull/'+str(n),headRefName=branch,headRefOid=sha,baseRefName=opt('--base'),author={'login':'builder'},title=opt('--title'),body=Path(opt('--body-file')).read_text() if '--body-file' in a else opt('--body'),comments=[],state='OPEN'))
    save(); print(d['prs'][-1]['url'])
    if os.environ.get('PR_FIXTURE_HIDE_CREATED'): raise SystemExit(1)
    if os.environ.get('PR_FIXTURE_CREATED_NONZERO'): raise SystemExit(1)
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
    # Images that ship /app/scripts/github-service-login.ts make the lane skip
    # `gh api user`. Answer that call with the fixture builder login.
    real_bun = shutil.which('bun') or 'bun'
    (bindir / 'bun').write_text(
        '#!/usr/bin/env bash\n'
        'if [ "$1" = "/app/scripts/github-service-login.ts" ]; then\n'
        '  echo builder\n'
        '  exit 0\n'
        'fi\n'
        'exec ' + shlex.quote(real_bun) + ' "$@"\n'
    )
    (bindir / 'bun').chmod(0o755)
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
    for case in ['own-ancestor', 'unique-ancestor', 'unrelated-branch', 'other-author', 'wrong-base', 'missing-base', 'non-ancestor', 'ambiguous-create', 'transient-retry', 'created-nonzero', 'replay-after-failure', 'recorded-wrong-base', 'recorded-missing-base', 'wrong-base-after-create', 'api-failure']:
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
            if case in ['wrong-base', 'recorded-wrong-base']: pr['baseRefName'] = 'other-base'
            if case in ['missing-base', 'recorded-missing-base']: pr.pop('baseRefName')
            if case == 'non-ancestor': pr['headRefOid'] = 'f' * 40
            state.write_text(json.dumps({'prs': [] if case in ['ambiguous-create', 'transient-retry', 'created-nonzero', 'replay-after-failure'] else [pr]}))
            if case in ['api-failure', 'recorded-wrong-base', 'recorded-missing-base']:
                if case == 'api-failure': env['PR_FIXTURE_LIST_FAIL']='1'
                else: (artifacts / 'run-pr.json').write_text(json.dumps(dict(number=7,url=pr['url'],head_branch=branch,base='dev',wo_id=WO,run_id='fixture-run',repo=REPO)))
                before=state.read_text()
                drive(t,wt,env,'open-pr-if-needed',expected=1)
                assert state.read_text()==before
                assert not Path(str(state)+'.attempts').exists()
                assert not (artifacts / 'run-pr.lock').exists()
                print('PASS: '+case+' refuses without any PR creation or modification',flush=True)
                continue
            if case == 'wrong-base-after-create':
                state.write_text(json.dumps({'prs': []}))
                env['PR_FIXTURE_WRONG_BASE_AFTER_CREATE']='1'
                drive(t,wt,env,'open-pr-if-needed')
                data=json.loads(state.read_text())
                assert len(data['prs'])==2 and [p['baseRefName'] for p in data['prs']]==['main','dev']
                assert data['prs'][0]['body']=='unrelated base body' and data['prs'][0]['comments']==[]
                assert int(Path(str(state)+'.attempts').read_text())==2
                assert json.loads((artifacts/'run-pr.json').read_text())['number']==data['prs'][1]['number']
                print('PASS: wrong-base-after-create is never adopted or retargeted; own PR created',flush=True)
                continue
            if case in ['transient-retry', 'created-nonzero', 'replay-after-failure']:
                env['PR_FIXTURE_TRANSIENT_FAILURES'] = '3' if case == 'replay-after-failure' else ('2' if case == 'transient-retry' else '0')
                if case == 'created-nonzero': env['PR_FIXTURE_CREATED_NONZERO'] = '1'
                if case == 'replay-after-failure':
                    drive(t, wt, env, 'open-pr-if-needed', expected=1)
                    assert int(Path(str(state)+'.attempts').read_text()) == 3
                    env['PR_FIXTURE_TRANSIENT_FAILURES'] = '0'
                drive(t, wt, env, 'open-pr-if-needed')
                assert len(json.loads(state.read_text())['prs']) == 1
                expected_attempts = {'transient-retry': 3, 'created-nonzero': 1, 'replay-after-failure': 4}[case]
                assert int(Path(str(state)+'.attempts').read_text()) == expected_attempts
                drive(t, wt, env, 'open-pr-if-needed')
                assert int(Path(str(state)+'.attempts').read_text()) == expected_attempts
                assert not (artifacts / 'run-pr.lock').exists()
                print('PASS: '+case+' creates exactly one PR and replays without another create', flush=True)
                continue
            if case == 'ambiguous-create':
                env['PR_FIXTURE_HIDE_CREATED'] = '1'
                drive(t, wt, env, 'open-pr-if-needed', expected=1)
                attempts = int(Path(str(state)+'.attempts').read_text())
                del env['PR_FIXTURE_HIDE_CREATED']
                drive(t, wt, env, 'open-pr-if-needed')
                assert len(json.loads(state.read_text())['prs']) == 1
                assert int(Path(str(state)+'.attempts').read_text()) == attempts
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


def run_local_preservation():
    for case in ['missing-context', 'github-unreachable', 'recorded-ownership-refused']:
        if os.environ.get('PR_FIXTURE_CASE') and os.environ['PR_FIXTURE_CASE'] != case:
            continue
        with tempfile.TemporaryDirectory(prefix='.local-salvage-', dir=ROOT) as tmp:
            t = Path(tmp)
            wt, bare, artifacts, state, env, branch, unique, ancestor, head, base = fixture(t)
            state.write_text(json.dumps({'prs': []}))
            if case == 'missing-context':
                for key in ['ARTIFACTS_DIR', 'WORKFLOW_ID', 'RECORDED_BASE_BRANCH', 'ACTING_LOGIN']:
                    env.pop(key, None)
            else:
                cmd(['git', 'config', 'url.' + bare.as_posix() + '.insteadOf', 'https://github.com/fixture/repo.git'], wt)
                cmd(['git', 'remote', 'set-url', 'origin', 'https://github.com/fixture/repo.git'], wt)
                if case == 'github-unreachable': env['PR_FIXTURE_GH_FAIL'] = '1'
                else:
                    pr = primary(branch, ancestor); pr['author'] = {'login': 'unrelated'}
                    state.write_text(json.dumps({'prs': [pr]}))
                    (artifacts / 'run-pr.json').write_text(json.dumps(dict(number=7, url=pr['url'], head_branch=branch, base='dev', wo_id=WO, run_id='fixture-run', repo=REPO)))
            (wt / 'file').write_text('preserve even offline\n')
            output = drive(t, wt, env, 'noninteractive-salvage', expected=1 if case == 'recorded-ownership-refused' else 0)
            assert 'SALVAGE=preserved_uncommitted:1' in output, output
            if case != 'recorded-ownership-refused': assert 'SALVAGE=preserved_local_only reason=' in output, output
            assert cmd(['git', 'log', '-1', '--format=%s'], wt).stdout.strip() == 'salvage(uncommitted): 1 files'
            assert cmd(['git', 'show', 'HEAD:file'], wt).stdout == 'preserve even offline\n'
            assert cmd(['git', 'branch', '--show-current'], wt).stdout.startswith('salvage/')
            assert cmd(['git', 'rev-parse', 'refs/heads/' + branch], wt).stdout.strip() == head
            assert not (artifacts / 'run-pr.lock').exists()
            assert not Path(str(state)+'.attempts').exists()
            print('PASS: local preservation '+case+' keeps salvage commit and expected exit', flush=True)


def wait_for(path, process):
    deadline = time.monotonic() + 30
    while not path.exists():
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise AssertionError('fixture process exited before gate: ' + stdout + stderr)
        assert time.monotonic() < deadline, 'fixture did not reach gate'
        time.sleep(0.05)


def run_concurrent():
    # A process gate makes contention deterministic; both orders use the real nodes.
    for winner in ['primary', 'salvage']:
        if os.environ.get('PR_FIXTURE_CASE') and os.environ['PR_FIXTURE_CASE'] != winner:
            continue
        with tempfile.TemporaryDirectory(prefix='.concurrent-pr-', dir=ROOT) as tmp:
            t = Path(tmp)
            wt, bare, artifacts, state, env, branch, unique, ancestor, head, base = fixture(t)
            cmd(['git', 'config', 'url.' + bare.as_posix() + '.insteadOf', 'https://github.com/fixture/repo.git'], wt)
            cmd(['git', 'remote', 'set-url', 'origin', 'https://github.com/fixture/repo.git'], wt)
            (wt / 'file').write_text('salvage bytes\n')
            state.write_text(json.dumps({'prs': []}))
            gate = t / 'create-release'
            waiting = t / 'contender-waiting'
            first_env = dict(env, PR_FIXTURE_CREATE_GATE=str(gate))
            names = ['open-pr-if-needed', 'noninteractive-salvage'] if winner == 'primary' else ['noninteractive-salvage', 'open-pr-if-needed']
            scripts = []
            for name in names:
                text = node(name)
                if name == names[1]:
                    # Observe the real wait branch, rather than inferring lock
                    # contention from an arbitrary delay or process liveness.
                    marker = 'echo "run_pr_guard_waiting: another node holds the run PR lock" >&2'
                    assert marker in text
                    text = text.replace(marker, marker + '\n          touch "$PR_FIXTURE_WAITING"')
                path = t / (name + '.sh'); path.write_text(text); scripts.append(path)
            processes = []
            try:
                first = subprocess.Popen(['bash', str(scripts[0])], cwd=wt, env=first_env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                processes.append(first)
                wait_for(gate.with_suffix('.entered'), first)
                # When salvage wins it has already changed HEAD. Publish its new HEAD to
                # the run's unique branch as commit-and-push would, to satisfy the primary
                # node's independent origin precondition before it reaches the lock.
                if winner == 'salvage': cmd(['git', 'push', '-q', 'origin', 'HEAD:' + unique], wt)
                second = subprocess.Popen(['bash', str(scripts[1])], cwd=wt, env=dict(env, PR_FIXTURE_WAITING=str(waiting)), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                processes.append(second)
                wait_for(waiting, second)
                gate.touch()
                first_out, first_err = first.communicate(timeout=45)
                second_out, second_err = second.communicate(timeout=45)
                assert first.returncode == second.returncode == 0, first_out + first_err + second_out + second_err
                data = json.loads(state.read_text())
                assert len(data['prs']) == 1, data
                assert int(Path(str(state)+'.attempts').read_text()) == 1
                if winner == 'primary':
                    assert 'BDC_RUN_EVENT ' in second_out and 'duplicate_pr_suppressed' in second_out
                    assert len(data['prs'][0]['comments']) == 1
                    assert data['prs'][0]['headRefName'] == unique
                    assert cmd(['git', 'rev-parse', 'refs/heads/' + unique], bare).stdout.strip() == head
                else:
                    assert data['prs'][0]['headRefName'].startswith('salvage/')
                    assert 'PR_URL=' + data['prs'][0]['url'] in second_out
                assert not (artifacts / 'run-pr.lock').exists()
                print('PASS: concurrent '+winner+' wins; both nodes exit 0 and exactly one PR exists', flush=True)
            finally:
                gate.touch()
                for process in processes:
                    if process.poll() is None:
                        process.terminate()
                    process.communicate(timeout=45)


def run_stale_lock():
    with tempfile.TemporaryDirectory(prefix='.stale-pr-', dir=ROOT) as tmp:
        t = Path(tmp)
        wt, bare, artifacts, state, env, branch, unique, ancestor, head, base = fixture(t)
        state.write_text(json.dumps({'prs': []}))
        lock = artifacts / 'run-pr.lock'; lock.mkdir()
        (lock / 'holder-999999999').mkdir()
        os.utime(lock, (time.time()-181, time.time()-181))
        drive(t, wt, env, 'open-pr-if-needed')
        assert len(json.loads(state.read_text())['prs']) == 1
        assert not lock.exists()
        print('PASS: stale dead-holder lock reclaimed; next node completes and cleans lock', flush=True)

    with tempfile.TemporaryDirectory(prefix='.live-pr-lock-', dir=ROOT) as tmp:
        t = Path(tmp)
        wt, bare, artifacts, state, env, branch, unique, ancestor, head, base = fixture(t)
        state.write_text(json.dumps({'prs': []}))
        lock = artifacts / 'run-pr.lock'
        ready = t / 'holder-ready'; release = t / 'holder-release'
        hold = t / 'hold.sh'
        hold.write_text('''#!/usr/bin/env bash
set -e
mkdir "$ARTIFACTS_DIR/run-pr.lock"
mkdir "$ARTIFACTS_DIR/run-pr.lock/holder-$BASHPID"
trap 'rmdir "$ARTIFACTS_DIR/run-pr.lock/holder-$BASHPID"; rmdir "$ARTIFACTS_DIR/run-pr.lock"' EXIT
touch "$HOLDER_READY"
while [ ! -f "$HOLDER_RELEASE" ]; do sleep 0.1; done
''')
        holder = subprocess.Popen(['bash', str(hold)], cwd=wt, env=dict(env, HOLDER_READY=str(ready), HOLDER_RELEASE=str(release)), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            wait_for(ready, holder)
            os.utime(lock, (time.time()-181, time.time()-181))
            script=t/'timeout.sh'
            # Test only: keep the production timeout at 180 seconds, exercise its
            # exact branch with a shorter extracted-script deadline.
            script.write_text(node('open-pr-if-needed').replace('RPR_LOCK_TIMEOUT=180', 'RPR_LOCK_TIMEOUT=2'))
            result=cmd(['bash', str(script)], wt, env, check=False)
            assert result.returncode != 0 and 'run_pr_lock_timeout' in result.stderr, result.stdout+result.stderr
            assert holder.poll() is None and lock.exists()
            assert not Path(str(state)+'.attempts').exists()
            print('PASS: old live-holder lock is retained and contender reports bounded timeout', flush=True)
            (wt / 'file').write_text('preserved despite lock timeout\n')
            script.write_text(node('noninteractive-salvage').replace('RPR_LOCK_TIMEOUT=180', 'RPR_LOCK_TIMEOUT=2'))
            result=cmd(['bash', str(script)], wt, env, check=False)
            assert result.returncode == 0, result.stdout+result.stderr
            assert 'SALVAGE=preserved_uncommitted:1' in result.stdout
            assert 'SALVAGE=preserved_local_only reason=github_or_lock_unavailable' in result.stdout
            assert cmd(['git', 'show', 'HEAD:file'], wt).stdout == 'preserved despite lock timeout\n'
            assert holder.poll() is None and lock.exists()
            print('PASS: salvage lock timeout preserves local commit and exits zero', flush=True)
        finally:
            release.touch()
            holder.communicate(timeout=15)


if __name__ == '__main__':
    {'adopt': run_adopt, 'fallback': run_fallback, 'concurrent': run_concurrent, 'stale': run_stale_lock, 'local': run_local_preservation}[sys.argv[1]]()
