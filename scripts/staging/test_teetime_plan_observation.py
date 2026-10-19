import base64
import hashlib
import json
import unittest
import test_teetime_demo_execution as execution_tests
from teetime_artifact_contract import canonical
from teetime_plan_observation import observe_plan, REPOSITORY, PLAN_PR, PACKAGE_PATH


class PlanObservationTests(unittest.TestCase):
    def setUp(self):
        fixture=execution_tests.DemoExecutionTests();fixture.setUp()
        self.raw=canonical(fixture.value).encode()
        self.digest=hashlib.sha256(self.raw).hexdigest()
        self.head='1'*40;self.nonce='2'*32
        self.pull={'number':PLAN_PR,'state':'open','merged_at':None,
            'head':{'sha':self.head,'repo':{'full_name':REPOSITORY}},
            'base':{'repo':{'full_name':REPOSITORY,'private':True}},'user':{'login':'builder'}}
        self.contents={'type':'file','path':PACKAGE_PATH,'encoding':'base64','size':len(self.raw),
                       'content':base64.b64encode(self.raw).decode()}
        self.calls=[]
        self.reviews=[{'id':12,'user':{'login':'thinman-overseer[bot]'},'state':'APPROVED',
                       'commit_id':self.head,'submitted_at':'2026-10-19T00:00:00Z'}]

    def read(self,path):
        self.calls.append(path)
        if '/contents/' in path:return self.contents
        if '/reviews?' in path:return self.reviews
        return self.pull

    def observe(self,**kwargs):
        return observe_plan(self.raw,self.digest,self.head,self.nonce,read=self.read,clock=lambda:1000,**kwargs)

    def test_exact_published_bytes_and_all_pages_bound_into_ephemeral_packet(self):
        value=json.loads(self.observe())
        self.assertEqual(value['executionHash'],'sha256:'+self.digest)
        self.assertEqual(value['nonce'],self.nonce)
        self.assertEqual(value['expiresAtMs']-value['observedAtMs'],60000)
        self.assertEqual(value['review']['reviews'][0]['submittedAt'],'2026-10-19T00:00:00Z')
        self.assertEqual(len(self.calls),4)

    def test_foreign_head_or_changed_package_cannot_become_observation(self):
        self.pull['head']['sha']='0'*40
        with self.assertRaises(ValueError):self.observe()
        self.pull['head']['sha']=self.head
        self.contents['content']=base64.b64encode(self.raw+b'changed').decode()
        with self.assertRaises(ValueError):self.observe()

    def test_pending_timestamp_not_fabricated_and_later_page_is_included(self):
        pending={'state':'PENDING','submitted_at':None}
        def read(path):
            if '/reviews?' in path:
                return [pending]*100 if path.endswith('page=1') else self.reviews
            return self.read(path)
        result=json.loads(observe_plan(self.raw,self.digest,self.head,self.nonce,read=read,clock=lambda:1000))
        self.assertEqual(len(result['review']['reviews']),1)

    def test_pagination_bound_and_expired_observation_rejected(self):
        def read(path):
            if '/reviews?' in path:return [{'state':'PENDING'}]*100
            return self.read(path)
        with self.assertRaises(ValueError):
            observe_plan(self.raw,self.digest,self.head,self.nonce,read=read,clock=lambda:1000)
        times=iter([1000,1046])
        with self.assertRaises(ValueError):
            observe_plan(self.raw,self.digest,self.head,self.nonce,read=self.read,clock=lambda:next(times))

    def test_head_changes_on_final_read_rejected(self):
        count=0
        def read(path):
            nonlocal count
            if '/reviews?' not in path and '/contents/' not in path:
                count+=1
                if count==2:self.pull['head']['sha']='0'*40
            return self.read(path)
        with self.assertRaises(ValueError):
            observe_plan(self.raw,self.digest,self.head,self.nonce,read=read,clock=lambda:1000)


if __name__=='__main__':unittest.main()
