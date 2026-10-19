"""Synthetic GitHub observations only; no network or account access."""
import base64
import copy
import hashlib
import json
import unittest
from teetime_artifact_contract import canonical
from teetime_minimal_execution import minimal_admission_hash
import test_teetime_minimal_execution as fixtures
import teetime_plan_observation as observer


class MinimalPlanObservationTests(unittest.TestCase):
    def setUp(self):
        fixture=fixtures.MinimalExecutionTests();fixture.setUp()
        self.raw=canonical(fixture.value).encode('ascii')
        self.execution=fixture.parse();self.head='1'*40;self.nonce='2'*32
        self.inventory=b'{"version":1,"files":[]}'
        self.inventory_hash=hashlib.sha256(self.inventory).hexdigest()
        self.admission=minimal_admission_hash(self.execution,self.inventory_hash)
        self.carrier={'version':1,'kind':'teetime-minimal-admission-review',
            'executionHash':self.execution.package_hash,'installedManifestHash':self.inventory_hash,
            'operatorInputHash':self.execution.operator_input_hash,'source':self.execution.source,
            'admissionHash':self.admission}
        self.pull={'number':observer.PLAN_PR,'state':'open','merged_at':None,
            'head':{'sha':self.head,'repo':{'full_name':observer.REPOSITORY}},
            'base':{'repo':{'full_name':observer.REPOSITORY,'private':True}},'user':{'login':'builder'}}
        self.reviews=[{'id':12,'user':{'login':'thinman-overseer[bot]'},'state':'APPROVED',
            'commit_id':self.head,'submitted_at':'2026-10-19T00:00:00Z'}]
        self.calls=[]

    def read(self,path):
        self.calls.append(path)
        if path==observer.APP_STAGING_ENDPOINT:
            return {'ref':'refs/heads/staging','object':{'sha':observer.APP_BASE_SHA,'type':'commit'}}
        if '/contents/' in path:
            raw=canonical(self.carrier).encode('ascii')
            return {'type':'file','path':'docs/tee-time/minimal-diagnostic-admission.json',
                'encoding':'base64','content':base64.b64encode(raw).decode(),'size':len(raw)}
        if '/reviews?' in path:return self.reviews
        return self.pull

    def observe(self,**kwargs):
        return observer.observe_minimal_plan(self.raw,self.execution.package_hash,self.inventory,
            self.inventory_hash,self.head,self.nonce,read=self.read,clock=lambda:1000,**kwargs)

    def test_actual_reviewed_carrier_binds_packet_full_inventory_and_nonce(self):
        value=json.loads(self.observe())
        self.assertEqual(value['kind'],'tee-time-minimal-plan-observation')
        self.assertEqual(value['packagePath'],'docs/tee-time/minimal-diagnostic-admission.json')
        self.assertEqual(value['admissionHash'],'sha256:'+self.admission)
        self.assertEqual(value['installedManifestHash'],'sha256:'+self.inventory_hash)
        self.assertEqual(value['sourceSha'],self.execution.source)
        self.assertEqual(value['operatorInputHash'],self.execution.operator_input_hash)
        self.assertEqual(value['nonce'],self.nonce)
        self.assertTrue(any('ref='+self.head in path for path in self.calls))
        self.assertEqual(len(self.calls),5)

    def test_wrong_actual_carrier_fields_or_local_inventory_reject(self):
        original=copy.deepcopy(self.carrier)
        for key,bad in [('admissionHash','9'*64),('installedManifestHash','8'*64),
                ('source','f'*40),('executionHash','0'*64),('extra','PRIVATE')]:
            self.carrier={**original,key:bad}
            with self.subTest(key=key),self.assertRaises(ValueError):self.observe()
        self.carrier=original;self.inventory+=b' '
        with self.assertRaises(ValueError):self.observe()

    def test_final_head_change_and_incomplete_review_pages_reject(self):
        original=self.read;pull_reads=0
        def changed(path):
            nonlocal pull_reads
            value=original(path)
            if '/pulls/' in path and '/reviews?' not in path:
                pull_reads+=1
                if pull_reads==2:value=copy.deepcopy(value);value['head']['sha']='f'*40
            return value
        with self.assertRaises(ValueError):
            observer.observe_minimal_plan(self.raw,self.execution.package_hash,self.inventory,
                self.inventory_hash,self.head,self.nonce,read=changed,clock=lambda:1000)
        self.reviews=[{'state':'PENDING'}]*100
        with self.assertRaises(ValueError):self.observe()


if __name__=='__main__':unittest.main()
