import unittest
from unittest.mock import patch
from pathlib import Path
from teetime_canary_worker import oom_kills


class OomDiagnosticTests(unittest.TestCase):
    def test_reads_kernel_counter(self):
        with patch.object(Path, 'read_bytes', return_value=b'low 0\nhigh 0\noom 3\noom_kill 2\n'):
            self.assertEqual(oom_kills(), 2)

    def test_unavailable_or_malformed_never_becomes_zero(self):
        with patch.object(Path, 'read_bytes', side_effect=OSError):
            self.assertIsNone(oom_kills())
        for value in [b'low 0\n', b'oom_kill -1\n', b'oom_kill bad\n', b'x'*4097]:
            with self.subTest(value=value[:20]), patch.object(Path, 'read_bytes', return_value=value):
                self.assertIsNone(oom_kills())


if __name__ == '__main__':
    unittest.main()
