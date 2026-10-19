"""Unregistered diagnostic worker source; no controller selector or authority."""
from pathlib import Path
import json
import stat
import sys
import time
if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent))
import teetime_canary_worker as base
from teetime_auth_artifact_protocol import validate_selector
from teetime_minimal_diagnostic import validate_minimal_diagnostic
from teetime_minimal_worker_result import validate_minimal_worker


def run_worker(nonce, source):
    validate_selector('artifact', source, nonce)  # Syntax only, never authority.
    result = {'version': 1, 'kind': 'teetime-minimal-worker', 'nonce': nonce, 'source': source,
              'passed': False, 'preflightPassed': False, 'preflightChecks': 0,
              'authenticationRejected': False, 'authUnchanged': False, 'workspaceUnchanged': False,
              'taskStarted': False, 'taskProcessReaped': False, 'taskExitCode': None,
              'taskReceipt': None, 'oomKillDelta': None, 'elapsedMs': 0, 'failureCategory': 'preflight'}
    started = time.monotonic()
    original = snapshot = None
    before_oom = base.oom_kills()
    base.PREFLIGHT_CHECKS = 0
    base.AUTH_REJECTED = False
    try:
        if not __debug__ or base.os.getuid() != 1001 or str(Path.cwd()) != '/workspace':
            raise ValueError('fixed worker environment required')
        if base.os.environ.get('TEETIME_AUTH_ARTIFACT_SOURCE_SHA') != source:
            raise ValueError('worker source mismatch')
        info = base.AUTH.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 1001
                or info.st_mode & 0o777 != 0o600 or not 1 <= info.st_size <= 65536):
            raise ValueError('worker auth metadata rejected')
        original = base.AUTH.read_bytes()
        snapshot = base.artifact_workspace_snapshot()
        if any(Path(path).exists() for path in ['/etc/codex', '/.codex', '/.agents']):
            raise ValueError('worker discovery roots rejected')
        base.preflight()
        if (base.PREFLIGHT_CHECKS != 6 or base.AUTH_REJECTED or base.AUTH.read_bytes() != original
                or base.artifact_workspace_snapshot() != snapshot):
            raise ValueError('worker preflight observations rejected')
        result['preflightPassed'] = True
        result['failureCategory'] = 'task'
        # Capture attempted, not proof of child startup or model invocation.
        result['taskStarted'] = True
        code, raw = base.bounded_process(['bun', (base.ROOT/'teetime-minimal-diagnostic-entry.ts').as_posix()],
                                         100, include_exit_code=True)
        result['taskProcessReaped'] = True  # Returned only after owned child wait.
        if type(code) is int and code in (0, 1): result['taskExitCode'] = code
        # Independent validator enforces byte bound before JSON parsing.
        result['taskReceipt'] = validate_minimal_diagnostic(code, raw)
    except BaseException:
        # Preserve unknown invocation count via null taskReceipt. No raw errors.
        pass
    finally:
        result['preflightChecks'] = base.PREFLIGHT_CHECKS
        result['authenticationRejected'] = base.AUTH_REJECTED
        after_oom = base.oom_kills()
        if (type(before_oom) is int and type(after_oom) is int
                and 0 <= before_oom <= after_oom <= 10**9):
            result['oomKillDelta'] = after_oom-before_oom
        try:
            if original is not None:
                info = base.AUTH.lstat()
                result['authUnchanged'] = (stat.S_ISREG(info.st_mode)
                    and info.st_uid == 1001 and info.st_mode & 0o777 == 0o600
                    and base.AUTH.read_bytes() == original)
            if snapshot is not None:
                result['workspaceUnchanged'] = base.artifact_workspace_snapshot() == snapshot
        except BaseException:
            pass
        clean = result['authUnchanged'] and result['workspaceUnchanged'] and result['oomKillDelta'] == 0
        if not clean and (original is not None or snapshot is not None or result['taskStarted']):
            result['failureCategory'] = 'cleanup'
        task = result['taskReceipt']
        result['passed'] = bool(clean and result['preflightPassed'] and task is not None and task['passed'])
        if result['passed']: result['failureCategory'] = 'none'
        result['elapsedMs'] = max(0, int((time.monotonic()-started)*1000))
    validate_minimal_worker(0 if result['passed'] else 1, json.dumps(result).encode('ascii'), nonce=nonce, source=source)
    return result


if __name__ == '__main__':
    try:
        import argparse
        class SilentParser(argparse.ArgumentParser):
            def error(self, _message):
                raise ValueError('worker arguments rejected')
        parser = SilentParser(add_help=False)
        parser.add_argument('--nonce', required=True)
        parser.add_argument('--source', required=True)
        args = parser.parse_args()
        value = run_worker(args.nonce, args.source)
        print(json.dumps(value), flush=True)
        raise SystemExit(0 if value['passed'] else 1)
    except Exception:
        # No malformed/unknown packet or raw initialization diagnostics.
        raise SystemExit(1) from None
