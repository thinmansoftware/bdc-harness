"""Fixed credential-free SDK-to-provenance join. Not admission or application QA."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probe_teetime_materialization import run as materialize_run
from teetime_bounded_process import capture
from teetime_joined_fixture import SDK_HELPERS, strict_json, validate_sdk_output, exact

ROOT = Path(__file__).resolve().parents[2]
FROZEN_HELPERS = SDK_HELPERS+tuple('scripts/staging/'+name for name in [
    'probe-teetime-filesystem.py', 'teetime_bounded_process.py', 'teetime_joined_fixture.py',
    'probe_teetime_joined.py', 'teetime_artifact_materialization.py',
    'probe_teetime_materialization.py', 'probe_teetime_snapshot_capture.py',
    'teetime_snapshot_exporter.py', 'teetime_materializer.py', 'teetime_materialization_check.py',
    'teetime_materialization_frame.py', 'codex-probe-seccomp.json',
    'moby-default-seccomp.json', 'codex-probe-minimization.json'])


def freeze_helpers(source, base_source):
    if any(type(value) is not str or re.fullmatch('[a-f0-9]{40}', value) is None for value in [source, base_source]):
        raise ValueError('exact reviewed source identities required')
    raw = (ROOT/'source-manifest.json').read_bytes()
    if len(raw) > 16384:
        raise ValueError('frozen source manifest bound')
    manifest = strict_json(raw)
    if (type(manifest) is not dict or set(manifest) != {'source', 'baseSource', 'baseImage', 'fileHashes'}
            or manifest['source'] != source or manifest['baseSource'] != base_source
            or type(manifest['baseImage']) is not str
            or re.fullmatch('sha256:[a-f0-9]{64}', manifest['baseImage']) is None):
        raise ValueError('frozen source identity mismatch')
    hashes = manifest['fileHashes']
    if type(hashes) is not dict:
        raise ValueError('frozen helper map required')
    for path in FROZEN_HELPERS:
        digest = hashes.get(path)
        if type(digest) is not str or re.fullmatch('[a-f0-9]{64}', digest) is None:
            raise ValueError('frozen helper identity missing')
        if hashlib.sha256((ROOT/path).read_bytes()).hexdigest() != digest:
            raise ValueError('controller helper differs from frozen source')
    return {path: hashes[path] for path in SDK_HELPERS}


def docker_call(docker, *parts):
    code, output = capture([docker, *parts], 8, limit=4096)
    if code != 0:
        raise ValueError('SDK cleanup Docker call failed')
    return output


def sdk_ids(docker, owner):
    if type(owner) is not str or re.fullmatch('teetime-fs-[a-f0-9]{12}', owner) is None:
        raise ValueError('invalid fixed SDK owner')
    return docker_call(docker, 'ps', '-aq', '--no-trunc', '--filter', 'name=^/'+owner+'$').decode('ascii').split()


def require_sdk_absent(docker, owner):
    for _ in range(2):
        if sdk_ids(docker, owner):
            raise ValueError('SDK owned name must be absent')
        time.sleep(.2)


def cleanup_sdk(docker, owner, image):
    ids = sdk_ids(docker, owner)
    if ids:
        if len(ids) != 1 or re.fullmatch('[a-f0-9]{64}', ids[0]) is None:
            raise ValueError('ambiguous SDK cleanup identity')
        template = '{"name":{{json .Name}},"image":{{json .Image}},"owner":{{json (index .Config.Labels "teetime.owner")}}}'
        info = strict_json(docker_call(docker, 'inspect', '--format', template, ids[0]))
        if not exact(info, {'name': '/'+owner, 'image': image, 'owner': owner}):
            raise ValueError('foreign SDK cleanup target')
        docker_call(docker, 'rm', '-f', ids[0])
    require_sdk_absent(docker, owner)


def run(args):
    hashes = freeze_helpers(args.source, args.base_source)
    for image in [args.builder_image, args.image]:
        if type(image) is not str or re.fullmatch('sha256:[a-f0-9]{64}', image) is None:
            raise ValueError('exact immutable images required')
    owner = 'teetime-fs-'+uuid.uuid4().hex[:12]
    require_sdk_absent(args.docker, owner)
    argv = [sys.executable, '-I', str(ROOT/'scripts/staging/probe-teetime-filesystem.py'),
        '--docker', args.docker, '--image', args.builder_image, '--expected-sha', args.base_source,
        '--artifact-fixture', '--artifact-joined', '--fixture-owner', owner,
        '--artifact-source', args.source, '--artifact-case', 'success', '--pids-budget', '128']
    try:
        code, output = capture(argv, 110, limit=16384)
        prepared = validate_sdk_output(code, output, owner=owner, image=args.builder_image,
            source=args.source, base_source=args.base_source, helper_hashes=hashes)
    finally:
        # Child capture kills/waits its operator before this exact-name reconciliation.
        # This is not an abrupt-parent-loss watchdog or a guarantee against late daemon work.
        cleanup_sdk(args.docker, owner, args.builder_image)
    evidence = {'sdkOwner': owner, 'builderImage': args.builder_image, 'artifactSource': args.source,
        'sdkOperatorExitCode': code, 'sdkOutputHash': hashlib.sha256(output).hexdigest(),
        'sdkOutputBase64': base64.b64encode(output).decode('ascii'),
        'sdkCompleted': True, 'sdkTruncated': False, 'sdkCleanupVerified': True,
        'artifactHash': prepared.raw_artifact_hash, 'bindingHash': prepared.binding_hash,
        'frameHash': hashlib.sha256(prepared.frame).hexdigest(), 'builderHelpers': hashes,
        'limitation': 'SDK prephase abrupt controller loss and late daemon completion are not qualified'}
    return materialize_run(args, prepared=prepared, sdk_evidence=evidence)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--docker', required=True)
    parser.add_argument('--builder-image', required=True)
    parser.add_argument('--image', required=True, help='materialization image')
    parser.add_argument('--source', required=True)
    parser.add_argument('--base-source', required=True)
    args = parser.parse_args()
    args.case = 'clean'
    if not __debug__:
        raise SystemExit('assertion-enabled Python required')
    result, root = run(args)
    print(json.dumps({'result': result, 'receiptDirectory': str(root)}))
    raise SystemExit(int(not result['passed']))
