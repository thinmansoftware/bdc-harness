"""Separate minimal diagnostic controller contract; no account or authority."""
import hashlib
import json
from pathlib import Path
import re
from teetime_auth_artifact_protocol import ALL_PATHS as LEGACY_PATHS, IMAGE_PATHS as LEGACY_IMAGE, artifact_hashes
from teetime_joined_fixture import exact, strict_json
from teetime_minimal_worker_result import validate_minimal_worker
from teetime_proxy_diagnostic_receipt import parse_proxy_diagnostic_receipt

EXTRA = tuple('scripts/staging/'+name for name in [
    'teetime-minimal-diagnostic.ts', 'teetime-minimal-diagnostic-runner.ts',
    'teetime-minimal-diagnostic-entry.ts', 'teetime_minimal_diagnostic.py',
    'teetime_minimal_worker.py', 'teetime_minimal_worker_result.py',
    'teetime_proxy_diagnostic_receipt.py', 'teetime_minimal_protocol.py'])
IMAGE_PATHS = tuple(dict.fromkeys((*LEGACY_IMAGE, *EXTRA, 'scripts/staging/teetime_connect_proxy.py')))
ALL_PATHS = tuple(dict.fromkeys((*LEGACY_PATHS, *IMAGE_PATHS)))
FAILURES = frozenset({'CalledProcessError', 'TimeoutExpired', 'TimeoutError', 'ValueError',
    'OSError', 'FileNotFoundError', 'PermissionError', 'ThreadAlive', 'OwnershipUncertain', 'UnknownFailure'})


def _hex(value, size, prefix=''):
    return type(value) is str and re.fullmatch(re.escape(prefix)+'[a-f0-9]{'+str(size)+'}', value) is not None


def validate_diagnostic_selector(task, source, artifact_source, demo_hash):
    if (task != 'minimal-diagnostic' or not _hex(source, 40)
            or artifact_source is not None or demo_hash is not None):
        raise ValueError('closed diagnostic selector required')


def diagnostic_hashes(staging_root, source, base_source):
    hashes = artifact_hashes(staging_root, source, base_source)
    root = Path(staging_root).resolve().parents[1]
    raw = (root/'source-manifest.json').read_bytes()
    if len(raw) > 16384: raise ValueError('diagnostic manifest bound')
    manifest = strict_json(raw)
    if (type(manifest) is not dict or set(manifest) != {'source', 'baseSource', 'baseImage', 'fileHashes'}
            or manifest['source'] != source or manifest['baseSource'] != base_source
            or not _hex(manifest['baseImage'], 64, 'sha256:')
            or type(manifest['fileHashes']) is not dict or set(manifest['fileHashes']) != set(ALL_PATHS)):
        raise ValueError('diagnostic manifest identity or closure differs')
    for name in ALL_PATHS:
        expected = manifest['fileHashes'].get(name)
        if not _hex(expected, 64) or hashlib.sha256((root/name).read_bytes()).hexdigest() != expected:
            raise ValueError('diagnostic helper missing or changed')
        hashes[name] = expected
    if set(hashes) != set(ALL_PATHS): raise ValueError('diagnostic closure differs')
    return hashes


def diagnostic_identity(nonce, image, base_source, source, hashes):
    if (not _hex(nonce, 32) or not _hex(image, 64, 'sha256:') or not _hex(base_source, 40)
            or not _hex(source, 40) or type(hashes) is not dict or set(hashes) != set(ALL_PATHS)
            or any(not _hex(value, 64) for value in hashes.values())):
        raise ValueError('diagnostic binding required')
    value = {'version': 1, 'kind': 'teetime-minimal-controller', 'nonce': nonce,
             'image': image, 'baseSource': base_source, 'source': source, 'hashes': hashes}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')).hexdigest()


def validate_diagnostic_ready(value, *, nonce, image, base_source, source, hashes):
    identity = diagnostic_identity(nonce, image, base_source, source, hashes)
    expected = {'type': 'READY', 'nonce': nonce, 'image': image, 'sourceSha': base_source,
        'hashes': hashes, 'task': 'minimal-diagnostic', 'diagnosticSourceSha': source,
        'diagnosticContractHash': identity}
    keys = set(expected) | {'owner', 'manifestSha256', 'workerId', 'gatewayId'}
    if type(value) is not dict or set(value) != keys or not exact({key: value[key] for key in expected}, expected):
        raise ValueError('diagnostic READY binding rejected')
    if type(value['owner']) is not str or re.fullmatch('teetime-auth-[a-f0-9]{12}', value['owner']) is None:
        raise ValueError('diagnostic owner rejected')
    if any(not _hex(value[key], 64) for key in ['manifestSha256', 'workerId', 'gatewayId']):
        raise ValueError('diagnostic resource identity rejected')
    if value['workerId'] == value['gatewayId']: raise ValueError('duplicate diagnostic resource')
    return value


def sanitize_cleanup_errors(errors):
    if type(errors) is not list or len(errors) > 5: raise ValueError('cleanup error bound')
    result = []
    for error in errors:
        if (type(error) is not dict or set(error) != {'kind', 'id', 'failure'}
                or error['kind'] not in ['container', 'network', 'capture']
                or error['id'] is not None and not _hex(error['id'], 64)):
            raise ValueError('cleanup error shape')
        reason = error['failure']
        result.append({'kind': error['kind'], 'id': error['id'],
                       'failure': reason if type(reason) is str and reason in FAILURES else 'UnknownFailure'})
    return result


def validate_diagnostic_report(raw, exit_code, *, ready):
    if type(raw) is not bytes or not 1 <= len(raw) <= 32768 or not raw.isascii():
        raise ValueError('diagnostic RESULT bound')
    validate_diagnostic_ready(ready, nonce=ready['nonce'], image=ready['image'],
        base_source=ready['sourceSha'], source=ready['diagnosticSourceSha'], hashes=ready['hashes'])
    report = strict_json(raw)
    expected = {key: ready[key] for key in ['nonce', 'owner', 'task', 'diagnosticSourceSha', 'diagnosticContractHash']}
    expected['type'] = 'RESULT'
    if (type(report) is not dict or set(report) != set(expected) | {'result', 'cleanupErrors', 'receiptDirectory', 'proxyMetrics'}
            or not exact({key: report[key] for key in expected}, expected)):
        raise ValueError('diagnostic RESULT binding rejected')
    outcome = report['result']
    flags = {'passed', 'cleanupVerified', 'credentialReceived', 'proxyMetricsVerified'}
    if (type(outcome) is not dict or set(outcome) != flags | {'workerExitCode', 'workerResult'}
            or any(type(outcome[key]) is not bool for key in flags)):
        raise ValueError('diagnostic controller flags rejected')
    errors = report['cleanupErrors']
    if not exact(sanitize_cleanup_errors(errors), errors) or outcome['cleanupVerified'] != (errors == []):
        raise ValueError('diagnostic cleanup contradiction')
    receipt = report['receiptDirectory']
    if (type(receipt) is not str or not 1 <= len(receipt) <= 512 or not receipt.isascii()
            or any(ord(char) < 32 or ord(char) == 127 for char in receipt)):
        raise ValueError('diagnostic receipt path rejected')
    metrics = report['proxyMetrics']
    if outcome['proxyMetricsVerified']:
        proxy_raw = b'{"proxyReady":true,"diagnosticVersion":1}\n'+json.dumps(metrics).encode('ascii')
        parse_proxy_diagnostic_receipt(proxy_raw)
    elif metrics is not None:
        raise ValueError('diagnostic unverified proxy evidence')
    worker, code = outcome['workerResult'], outcome['workerExitCode']
    if code is not None and (type(code) is not int or code not in (0, 1)):
        raise ValueError('diagnostic worker exit rejected')
    if code is not None and not outcome['credentialReceived']:
        raise ValueError('diagnostic worker exit before credentials')
    if worker is not None:
        if not outcome['credentialReceived'] or code is None: raise ValueError('diagnostic worker before credentials')
        validate_minimal_worker(code, json.dumps(worker).encode('ascii'), nonce=ready['nonce'], source=ready['diagnosticSourceSha'])
    success = (outcome['credentialReceived'] and outcome['cleanupVerified'] and outcome['proxyMetricsVerified']
               and worker is not None and worker['passed'])
    if (outcome['passed'] != success or type(exit_code) is not int
            or exit_code != (0 if success else 1)):
        raise ValueError('diagnostic controller success contradiction')
    return report


