"""Real local pipes with fake SSH and synthetic login only. No host account read."""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import threading
import unittest
import uuid
from unittest.mock import patch
from teetime_artifact_contract import canonical
import test_teetime_minimal_execution as executions
import test_teetime_minimal_protocol as protocols

spec=importlib.util.spec_from_file_location('minimal_operator',Path(__file__).parent/'invoke-teetime-auth-canary.py')
operator=importlib.util.module_from_spec(spec);spec.loader.exec_module(operator)
REAL_POPEN=subprocess.Popen
REAL_THREAD_START=threading.Thread.start


class MinimalOperatorTests(unittest.TestCase):
    def cleanup_fixture_children(self):
        for timer in getattr(self,'timers',[]):
            timer.cancel()
            if timer.ident is not None:timer.join(timeout=1)
        for child,poll,wait in getattr(self,'child_methods',[]):
            child.poll=poll;child.wait=wait
            if child.poll() is None:child.kill()
            child.wait(timeout=3)
            for pipe in [child.stdin,child.stdout]:
                if pipe and not pipe.closed:pipe.close()

    def run_fixture(self,mode):
        p=protocols.MinimalProtocolTests();p.setUp();f=executions.MinimalExecutionTests();f.setUp()
        ready=p.ready;report=p.report;nonce=ready['nonce']
        f.value.update(source=ready['diagnosticSourceSha'],baseSource=ready['sourceSha'],image=ready['image'],
            selectedHashes=p.hashes,providerPolicyHash='sha256:'+p.hashes['packages/providers/src/codex/restricted-policy.ts'])
        execution=f.parse();raw=canonical(f.value).encode('ascii');manifest=b'{}'
        if mode=='wrong-ready':ready={**ready,'task':'filesystem'}
        if mode=='cleanup-failure':
            report['cleanupErrors']=[{'kind':'capture','id':None,'failure':'ThreadAlive'}]
            report['result'].update(passed=False,cleanupVerified=False)
        code=1 if mode=='cleanup-failure' else 0
        first=json.dumps(ready)+'\n';final=json.dumps(report)+'\n'
        if mode=='duplicate-key':first=first.replace('"type": "READY"','"type":"READY","type":"READY"')
        if mode=='missing-report':final=''
        if mode=='wrong-exit':code=1
        if mode=='trailing':final+='{}\n'
        program='''import sys,struct
assert sys.stdin.buffer.readline(32770)==b'{}\\n'
sys.stdout.write(%r);sys.stdout.flush()
raw=sys.stdin.buffer.read(65541)
assert len(raw)>=5 and struct.unpack('!I',raw[:4])[0]==len(raw)-4
assert b'synthetic-invalid' in raw
sys.stdout.write(%r);sys.stdout.flush();sys.exit(%r)
''' % (first,final,code)
        if mode=='timeout':program='import time;time.sleep(30)'
        self.children=[]
        self.timers=[];self.child_methods=[];self.addCleanup(self.cleanup_fixture_children)
        def fake_ssh(argv,**kwargs):
            self.assertEqual(argv[:2],['ssh','-T'])
            command=base64.b64decode(argv[-1]).decode('utf-16le')
            self.assertIn('--claim-minimal-diagnostic',command)
            self.assertIn('minimal-diagnostic-execution-harness',command)
            self.assertNotIn('run-teetime-auth-canary.py',command)
            child=REAL_POPEN([sys.executable,'-I','-u','-c',program],**kwargs)
            self.children.append(child);self.child_methods.append((child,child.poll,child.wait))
            if mode=='reap-failure':
                child.poll=lambda:None
                def unavailable(*args,**kwargs):raise subprocess.TimeoutExpired('synthetic-ssh',.01)
                child.wait=unavailable
            return child
        def thread_start(thread):
            is_timer=isinstance(thread,threading.Timer)
            if is_timer:self.timers.append(thread)
            if mode=='timer-start' and is_timer or mode=='reader-start' and not is_timer:
                raise RuntimeError('synthetic thread start failure')
            return REAL_THREAD_START(thread)
        def token(value):return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b'=').decode()
        jwt=token({'alg':'RS256'})+'.'+token({'exp':time.time()+7200})+'.synthetic-invalid'
        payload=json.dumps({'auth_mode':'chatgpt','tokens':{'access_token':jwt,'id_token':jwt,
            'refresh_token':'synthetic-invalid','account_id':'synthetic-invalid-account'}}).encode()
        login=Path.home()/'.codex/auth.json';self.reads=[]
        def frozen(path,expected=None,limit=262144):
            if Path(path).name=='minimal-execution.json':return raw
            if Path(path).name=='minimal-diagnostic-execution-source-manifest.json':return manifest
            if Path(path)==login:
                self.reads.append('synthetic-login-read')
                if mode in ['wrong-ready','duplicate-key']:raise AssertionError('login read before valid READY')
                return b'changed' if mode=='changed-auth' and len(self.reads)>1 else payload
            raise AssertionError('unexpected filesystem read')
        argv=['operator','--image',execution.image,'--expected-sha',execution.base_source,'--task','minimal-diagnostic',
            '--diagnostic-source',execution.source,'--diagnostic-package-hash',execution.package_hash,
            '--plan-head','e'*40,'--input-sha256',execution.operator_input_hash,
            '--source-manifest-sha256',hashlib.sha256(manifest).hexdigest()]
        if mode=='mixed':argv.append('--synthetic')
        self.output=io.StringIO()
        with patch.object(operator.subprocess,'Popen',side_effect=fake_ssh),patch.object(sys,'argv',argv), \
                patch.object(operator.uuid,'uuid4',return_value=uuid.UUID(nonce)), \
                patch('teetime_minimal_protocol.diagnostic_hashes',return_value=p.hashes), \
                patch('teetime_successor_observation.frozen_file',side_effect=frozen), \
                patch('teetime_plan_observation.observe_minimal_plan',return_value=b'{}'), \
                patch.object(operator,'MINIMAL_OUTER_SECONDS',.5 if mode=='timeout' else 450), \
                patch.object(operator,'MINIMAL_TRANSPORT_SECONDS',.1 if mode=='timeout' else 420), \
                patch.object(operator.threading.Thread,'start',new=thread_start),contextlib.redirect_stdout(self.output):
            result=operator.main()
        return result,json.loads(self.output.getvalue())

    def test_success_uses_supervised_entry_and_never_prints_synthetic_login(self):
        code,value=self.run_fixture('success')
        self.assertEqual(code,0);self.assertTrue(value['result']['passed']);self.assertTrue(value['originalAuthUnchanged'])
        self.assertNotIn('synthetic-invalid',self.output.getvalue());self.assertGreaterEqual(len(self.reads),2)

    def test_invalid_ready_never_reads_login(self):
        for mode in ['wrong-ready','duplicate-key']:
            with self.subTest(mode=mode),self.assertRaises(Exception):self.run_fixture(mode)
            self.assertEqual(self.reads,[]);self.assertEqual(self.output.getvalue(),'')

    def test_valid_outer_failure_retains_evidence_and_returns_failure(self):
        code,value=self.run_fixture('cleanup-failure')
        self.assertEqual(code,1);self.assertFalse(value['result']['passed']);self.assertFalse(value['result']['cleanupVerified'])
        self.assertTrue(value['result']['workerResult']['passed'])

    def test_missing_malformed_exit_trailing_or_changed_auth_cannot_print_success(self):
        for mode in ['missing-report','wrong-exit','trailing','changed-auth']:
            with self.subTest(mode=mode),self.assertRaises(Exception):self.run_fixture(mode)
            self.assertEqual(self.output.getvalue(),'')

    def test_timeout_reaps_owned_ssh_inside_outer_budget_without_reading_login(self):
        started=time.monotonic()
        with self.assertRaises(Exception):self.run_fixture('timeout')
        self.assertEqual(self.reads,[]);self.assertLess(time.monotonic()-started,1)
        self.assertEqual(len(self.children),1);self.assertIsNotNone(self.children[0].poll())
        self.assertEqual(self.output.getvalue(),'')

    def test_mixed_fixture_flags_reject_before_ssh_or_login(self):
        with self.assertRaises(ValueError):self.run_fixture('mixed')
        self.assertEqual(self.reads,[]);self.assertEqual(self.children,[])

    def test_setup_failures_after_spawn_always_reap_child_without_login(self):
        for mode in ['timer-start','reader-start']:
            with self.subTest(mode=mode),self.assertRaises(Exception):self.run_fixture(mode)
            self.assertEqual(self.reads,[]);self.assertEqual(len(self.children),1)
            self.assertIsNotNone(self.children[0].poll());self.assertEqual(self.output.getvalue(),'')

    def test_reap_failure_does_not_skip_original_auth_readback(self):
        with self.assertRaises(Exception):self.run_fixture('reap-failure')
        self.assertGreaterEqual(len(self.reads),2);self.assertEqual(self.output.getvalue(),'')

    def test_expired_input_deadline_still_attempts_writer_settlement(self):
        joins=[];threads=[]
        class TrackedThread(threading.Thread):
            def __init__(self,*args,**kwargs):super().__init__(*args,**kwargs);threads.append(self)
            def join(self,*args,**kwargs):joins.append(True);return super().join(*args,**kwargs)
        child=REAL_POPEN([sys.executable,'-I','-c','import time;time.sleep(30)'],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        try:
            with patch.object(operator.threading,'Thread',TrackedThread):
                with self.assertRaises(Exception):
                    operator.deliver_credential_frame(child,operator.encode_frame(b'x'*65536),
                        timeout=.1,deadline=time.monotonic()-1)
            self.assertTrue(joins)
        finally:
            if child.poll() is None:child.kill()
            child.wait(timeout=3)
            for thread in threads:
                if thread.ident is not None:thread.join(timeout=1)
            child.stdin.close();child.stdout.close()

    def test_maximum_frame_deadline_kills_nonreading_child_and_settles_writer(self):
        child=REAL_POPEN([sys.executable,'-I','-c','import time;time.sleep(30)'],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        try:
            frame=operator.encode_frame(b'x'*65536)
            with self.assertRaises(Exception):
                operator.deliver_credential_frame(child,frame,timeout=.1,deadline=time.monotonic()+1)
            self.assertIsNotNone(child.poll())
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=3)
            child.stdin.close();child.stdout.close()


if __name__=='__main__':unittest.main()
