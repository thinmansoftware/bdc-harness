import importlib.util
from pathlib import Path
import subprocess
import sys
import time
import unittest

spec = importlib.util.spec_from_file_location('operator_delivery',
    Path(__file__).parent/'invoke-teetime-auth-canary.py')
operator = importlib.util.module_from_spec(spec); spec.loader.exec_module(operator)


class OperatorDeliveryTests(unittest.TestCase):
    def child(self, code):
        return subprocess.Popen([sys.executable, '-I', '-c', code], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def cleanup(self, child):
        if child.poll() is None: child.kill(); child.wait(timeout=5)
        try: child.stdin.close()
        except OSError: pass
        child.stdout.close()

    def test_broken_pipe_is_reaped_without_credentials(self):
        child = self.child('pass'); child.wait(timeout=5)
        try:
            with self.assertRaises((ValueError, BrokenPipeError, OSError)):
                operator.deliver_observation(child, b'{}\n', timeout=.2)
            self.assertIsNotNone(child.poll())
        finally: self.cleanup(child)

    def test_nonreading_child_is_killed_and_writer_settles_on_deadline(self):
        child = self.child('import time;time.sleep(30)')
        began = time.monotonic()
        try:
            with self.assertRaises(Exception):
                operator.deliver_observation(child, b'x'*65537, timeout=.1)
            self.assertIsNotNone(child.poll())
            self.assertLess(time.monotonic()-began, 5)
        finally: self.cleanup(child)


if __name__ == '__main__': unittest.main()
