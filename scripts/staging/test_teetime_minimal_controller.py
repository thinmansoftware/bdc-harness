"""Argument and fixed dispatch tests; no Docker, account or model execution."""
import importlib.util
import contextlib
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import test_teetime_minimal_worker as fixtures
from teetime_minimal_protocol import ALL_PATHS, validate_diagnostic_report
from teetime_artifact_workspace import worker_tmpfs
import teetime_connect_proxy as proxy

PATH = Path(__file__).with_name('run-teetime-auth-canary.py')
SPEC = importlib.util.spec_from_file_location('minimal_remote', PATH)
controller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(controller)
COMMON = ['--docker', 'PRIVATE-Docker', '--image', 'sha256:'+'a'*64,
          '--expected-sha', 'b'*40, '--nonce', 'c'*32]


class MinimalControllerTests(unittest.TestCase):
    def test_new_selector_requires_its_own_source_and_cannot_mix(self):
        args = controller.parse_controller_arguments(COMMON+['--task', 'minimal-diagnostic', '--diagnostic-source', 'd'*40])
        self.assertEqual(args.diagnostic_source, 'd'*40)
        self.assertIsNone(args.artifact_source)
        for extra in [[], ['--artifact-source', 'd'*40], ['--demo-package-hash', 'e'*64]]:
            flags = COMMON+['--task', 'minimal-diagnostic']
            if extra: flags+=['--diagnostic-source', 'd'*40]+extra
            with self.assertRaises(ValueError): controller.parse_controller_arguments(flags)
        with self.assertRaises(ValueError):
            controller.parse_controller_arguments(COMMON+['--task', 'artifact', '--diagnostic-source', 'd'*40])

    def test_actual_dispatch_selects_only_the_fixed_worker_and_diagnostic_proxy(self):
        args = controller.parse_controller_arguments(COMMON+['--task', 'minimal-diagnostic', '--diagnostic-source', 'd'*40])
        command, timeout, limit = controller.diagnostic_worker_dispatch(args, 'f'*64)
        self.assertEqual(command, ['PRIVATE-Docker', 'exec', '-w', '/workspace', 'f'*64, 'python3', '-I',
            '/app/scripts/staging/teetime_minimal_worker.py', '--nonce', 'c'*32, '--source', 'd'*40])
        self.assertEqual((timeout, limit), (180, 8192))
        self.assertEqual(controller.gateway_command(args.task, False), ['-I', '-', '--diagnostic-receipt'])
        self.assertEqual(controller.gateway_command('artifact', False), ['-I', '-'])
        self.assertEqual(controller.gateway_command('supervised-demo', True), ['-I', '-', '--task', 'supervised-demo'])

    def test_actual_script_rejects_invalid_mixed_help_before_docker(self):
        for flags in [['--PRIVATE-ARGUMENT'], ['--help'],
                      COMMON+['--task', 'minimal-diagnostic'],
                      COMMON+['--task', 'artifact', '--diagnostic-source', 'd'*40]]:
            child = subprocess.run([sys.executable, '-I', str(PATH), *flags], capture_output=True, timeout=10)
            self.assertEqual(child.returncode, 1)
            self.assertEqual(child.stdout, b''); self.assertEqual(child.stderr, b'')

    def test_actual_main_ready_capture_and_cleanup_with_only_synthetic_driver(self):
        for cleanup_fails in [False, True]:
            with self.subTest(cleanup_fails=cleanup_fails), tempfile.TemporaryDirectory() as folder:
                args = controller.parse_controller_arguments(COMMON+['--task', 'minimal-diagnostic', '--diagnostic-source', 'd'*40])
                hashes = {name: hashlib.sha256(name.encode()).hexdigest() for name in ALL_PATHS}
                worker, _ = fixtures.MinimalWorkerTests().execute()
                worker.update(nonce=args.nonce, source=args.diagnostic_source)
                internal, egress = '3'*64, '4'*64
                containers = {}; owner = None; stopped = threading.Event(); captures = []
                output = io.StringIO()
                with patch.multiple(proxy, outcomes={}, parser_reasons={}, non_parser_reasons={},
                                    active=0, process_bytes=0, diagnostic_invalid=False):
                    metrics = proxy.build_proxy_receipt(True)

                def driver(argv, **kwargs):
                    nonlocal owner
                    command = argv[1:]
                    value = b''
                    if command[:2] == ['image', 'inspect']:
                        value = json.dumps([{'Id': args.image, 'Config': {'Env': [
                            'ARCHON_BUILD_SHA='+args.expected_sha,
                            'TEETIME_AUTH_ARTIFACT_SOURCE_SHA='+args.diagnostic_source]}}]).encode()
                    elif command[:2] == ['network', 'create']:
                        owner = next(item.split('=', 1)[1] for item in command if item.startswith('teetime.owner='))
                        value = (internal if '--internal' in command else egress).encode()
                    elif command[:2] == ['network', 'inspect']:
                        value = json.dumps([{'Internal': command[-1] == internal, 'Labels': {'teetime.owner': owner}}]).encode()
                    elif command[0] == 'create':
                        role = 'worker' if command[command.index('--name')+1].endswith('-worker') else 'gateway'
                        identifier = ('5' if role == 'worker' else '6')*64
                        profile = json.loads((PATH.parent/'codex-probe-seccomp.json').read_text())
                        host = {'ReadonlyRootfs': True, 'Privileged': False, 'CapDrop': ['ALL'],
                            'Memory': 512*1024**2, 'MemorySwap': 512*1024**2, 'NanoCpus': 1000000000,
                            'PidsLimit': 128 if role == 'worker' else 64, 'LogConfig': {'Type': 'none'},
                            'SecurityOpt': ['no-new-privileges:true']+(['seccomp='+json.dumps(profile)] if role == 'worker' else [])}
                        if role == 'worker': host['Tmpfs'] = worker_tmpfs(True)
                        nets = {owner+'-internal': {'NetworkID': internal}}
                        if role == 'gateway': nets[owner+'-egress'] = {'NetworkID': egress}
                        containers[identifier] = {'Image': args.image, 'Mounts': [], 'HostConfig': host,
                            'Config': {'User': '1001:1001', 'Labels': {'teetime.owner': owner},
                                'Entrypoint': ['python3'], 'Cmd': command[command.index(args.image)+1:], 'OpenStdin': role == 'gateway'},
                            'NetworkSettings': {'Networks': nets}, 'State': {'Running': False}}
                        value = identifier.encode()
                    elif command[0] == 'inspect': value = json.dumps([containers[command[-1]]]).encode()
                    elif command[0] == 'start': containers[command[-1]]['State']['Running'] = True
                    elif command[0] == 'kill':
                        containers[command[-1]]['State']['Running'] = False; stopped.set()
                    elif command[0] == 'exec':
                        if 'sha256sum' in command:
                            names = command[command.index('sha256sum')+1:]
                            value = ''.join(hashes[name.removeprefix('/app/')]+'  '+name+'\n' for name in names).encode()
                        elif any('require_readonly_workspace' in part for part in command):
                            value = b'{"write":"EROFS","create":"EROFS","rename":"EROFS"}'
                        elif any('teetime_auth_receiver.py' in part for part in command):
                            self.assertEqual(kwargs['input'], b'PRIVATE-SYNTHETIC-FRAME')
                            value = b'{"installed":true}'
                    elif command[:2] in [['container', 'ls'], ['network', 'ls']]:
                        value = b''  # Verified owned labels absent after mocked cleanup.
                    elif command[:2] != ['network', 'connect']:
                        raise AssertionError('unexpected synthetic driver command')
                    return SimpleNamespace(stdout=value)

                def watchdog(_argv, **_kwargs):
                    root = Path(folder)/owner; raw = (root/'manifest.json').read_bytes(); data = json.loads(raw)
                    self.assertEqual(round(data['deadline']-controller.time.time()), 300)
                    (root/'watchdog-ready.json').write_text(json.dumps({'owner': owner, 'deadline': data['deadline'],
                        'manifestSha256': hashlib.sha256(raw).hexdigest(), 'pid': 123}))
                    return SimpleNamespace()

                def capture(argv, **kwargs):
                    if 'attach' in argv:
                        ready = b'{"proxyReady":true,"diagnosticVersion":1}\n'
                        kwargs['on_stdout'](ready)
                        self.assertTrue(stopped.wait(5))
                        return 0, ready+json.dumps(metrics).encode()+b'\n'
                    captures.append((argv, kwargs))
                    return 0, json.dumps(worker).encode()

                def receive(_stream):
                    lines = output.getvalue().splitlines()
                    self.assertEqual(len(lines), 1); self.assertEqual(json.loads(lines[0])['type'], 'READY')
                    return b'PRIVATE-SYNTHETIC-FRAME'

                def process_status(_handle, pointer): pointer._obj.value = 259; return True
                kernel = SimpleNamespace(OpenProcess=lambda *_: 1, GetExitCodeProcess=process_status, CloseHandle=lambda _: True)
                with patch.object(controller, 'parse_controller_arguments', return_value=args), \
                        patch.object(controller, 'os', SimpleNamespace(name='nt')), \
                        patch.object(controller.Path, 'home', return_value=Path(folder)), \
                        patch('teetime_minimal_protocol.diagnostic_hashes', return_value=hashes), \
                        patch.object(controller.subprocess, 'run', side_effect=driver), \
                        patch.object(controller.subprocess, 'Popen', side_effect=watchdog), \
                        patch.object(controller.subprocess, 'DETACHED_PROCESS', 0, create=True), \
                        patch.object(controller.subprocess, 'CREATE_NEW_PROCESS_GROUP', 0, create=True), \
                        patch.object(controller.subprocess, 'CREATE_BREAKAWAY_FROM_JOB', 0, create=True), \
                        patch.object(controller.ctypes, 'WinDLL', return_value=kernel, create=True), \
                        patch.object(controller, 'capture', side_effect=capture), \
                        patch.object(controller, 'read_frame', side_effect=receive), \
                        patch.object(controller, 'validate_payload'), \
                        patch.object(controller, 'cleanup', side_effect=TimeoutError('PRIVATE-CLEANUP') if cleanup_fails else None, return_value=[]), \
                        contextlib.redirect_stdout(output):
                    code = controller.main()
                lines = output.getvalue().splitlines()
                self.assertEqual(len(lines), 2)
                report = validate_diagnostic_report(lines[1].encode(), code, ready=json.loads(lines[0]))
                self.assertEqual(code, 1 if cleanup_fails else 0)
                self.assertEqual(len(captures), 1)
                self.assertEqual(captures[0][1], {'timeout': 180, 'limit': 8192})
                self.assertTrue(report['result']['workerResult']['passed'])
                self.assertNotIn('PRIVATE', output.getvalue())


if __name__ == '__main__': unittest.main()
