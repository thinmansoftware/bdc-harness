"""Pure source assertions, not browser execution or sandbox qualification."""
import json
from pathlib import Path
import unittest

class BrowserSeccompTests(unittest.TestCase):
    def test_only_documented_namespace_rule_extends_retained_docker_default(self):
        root=Path(__file__).resolve().parent
        base=json.loads((root/'moby-default-seccomp.json').read_text())
        actual=json.loads((root/'teetime-browser-seccomp.json').read_text())
        extra={'comment':'Playwright documented user namespace sandbox permissions',
            'names':['clone','setns','unshare'],'action':'SCMP_ACT_ALLOW',
            'args':[],'includes':{},'excludes':{}}
        chroot={'comment':'Chromium sandbox chroot with outer capabilities dropped',
            'names':['chroot'],'action':'SCMP_ACT_ALLOW','args':[],'includes':{},'excludes':{}}
        self.assertEqual(actual,{**base,'syscalls':base['syscalls']+[extra,chroot]})
        self.assertEqual(actual['defaultAction'],'SCMP_ACT_ERRNO')
        self.assertNotIn('mount',extra['names'])

if __name__=='__main__':unittest.main()
