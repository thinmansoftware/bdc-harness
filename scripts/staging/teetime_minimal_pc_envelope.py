"""Future PC envelope source template. CLI disabled; no execution authority.

Historical binding constants are retained for review, not reused permission.
A future frozen package must rebind and independently admit this source first.
"""
import base64
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent
OPERATOR = ROOT/'operator'
STAGING = OPERATOR/'scripts/staging'
SOURCE = '929c3e0c60987d3e021727b8802f221b812bb0ac'
PACKET = 'caaa8092376ecee79e025f038a5aeb885abaea8a1aa3835285ca1fef302f36f4'
INVENTORY = '1308bc0ff6a3974e68bf4d8a6133d70ac80629e89715f175643a850835a8e036'
PYTHON = r'C:\Users\pcmed\AppData\Local\Programs\Python\Python312\python.exe'
SSH = r'C:\WINDOWS\System32\OpenSSH\ssh.exe'
GH = r'C:\Program Files\GitHub CLI\gh.exe'
KILL = r'C:\Windows\System32\taskkill.exe'
BINARIES = {
    PYTHON: '4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a',
    SSH: '8e1212d6b10bbab3dfd85077c1a7d0b60373fde702dfa9ea8c57924793bdb317',
    GH: '89c0c744a884ce75854c1b68d45dbc61c45e499db96339cb8a2b815de8d981f0',
    KILL: '1249717315fc8f4d2df17d5db9da0444795fdb9fb83dfb1f763c3f39282244f7',
}


def validate_head(value):
    if type(value) is not str or re.fullmatch('[a-f0-9]{40}', value) is None:
        raise ValueError('closed reviewed head required')
    return value


def reserve(path, value):
    with path.open('x', encoding='ascii') as saved:
        json.dump(value, saved, sort_keys=True, separators=(',', ':'))
        saved.flush()
        os.fsync(saved.fileno())


def ordinary(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('indirection rejected')


def verify_tree(root, expected, seconds):
    deadline = time.monotonic()+seconds
    for path in [root, *root.parents]: ordinary(path)
    observed = {}
    pending = [root]
    while pending:
        for path in pending.pop().iterdir():
            if time.monotonic() >= deadline: raise TimeoutError('inventory deadline')
            ordinary(path)
            if path.is_dir(): pending.append(path)
            elif path.is_file():
                relative = path.relative_to(root).as_posix()
                if relative not in expected or len(observed) >= len(expected):
                    raise ValueError('unexpected operator file')
                observed[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
            else: raise ValueError('special operator member')
    if observed != expected: raise ValueError('complete operator inventory differs')


def capture(argv, seconds, limit, env=None):
    """Bound both streams in memory; do not retain or print stderr bytes."""
    deadline = time.monotonic()+seconds
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    lock = threading.Lock()
    overflow = threading.Event()
    counts = [0, 0]
    output = bytearray()
    read_errors = []
    def reader(stream, index):
        try:
            while True:
                chunk = stream.read1(1024)
                if not chunk: break
                with lock:
                    counts[index] += len(chunk)
                    if sum(counts) > limit: overflow.set()
                    if index == 0 and len(output) < limit:
                        output.extend(chunk[:limit-len(output)])
        except BaseException: read_errors.append(True)
    threads = [threading.Thread(target=lambda index=index:
                   reader([child.stdout, child.stderr][index], index), daemon=True)
               for index in range(2)]
    failure = None
    kill_ok = True
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=env, creationflags=flags)
    try:
        for thread in threads: thread.start()
        while child.poll() is None or any(thread.is_alive() for thread in threads):
            if overflow.is_set(): failure = 'output-bound'; break
            if time.monotonic() >= deadline: failure = 'deadline'; break
            time.sleep(.02)
    except BaseException:
        failure = 'capture-failed'
    finally:
        if child.poll() is None:
            if os.name == 'nt':
                try:
                    killed = subprocess.run([KILL, '/PID', str(child.pid), '/T', '/F'],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, timeout=10, creationflags=flags)
                    kill_ok = killed.returncode == 0
                except BaseException: kill_ok = False
            else: child.kill()
            if child.poll() is None:
                try: child.kill()
                except BaseException: kill_ok = False
        try: child.wait(timeout=5)
        except BaseException: kill_ok = False
        settled_deadline = time.monotonic()+5
        for thread in threads:
            try:
                if thread.ident is not None: thread.join(max(0, settled_deadline-time.monotonic()))
            except BaseException: kill_ok = False
        settled = child.poll() is not None and all(not thread.is_alive() for thread in threads)
        if settled:
            for stream in [child.stdout, child.stderr]:
                try: stream.close()
                except BaseException: kill_ok = False
    if sum(counts) > limit: failure = 'output-bound'
    if not settled or not kill_ok or read_errors: failure = 'settlement-uncertain'
    return {'exit': child.poll(), 'out': bytes(output), 'stdoutBytes': counts[0],
            'stderrBytes': counts[1], 'settled': settled and kill_ok and not read_errors,
            'failure': failure}


def bootstrap(arguments):
    return ('import runpy,sys;sys.path.insert(0,'+repr(str(STAGING))+');sys.argv='
        +repr([str(STAGING/'invoke-teetime-auth-canary.py'), *arguments])
        +';runpy.run_path('+repr(str(STAGING/'invoke-teetime-auth-canary.py'))+",run_name='__main__')")


def approved_review(reviews, head):
    latest = {}
    for item in reviews:
        if item.get('state') == 'PENDING': continue
        state = item.get('state')
        if (state not in ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'COMMENTED']
                or type(item.get('id')) is not int or item['id'] <= 0):
            raise ValueError('malformed review')
        validate_head(item.get('commit_id'))
        text = item.get('submitted_at')
        if type(text) is not str: raise ValueError('review timestamp missing')
        submitted = datetime.fromisoformat(text.replace('Z', '+00:00'))
        if submitted.tzinfo is None: raise ValueError('review timezone missing')
        actor = item['user']['login'].lower()
        if state == 'COMMENTED': continue
        prior = latest.get(actor)
        if prior is not None and prior[0] == submitted and (
                prior[1]['state'] != state or prior[1]['commit_id'] != item['commit_id']):
            raise ValueError('ambiguous review chronology')
        if prior is None or prior[0] < submitted: latest[actor] = (submitted, item)
    approval = latest.get('thinman-overseer[bot]')
    if (approval is None or approval[1]['state'] != 'APPROVED' or approval[1]['commit_id'] != head
            or any(value[1]['state'] == 'CHANGES_REQUESTED' for value in latest.values())):
        raise ValueError('independent exact-head approval missing')
    return approval[1]['id']


def preflight(head):
    start = time.monotonic()
    for name, expected in BINARIES.items():
        ordinary(Path(name))
        if hashlib.sha256(Path(name).read_bytes()).hexdigest() != expected:
            raise ValueError('pinned executable differs')
    if Path(sys.executable).resolve() != Path(PYTHON).resolve():
        raise ValueError('pinned Python required')
    raw = (ROOT/'minimal-diagnostic-execution-source-manifest.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != INVENTORY: raise ValueError('inventory differs')
    inventory = json.loads(raw)
    if inventory['source'] != SOURCE or len(inventory['files']) != 2146:
        raise ValueError('inventory identity differs')
    verify_tree(OPERATOR, inventory['files'], 30)
    sys.path.insert(0, str(STAGING))
    from teetime_joined_fixture import strict_json
    env = dict(os.environ)
    env['PATH'] = os.pathsep.join([str(Path(SSH).parent), str(Path(GH).parent), r'C:\Windows\System32'])
    env.pop('PYTHONPATH', None)
    env.pop('PYTHONHOME', None)
    env['GH_HOST'] = 'github.com'
    def read(endpoint):
        remaining = 90-(time.monotonic()-start)
        if remaining <= 0: raise TimeoutError('preflight deadline')
        result = capture([GH, 'api', '--method', 'GET', endpoint], min(remaining, 20), 2097152, env)
        if result['failure'] or not result['settled'] or result['exit'] != 0:
            raise ValueError('GitHub read failed')
        return strict_json(result['out'])
    prefix = 'repos/thinmansoftware/bdc-xo/'
    pull = read(prefix+'pulls/3392')
    if pull['head']['sha'] != head or pull['state'] != 'open' or pull['merged_at'] is not None:
        raise ValueError('current carrier head differs')
    carrier = read(prefix+'contents/docs/tee-time/minimal-diagnostic-admission.json?ref='+head)
    raw = base64.b64decode(carrier['content'].replace('\n', ''), validate=True)
    if raw != (ROOT/'proposed-minimal-diagnostic-admission.json').read_bytes():
        raise ValueError('actual carrier differs')
    reviews = []
    for page in range(1, 21):
        batch = read(prefix+'pulls/3392/reviews?per_page=100&page='+str(page))
        if type(batch) is not list: raise ValueError('review pages differ')
        reviews.extend(batch)
        if len(batch) < 100: break
    else: raise ValueError('incomplete review pagination')
    review_id = approved_review(reviews, head)
    checks = read(prefix+'commits/'+head+'/check-runs?per_page=100')
    if checks['total_count'] > 100: raise ValueError('incomplete checks')
    scans = [item for item in checks['check_runs'] if item['name'] == 'Gitleaks']
    if not scans: raise ValueError('scan missing')
    scan = max(scans, key=lambda item: item['id'])
    if scan['head_sha'] != head or scan['status'] != 'completed' or scan['conclusion'] != 'success':
        raise ValueError('exact-head scan not passing')
    if read(prefix+'pulls/3392')['head']['sha'] != head:
        raise ValueError('carrier moved during preflight')
    if time.monotonic()-start >= 90: raise TimeoutError('preflight deadline')
    return env, {'head': head, 'reviewId': review_id, 'scanId': scan['id'],
                 'inventorySha256': INVENTORY, 'packetSha256': PACKET}


def validate_receipt(raw, exit_code):
    from teetime_minimal_protocol import validate_minimal_operator_record
    # This retained historical binding describes v1 inner receipts. Rebinding a
    # future v2 worker must explicitly change and review this selector as well.
    return validate_minimal_operator_record(raw, exit_code, expected_source=SOURCE, receipt_version=1)


def main():
    if len(sys.argv) != 2: raise ValueError('one reviewed head argument required')
    head = validate_head(sys.argv[1])
    env, observation = preflight(head)
    reserve(ROOT/'minimal-pc-launch.claim.json', observation)
    arguments = ['--task', 'minimal-diagnostic', '--image',
        'sha256:4343f0af23682c326fcb2fd784bc40df355eee5709e51ec61750a478334b7e99',
        '--expected-sha', '3a9fbee193100897c5064dabfdc2cd6697b7618e',
        '--diagnostic-source', SOURCE, '--diagnostic-package-hash', PACKET,
        '--plan-head', head, '--input-sha256',
        'e03c392ccbc926e097e113e80a472591d70e772b8630d0e8d2027bfebc351084',
        '--source-manifest-sha256', INVENTORY]
    record = {'head': head, 'automaticRetryAllowed': False, 'passed': False,
              'remoteCleanupProven': False, 'failure': 'envelope-failed'}
    try:
        result = capture([PYTHON, '-I', '-B', '-c', bootstrap(arguments)], 480, 65536, env)
        record.update({key: value for key, value in result.items() if key != 'out'})
        if not result['failure'] and result['settled'] and result['exit'] in [0, 1]:
            record['operator'] = validate_receipt(result['out'], result['exit'])
            record['passed'] = result['exit'] == 0 and record['operator']['result']['passed']
            record['remoteCleanupProven'] = record['passed']
            if not record['passed']: record['failure'] = 'operator-failed'
        elif record['failure'] is None: record['failure'] = 'operator-failed'
    except BaseException:
        record['failure'] = 'envelope-or-receipt-failed'
    finally:
        try: reserve(ROOT/'minimal-pc-launch.result.json', record)
        except BaseException:
            print('{"passed":false,"failure":"result-persistence-failed","automaticRetryAllowed":false}')
            return 1
    print(json.dumps({'passed': record['passed'], 'failure': record['failure'], 'automaticRetryAllowed': False}))
    return 0 if record['passed'] else 1


if __name__ == '__main__':
    print('{"passed":false,"failure":"source-template-not-admitted","automaticRetryAllowed":false}')
    raise SystemExit(2)
