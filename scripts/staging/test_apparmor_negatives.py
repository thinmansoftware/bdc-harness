import subprocess
import sys
import tempfile
from pathlib import Path
import unittest

class NegativeAuditTests(unittest.TestCase):
    def check_log(self, lines):
        with tempfile.TemporaryDirectory() as directory:
            log=Path(directory)/'audit.log'
            log.write_text('\n'.join(lines))
            return subprocess.run([sys.executable,str(Path(__file__).with_name('verify-apparmor-negatives.py')),'teetime-probe-mount-1-1',str(log)],capture_output=True).returncode

    def test_both_exact_records_required(self):
        prefix='apparmor="DENIED" operation="mount" profile="teetime-probe-mount-1-1" comm="teetime-neg" fstype="tmpfs" srcname="tmpfs" '
        destination=prefix+'name="/protected/negative-mount/" flags="rw, nosuid, nodev"'
        options=prefix+'name="/tmp/" flags="rw, nosuid, noexec"'
        self.assertEqual(self.check_log([destination,options]),0)
        self.assertNotEqual(self.check_log([destination]),0)
        self.assertNotEqual(self.check_log([destination,options.replace('teetime-neg','other')]),0)
        self.assertNotEqual(self.check_log([destination,options.replace('noexec','nodev')]),0)
        self.assertNotEqual(self.check_log([destination,options,options]),0)

if __name__=='__main__': unittest.main()
