import importlib.util
from pathlib import Path
import subprocess
import sys
import time
import unittest
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('operator_delivery',
    Path(__file__).parent/'invoke-teetime-auth-canary.py')
operator = importlib.util.module_from_spec(spec); spec.loader.exec_module(operator)


class OperatorDeliveryTests(unittest.TestCase):
    def test_each_package_uses_only_its_fixed_controller_mode_and_root(self):
        from test_teetime_demo_execution import DemoExecutionTests
        f=DemoExecutionTests();f.setUp();first=f.parse()
        f.third_package();third=f.parse()
        f.value.update(version=2,kind='supervised-demo-v2',predecessor=f.value.pop('predecessors')[0])
        f.value['binding']['attempt']=2;second=f.parse()
        g=DemoExecutionTests();g.setUp();g.fourth_package();fourth=g.parse()
        args=SimpleNamespace(input_sha256='a'*64,demo_package_hash='b'*64,
            source_manifest_sha256='c'*64,artifact_source='d'*40,plan_head='e'*40)
        for execution,folder,mode in [(first,'execution-harness','--claim-model'),
                (second,'successor-execution-harness','--claim-successor'),
                (third,'diagnostic-execution-harness','--claim-diagnostic-successor'),
                (fourth,'transport-repair-execution-harness','--claim-transport-repair')]:
            command=operator.supervised_command(execution,args,'f'*32)
            self.assertIn('\\'+folder+'\\scripts\\staging\\teetime-supervised-controller.ts',command)
            self.assertIn(' '+mode+' --input-sha256 ',command)
            self.assertEqual(command.count('--claim-'),1)
            self.assertNotIn('run-teetime-auth-canary.py',command)

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
