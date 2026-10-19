import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
from unittest.mock import patch

from teetime_successor_observation import observe_files
from teetime_bounded_process import capture


class SuccessorObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'teetime-supervised-01'
        self.owner = 'teetime-auth-5eca42816a98'
        self.prior = {'owner':self.owner}
        self.paths = {}
        self.write('execution',self.root/'execution-harness/demo-execution.json',
            {'version':1,'kind':'supervised-demo-v1','binding':
             {'runId':'run','nodeId':'implement','attempt':1}})
        self.write('claim',self.root/'control/model.claim.json',
            {'version':1,'phase':'model','bindingHash':self.prior['executionHash'],
             'reviewId':1,'reviewHead':'a'*40,'reviewer':'thinman-overseer[bot]','state':'APPROVED'})
        self.write('lock',self.root/'control/controller.lock',
            {'version':1,'owner':'original','pid':123,'bindingHash':self.prior['executionHash']})
        self.write('result',self.root/'control/model-result.json',
            {'type':'RESULT','task':'supervised-demo','owner':self.owner,
             'artifactContractHash':self.prior['executionHash'][7:],'cleanupErrors':[],
             'result':{'passed':False,'cleanupVerified':True,'proxyMetricsVerified':True,
              'artifactResult':{'authUnchanged':True,'normalProviderEnd':True,
               'providerIteratorClosed':True,'modelInvocations':1,'workspaceUnchanged':False,
               **{key:None for key in ['artifactBase64','artifactHash','bindingHash','manifestHash','sourceTree']}}}})
        self.write('manifest',self.root.parent/self.owner/'manifest.json',
            {'owner':self.owner,'deadline':1,'containers':['a'*64,'b'*64],'networks':['c'*64,'d'*64]})

    def write(self,key,path,value):
        raw=json.dumps(value).encode('ascii')
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(raw)
        self.prior[key+'Hash']='sha256:'+hashlib.sha256(raw).hexdigest()
        self.paths[key]=path

    def test_fresh_files_and_absent_exact_and_label_resources_pass(self):
        calls=[]
        def query(command):
            calls.append(command)
            return b''
        value=observe_files(self.root,self.prior,'run',query)
        self.assertTrue(value['resourcesAbsent'])
        self.assertEqual(value['manifestHash'],self.prior['manifestHash'])
        self.assertEqual(value['lockHash'],self.prior['lockHash'])
        self.assertEqual(len(calls),4)
        self.assertEqual(value['expiresAt']-value['observedAt'],30000)

    def test_each_changed_original_file_rejects(self):
        for key in self.paths:
            path=self.paths[key];original=path.read_bytes()
            path.write_bytes(original+b' ')
            with self.subTest(key=key),self.assertRaises(ValueError):
                observe_files(self.root,self.prior,'run',lambda command:b'')
            path.write_bytes(original)

    def test_resources_present_even_without_owner_label_reject(self):
        for resource in ['a'*64,'c'*64]:
            def query(command):
                if '--filter' in command:return b''
                return (resource+'\n').encode()
            with self.subTest(resource=resource),self.assertRaises(ValueError):
                observe_files(self.root,self.prior,'run',query)

    def test_extra_owned_resources_and_query_failure_reject(self):
        def owned(command):
            return ('e'*64+'\n').encode() if '--filter' in command else b''
        with self.assertRaises(ValueError):observe_files(self.root,self.prior,'run',owned)
        def failed(command):raise RuntimeError('unavailable Docker')
        with self.assertRaises(RuntimeError):observe_files(self.root,self.prior,'run',failed)

    def test_changed_file_during_resource_read_rejects(self):
        def query(command):
            self.paths['result'].write_bytes(b'{}')
            return b''
        with self.assertRaises(ValueError):observe_files(self.root,self.prior,'run',query)

    def test_collection_expiry_and_malformed_inventory_reject(self):
        with patch('teetime_successor_observation.time.time',side_effect=[100,121]):
            with self.assertRaises(ValueError):observe_files(self.root,self.prior,'run',lambda cmd:b'')
        with self.assertRaises(ValueError):
            observe_files(self.root,self.prior,'run',lambda cmd:b'truncated-id\n')

    def test_query_timeout_reaps_actual_child_and_rejects_reconciliation(self):
        children=[]
        popen=subprocess.Popen
        def start(*args,**kwargs):
            child=popen(*args,**kwargs);children.append(child);return child
        def query(command):
            return capture([sys.executable,'-c','import time; time.sleep(30)'],.1)[1]
        with patch('teetime_bounded_process.subprocess.Popen',side_effect=start):
            with self.assertRaises(Exception):observe_files(self.root,self.prior,'run',query)
        self.assertEqual(len(children),1)
        self.assertIsNotNone(children[0].poll())
        self.assertIsNotNone(children[0].returncode)


if __name__=='__main__':unittest.main()
