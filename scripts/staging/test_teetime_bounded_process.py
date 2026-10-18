import sys
import threading
import unittest
from teetime_bounded_process import capture


class CaptureTests(unittest.TestCase):
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
