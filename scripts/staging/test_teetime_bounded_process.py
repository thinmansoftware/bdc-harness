import sys
import unittest
from teetime_bounded_process import capture


class CaptureTests(unittest.TestCase):
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
