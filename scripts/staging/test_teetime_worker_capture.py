"""Real credential-free POSIX child capture; Windows cannot select pipe handles."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('capture_worker', Path(__file__).with_name('teetime_canary_worker.py'))
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


@unittest.skipUnless(os.name == 'posix', 'requires actual POSIX process groups and selectable pipes')
class WorkerCaptureTests(unittest.TestCase):
    def capture(self, source, timeout=3, **kwargs):
        children = []
        original = subprocess.Popen
        with tempfile.TemporaryDirectory() as root:
            def start(argv, **options):
                options['cwd'] = root
                child = original(argv, **options)
                children.append(child)
                return child
            try:
                with patch.object(worker.subprocess, 'Popen', side_effect=start):
                    return worker.bounded_process([sys.executable, '-I', '-c', source], timeout,
                                                  env={}, **kwargs)
            finally:
                self.assertEqual(len(children), 1)
                self.assertIsNotNone(children[0].poll(), 'child must be reaped before return or exception')

    def test_nonzero_diagnostics_require_explicit_capture_mode(self):
        source = 'import sys; print("safe-packet"); sys.exit(1)'
        self.assertEqual(self.capture(source, include_exit_code=True), (1, b'safe-packet\n'))
        with self.assertRaisesRegex(ValueError, 'subprocess failed'):
            self.capture(source)

    def test_timeout_never_returns_partial_packet(self):
        with self.assertRaises(TimeoutError):
            self.capture('import time; print("partial", flush=True); time.sleep(10)',
                         timeout=.2, include_exit_code=True)

    def test_combined_output_overflow_never_returns_partial_packet(self):
        for stream in ['stdout', 'stderr']:
            with self.subTest(stream=stream), self.assertRaisesRegex(ValueError, 'output bound'):
                self.capture('import sys; sys.' + stream + '.write("x" * 1048577)',
                             include_exit_code=True)

    def test_success_and_input_stay_compatible(self):
        source = 'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())'
        self.assertEqual(self.capture(source, input_bytes=b'packet'), b'packet')
        self.assertEqual(self.capture(source, input_bytes=b'packet', include_exit_code=True),
                         (0, b'packet'))


if __name__ == '__main__':
    unittest.main()
