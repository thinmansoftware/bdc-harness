import sys
import os
import threading
import unittest
from unittest.mock import patch
from teetime_bounded_process import capture


class CaptureTests(unittest.TestCase):
    def test_demo_packet_input_is_explicit_and_bounded(self):
        packet=b'x'*262144
        command=[sys.executable,'-c','import sys; print(len(sys.stdin.buffer.read()))']
        with self.assertRaises(ValueError): capture(command,5,input_bytes=packet)
        code,output=capture(command,5,input_bytes=packet,input_limit=262144)
        self.assertEqual(code,0);self.assertEqual(output.strip(),b'262144')
        with self.assertRaises(ValueError): capture(command,5,input_bytes=packet+b'x',input_limit=262144)
        with self.assertRaises(ValueError): capture(command,5,input_limit=999999)

    def test_explicit_environment_excludes_parent_git_sentinel(self):
        with patch.dict(os.environ, {'GIT_TEST_PARENT_SENTINEL':'parent'}):
            code,output=capture([sys.executable,'-c',
                'import os; print(os.getenv("GIT_TEST_PARENT_SENTINEL","absent")); print(os.getenv("TEETIME_PERMITTED"))'],
                5,env={'TEETIME_PERMITTED':'allowed'})
        self.assertEqual(code,0)
        self.assertEqual(output.splitlines(),[b'absent',b'allowed'])

    def test_omitted_environment_preserves_inheritance(self):
        with patch.dict(os.environ, {'GIT_TEST_PARENT_SENTINEL':'parent'}):
            code,output=capture([sys.executable,'-c','import os; print(os.getenv("GIT_TEST_PARENT_SENTINEL"))'],5)
        self.assertEqual(code,0)
        self.assertEqual(output.strip(),b'parent')

    def test_stream_callback_arrives_before_process_exit(self):
        ready = threading.Event()
        result = []
        def run():
            result.append(capture([sys.executable, '-c', 'import time; print("ready",flush=True); time.sleep(3); print("done")'],
                                  6,on_stdout=lambda chunk: ready.set()))
        task = threading.Thread(target=run)
        task.start()
        self.assertTrue(ready.wait(2))
        self.assertTrue(task.is_alive())
        task.join(timeout=5)
        self.assertFalse(task.is_alive())
        self.assertEqual(result[0][0], 0)

    def test_private_stdin_and_bounded_callback(self):
        seen = []
        code, output = capture([sys.executable, '-c', 'import sys; print(sys.stdin.read())'], 5,
                               input_bytes=b'synthetic private input', on_stdout=seen.append)
        self.assertEqual(code, 0)
        self.assertEqual(b''.join(seen), output)
        self.assertEqual(output.strip(), b'synthetic private input')

    def test_failed_process_is_reported_without_raw_stderr(self):
        code, output = capture([sys.executable, '-c', 'import sys; print("synthetic raw error",file=sys.stderr); sys.exit(7)'], 5)
        self.assertEqual(code, 7)
        self.assertEqual(output, b'')

    def test_only_stdout_returned(self):
        code, output = capture([sys.executable, '-c', 'import sys; print("safe"); print("discard",file=sys.stderr)'], 5)
        self.assertEqual(code, 0)
        self.assertEqual(output.strip(), b'safe')

    def test_output_limit_kills_child(self):
        with self.assertRaises(ValueError):
            capture([sys.executable, '-c', 'import sys; sys.stdout.write("x"*100000)'], 5, 1024)

    def test_timeout_kills_child(self):
        with self.assertRaises(Exception):
            capture([sys.executable, '-c', 'import time; time.sleep(20)'], .2)


if __name__ == '__main__':
    unittest.main()
