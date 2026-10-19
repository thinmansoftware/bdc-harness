import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
from unittest.mock import patch

from teetime_successor_observation import observe_files, observe_two_histories, observe_three_histories
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
        raw=json.dumps(value,sort_keys=True,separators=(',',':')).encode('ascii')
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(raw)
        self.prior[key+'Hash']='sha256:'+hashlib.sha256(raw).hexdigest()
        self.paths[key]=path

    def prepare_third(self):
        import copy
        from teetime_auth_artifact_protocol import empty_worker_result
        from test_teetime_demo_execution import DemoExecutionTests
        fixture=DemoExecutionTests();fixture.setUp()
        self.write('execution',self.paths['execution'],fixture.value)
        for key in ['claim','lock','result']:
            value=json.loads(self.paths[key].read_bytes())
            if key=='result':value['artifactContractHash']=self.prior['executionHash'][7:]
            else:value['bindingHash']=self.prior['executionHash']
            self.write(key,self.paths[key],value)
        first={**self.prior,'attemptId':'ec3fd06e-5f27-4eda-9af1-2f759e4157ae',
               'completedAt':'2026-10-19T02:43:09.062Z','rowHash':'sha256:'+'1'*64}
        second_package=copy.deepcopy(fixture.value)
        second_package.update(version=2,kind='supervised-demo-v2',predecessor=first)
        second_package['binding']['attempt']=2
        self.prior={'owner':'teetime-auth-d2a4ae153136'}
        self.write('execution',self.root/'successor-execution-harness/demo-execution.json',second_package)
        for key,name in [('claim','model.claim.json'),('lock','controller.lock')]:
            value=json.loads((self.root/'control'/name).read_bytes())
            value['bindingHash']=self.prior['executionHash']
            self.write(key,self.root/'control-attempt-2'/name,value)
        worker=empty_worker_result(demo=True);del worker['taskFailureDiagnostic']
        worker.update(modelInvocations=None,authUnchanged=True,workspaceUnchanged=True,
            workspaceDiagnostic={'category':'unchanged','entryCount':2,'maskEntryCount':0},
            preflightPassed=True,preflightChecks=6,taskStarted=True,oomKillDelta=0)
        self.write('result',self.root/'control-attempt-2/model-result.json',
            {'type':'RESULT','task':'supervised-demo','owner':self.prior['owner'],
             'artifactContractHash':self.prior['executionHash'][7:],'cleanupErrors':[],
             'result':{'passed':False,'cleanupVerified':True,'proxyMetricsVerified':True,'artifactResult':worker}})
        self.write('manifest',self.root.parent/self.prior['owner']/'manifest.json',
            {'owner':self.prior['owner'],'deadline':1,'containers':['e'*64,'f'*64],'networks':['1'*64,'2'*64]})
        second={**self.prior,'attemptId':'2a99ad54-3b2b-45ae-a923-6c1a7073ac30',
                'completedAt':'2026-10-19T03:27:36.872Z','rowHash':'sha256:'+'2'*64}
        self.third_value=copy.deepcopy(fixture.value)
        self.third_value.update(version=3,kind='supervised-demo-v3',predecessors=[first,second])
        self.third_value['binding']['attempt']=3
        return self.parse_third()

    def parse_third(self):
        from teetime_artifact_contract import canonical
        from teetime_demo_execution import parse_demo_execution
        raw=canonical(self.third_value).encode()
        return parse_demo_execution(raw,hashlib.sha256(raw).hexdigest())

    def prepare_fourth(self):
        import copy
        from teetime_auth_artifact_protocol import empty_worker_result
        self.prepare_third()
        self.prior={'owner':'teetime-auth-558227ab727a'}
        self.write('execution',self.root/'diagnostic-execution-harness/demo-execution.json',self.third_value)
        for key,name in [('claim','model.claim.json'),('lock','controller.lock')]:
            value=json.loads((self.root/'control-attempt-2'/name).read_bytes())
            value['bindingHash']=self.prior['executionHash']
            self.write(key,self.root/'control-attempt-3'/name,value)
        worker=empty_worker_result(demo=True)
        worker.update(modelInvocations=1,authUnchanged=True,workspaceUnchanged=True,
            workspaceDiagnostic={'category':'unchanged','entryCount':2,'maskEntryCount':0},
            preflightPassed=True,preflightChecks=6,taskStarted=True,oomKillDelta=0,
            taskDiagnosticsPresent=True,providerIteratorClosed=True,elapsedMs=5418,failureCategory='rejected',
            taskFailureDiagnostic={'stage':'stream','exceptionCategory':'model_access_hint','lastEvent':'none'})
        self.write('result',self.root/'control-attempt-3/model-result.json',
            {'type':'RESULT','task':'supervised-demo','owner':self.prior['owner'],
             'artifactContractHash':self.prior['executionHash'][7:],'cleanupErrors':[],
             'result':{'passed':False,'cleanupVerified':True,'proxyMetricsVerified':True,'artifactResult':worker}})
        self.write('manifest',self.root.parent/self.prior['owner']/'manifest.json',
            {'owner':self.prior['owner'],'deadline':1,'containers':['3'*64,'4'*64],'networks':['5'*64,'6'*64]})
        third={**self.prior,'attemptId':'65380465-a8b3-462f-a114-11f941be8bf3',
            'completedAt':'2026-10-19T04:36:57.507Z','rowHash':'sha256:'+'3'*64}
        self.third_value=copy.deepcopy(self.third_value)
        self.third_value.update(version=4,kind='supervised-demo-v4')
        self.third_value['binding']['attempt']=4
        self.third_value['predecessors'].append(third)
        return self.parse_third()

    def test_three_histories_reconcile_all_fifteen_files_and_share_budget(self):
        execution=self.prepare_fourth();calls=[]
        value=observe_three_histories(self.root,execution.predecessors,'actual-run',lambda cmd:calls.append(cmd) or b'',execution)
        self.assertEqual(len(calls),12);self.assertEqual(len(value['predecessors']),3)
        self.assertTrue(value['resourcesAbsent'])
        with patch('teetime_successor_observation.time.time',side_effect=[100,101,102,121]):
            with self.assertRaises(ValueError):
                observe_three_histories(self.root,execution.predecessors,'actual-run',lambda cmd:b'',execution)

    def test_third_retained_failure_semantics_cannot_be_reinterpreted(self):
        self.prepare_fourth();path=self.paths['result'];original=path.read_bytes()
        for key,changed in [('modelInvocations',None),('taskDiagnosticsPresent',False),
                ('providerIteratorClosed',False),('normalProviderEnd',True),('authUnchanged',False),
                ('workspaceUnchanged',False),('assistantCount',1),('thinkingCount',1),
                ('artifactBase64','private-source'),('taskFailureDiagnostic',None),('failureCategory','not_started')]:
            value=json.loads(original);value['result']['artifactResult'][key]=changed
            self.write('result',path,value)
            self.third_value['predecessors'][2]['resultHash']=self.prior['resultHash']
            execution=self.parse_third()
            with self.subTest(key=key),self.assertRaises(ValueError):
                observe_three_histories(self.root,execution.predecessors,'actual-run',lambda cmd:b'',execution)

    def test_three_histories_recheck_all_files_after_last_resource_query(self):
        execution=self.prepare_fourth()
        paths=[]
        for folder,control,prior in zip(['execution-harness','successor-execution-harness','diagnostic-execution-harness'],
                                      ['control','control-attempt-2','control-attempt-3'],execution.predecessors):
            paths.extend([self.root/folder/'demo-execution.json',self.root/control/'model.claim.json',
                self.root/control/'controller.lock',self.root/control/'model-result.json',
                self.root.parent/prior['owner']/'manifest.json'])
        for path in paths:
            original=path.read_bytes();calls=0
            def query(command):
                nonlocal calls
                calls+=1
                if calls==12:path.write_bytes(original+b' ')
                return b''
            try:
                with self.subTest(path=path.name),self.assertRaises(ValueError):
                    observe_three_histories(self.root,execution.predecessors,'actual-run',query,execution)
            finally:path.write_bytes(original)

    def test_third_exact_resources_and_additional_owner_resources_are_checked(self):
        execution=self.prepare_fourth()
        for resource in ['3'*64,'5'*64]:
            def query(command):return b'' if '--filter' in command else (resource+'\n').encode()
            with self.subTest(resource=resource),self.assertRaises(ValueError):
                observe_three_histories(self.root,execution.predecessors,'actual-run',query,execution)
        def owned(command):
            return ('9'*64+'\n').encode() if '--filter' in command and command[-1].endswith(self.prior['owner']) else b''
        with self.assertRaises(ValueError):
            observe_three_histories(self.root,execution.predecessors,'actual-run',owned,execution)

    def test_retained_third_package_chain_and_authority_must_match(self):
        self.prepare_fourth()
        original={key:path.read_bytes() for key,path in self.paths.items()}
        for kind in ['pair','authority','prepared']:
            package=json.loads(original['execution'])
            if kind=='pair':package['predecessors'][0]['resultHash']='sha256:'+'9'*64
            elif kind=='authority':package['binding']['authorityHash']='sha256:'+'9'*64
            else:package['preparedBindingHash']='sha256:'+'9'*64
            self.write('execution',self.paths['execution'],package)
            for key in ['claim','lock','result']:
                value=json.loads(original[key])
                if key=='result':value['artifactContractHash']=self.prior['executionHash'][7:]
                else:value['bindingHash']=self.prior['executionHash']
                self.write(key,self.paths[key],value)
            self.third_value['predecessors'][2].update(self.prior)
            execution=self.parse_third()
            with self.subTest(kind=kind),self.assertRaises(ValueError):
                observe_three_histories(self.root,execution.predecessors,'actual-run',lambda cmd:b'',execution)

    def test_combined_histories_preserve_unknown_statistics_and_share_budget(self):
        execution=self.prepare_third();calls=[]
        def query(command):calls.append(command);return b''
        value=observe_two_histories(self.root,execution.predecessors,'actual-run',query,execution)
        self.assertTrue(value['resourcesAbsent']);self.assertEqual(len(calls),8)
        self.assertEqual(len(value['predecessors']),2)
        with patch('teetime_successor_observation.time.time',side_effect=[100,101,121]):
            with self.assertRaises(ValueError):
                observe_two_histories(self.root,execution.predecessors,'actual-run',lambda cmd:b'',execution)

    def test_second_unknown_statistics_cannot_be_invented_or_new_schema_required(self):
        self.prepare_third();path=self.paths['result'];original=path.read_bytes()
        for key,changed in [('modelInvocations',0),('modelInvocations',1),('taskDiagnosticsPresent',True),
                            ('normalProviderEnd',True),('providerIteratorClosed',True),('authUnchanged',False),
                            ('workspaceUnchanged',False),('artifactBase64','private-source')]:
            value=json.loads(original);value['result']['artifactResult'][key]=changed
            self.write('result',path,value)
            self.third_value['predecessors'][1]['resultHash']=self.prior['resultHash']
            execution=self.parse_third()
            with self.subTest(key=key,changed=changed),self.assertRaises(ValueError):
                observe_two_histories(self.root,execution.predecessors,'actual-run',lambda cmd:b'',execution)

    def test_first_history_cannot_change_during_second_resource_observation(self):
        execution=self.prepare_third();calls=0
        def query(command):
            nonlocal calls
            calls+=1
            if calls==5:(self.root/'control/model-result.json').write_bytes(b'{}')
            return b''
        with self.assertRaises(ValueError):
            observe_two_histories(self.root,execution.predecessors,'actual-run',query,execution)

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
