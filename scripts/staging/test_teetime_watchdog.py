import unittest
import json
import subprocess
from types import SimpleNamespace
from unittest.mock import patch
from teetime_watchdog import validate_manifest, cleanup

class ManifestTests(unittest.TestCase):
    def test_demo_deadline_is_closed_and_canary_bound_unchanged(self):
        from teetime_demo_execution import DEMO_LIMITS
        data=self.valid();data['deadline']=1000+DEMO_LIMITS['watchdogSeconds']
        self.assertEqual(validate_manifest(data,1000,'supervised-demo'),data)
        with self.assertRaises(ValueError): validate_manifest(data,1000)
        with self.assertRaises(ValueError): validate_manifest(data,1000,'unbounded')
        data['deadline']+=1
        with self.assertRaises(ValueError): validate_manifest(data,1000,'supervised-demo')

    def valid(self):
        return {'owner':'teetime-auth-0123456789ab','deadline':1100,
                'containers':['a'*64],'networks':['b'*64]}

    def test_exact_owner_ids_and_bounded_deadline(self):
        self.assertEqual(validate_manifest(self.valid(),1000),self.valid())

    def test_wrong_owner_bad_ids_duplicates_and_deadline_rejected(self):
        for key,value in [('owner','production'),('containers',['worker-name']),
                          ('containers',[]),('containers',['a'*64,'a'*64]),
                          ('networks',['a'*64]),('deadline',1301),('deadline',999),
                          ('deadline',float('inf')),('deadline',True)]:
            with self.subTest(key=key,value=value):
                data=self.valid();data[key]=value
                with self.assertRaises(ValueError): validate_manifest(data,1000)

    def test_unknown_fields_rejected(self):
        data=self.valid();data['token']='synthetic'
        with self.assertRaises(ValueError): validate_manifest(data,1000)

    def test_absent_resources_are_not_deleted(self):
        with patch('teetime_watchdog.subprocess.run',return_value=SimpleNamespace(stdout=b'')) as run:
            self.assertEqual(cleanup('docker',self.valid()),[])
            self.assertEqual(run.call_count,2)
            self.assertTrue(all('rm' not in call.args[0] for call in run.call_args_list))

    def test_wrong_labels_never_authorize_deletion(self):
        def respond(argv,**kwargs):
            rid='a'*64 if argv[1]=='container' else 'b'*64
            value=(rid+'\n').encode() if 'ls' in argv else json.dumps([{
                'Id':rid,'Config':{'Labels':{'teetime.owner':'foreign'}},
                'Labels':{'teetime.owner':'foreign'}}]).encode()
            return SimpleNamespace(stdout=value)
        with patch('teetime_watchdog.subprocess.run',side_effect=respond) as run:
            self.assertEqual(len(cleanup('docker',self.valid())),2)
            self.assertTrue(all('rm' not in call.args[0] for call in run.call_args_list))

    def test_daemon_failure_is_not_absence(self):
        with patch('teetime_watchdog.subprocess.run',side_effect=subprocess.CalledProcessError(1,['docker'])):
            self.assertEqual(len(cleanup('docker',self.valid())),2)

if __name__=='__main__': unittest.main()
