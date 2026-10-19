import json
import importlib.util
import contextlib
import io
import os
from pathlib import Path
import tempfile
import traceback
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from teetime_startup_control import startup_settings, verify_startup_identity, require_private_repository, require_private_context, BINARY_HASH, CATALOG_HASH, StartupController
from teetime_reviewer_probe import remove_owned_reviewer
from teetime_startup_packet import startup_metadata, startup_failure_diagnostic


class StartupControlTests(unittest.TestCase):
    def test_v3_failure_projection_bounds_exchange_and_preserves_legacy_v2(self):
        exchange={'category':'notification-shape','response2Observed':False,
                  'acceptedNotifications':0,'observedBytes':240,'reapUncertain':True}
        good={'kind':'teetime-startup-capture-failed-v3','phase':'thread-start-exchange','exchange':exchange}
        self.assertEqual(startup_failure_diagnostic(json.dumps(good).encode(),1),good)
        early={'kind':'teetime-startup-capture-failed-v3','phase':'imports','exchange':None}
        self.assertEqual(startup_failure_diagnostic(json.dumps(early).encode(),1),early)
        for change in [{'category':'PRIVATE'}, {'observedBytes':True}, {'observedBytes':65538},
                       {'observedBytes':-1}, {'acceptedNotifications':2}, {'acceptedNotifications':True},
                       {'response2Observed':1}, {'reapUncertain':0}, {'error':'PRIVATE'}]:
            with self.assertRaises(ValueError) as caught:
                startup_failure_diagnostic(json.dumps({**good,'exchange':{**exchange,**change}}).encode(),1)
            self.assertNotIn('PRIVATE',str(caught.exception))
        for value in [{**good,'phase':'imports'}, {k:v for k,v in good.items() if k!='exchange'},
                      {**good,'exchange':{}}, {**good,'extra':'PRIVATE'}]:
            with self.assertRaises(ValueError): startup_failure_diagnostic(json.dumps(value).encode(),1)
        with self.assertRaises(ValueError): startup_metadata(json.dumps(good).encode())

    def test_failure_projection_is_closed_and_never_accepts_private_or_ambiguous_output(self):
        good={'kind':'teetime-startup-capture-failed-v2','phase':'native-version'}
        self.assertEqual(startup_failure_diagnostic(json.dumps(good).encode(),1),good)
        hostile='PRIVATE-OUTPUT-MARKER'
        for raw,code in [
            (json.dumps({**good,'error':hostile}).encode(),1),
            (json.dumps({**good,'phase':hostile}).encode(),1),
            (b'{"kind":"teetime-startup-capture-failed-v2","phase":"imports","phase":"context"}',1),
            (json.dumps(good).encode()+b' '+hostile.encode(),1),
            (b'x'*2049,1),(b'\xff',1),(json.dumps(good).encode(),0),
            (json.dumps(good).encode(),True),
        ]:
            with self.assertRaises(ValueError) as caught: startup_failure_diagnostic(raw,code)
            self.assertNotIn(hostile,str(caught.exception))
        with self.assertRaises(ValueError): startup_metadata(json.dumps(good).encode())
    def test_invalid_native_utf8_cannot_escape_through_host_traceback(self):
        spec=importlib.util.spec_from_file_location('teetime_startup_capture_test',Path(__file__).with_name('run-codex-sandbox-probe.py'))
        runner=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        raw=b'PRIVATE-STARTUP-SYNTHETIC-MARKER-\xff'
        public=io.StringIO()
        with contextlib.redirect_stdout(public),contextlib.redirect_stderr(public):
            try:
                result=runner.completed_capture(0,raw,'startup')
                startup_metadata(result.stdout)
            except ValueError: traceback.print_exc()
        self.assertNotIn('PRIVATE-STARTUP-SYNTHETIC-MARKER',public.getvalue())
        self.assertNotIn('UnicodeDecodeError',public.getvalue())
        self.assertNotIn('0xff',public.getvalue())
        self.assertIn('startup packet JSON rejected',public.getvalue())
    def test_main_startup_route_cannot_reach_docker_before_private_context_check(self):
        spec=importlib.util.spec_from_file_location('teetime_startup_runner_test',Path(__file__).with_name('run-codex-sandbox-probe.py'))
        runner=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        argv=['probe','--kind','startup','--image','fixed-image','--expected-sha','a'*40,
              '--startup-owner','teetime-startup-123-1','--startup-root','unused',
              '--apparmor-profile','teetime-probe-mount-123-1']
        with patch('sys.argv',argv),patch.object(runner,'require_private_context',side_effect=ValueError('private rejected')) as context,patch.object(runner.subprocess,'run') as process:
            with self.assertRaisesRegex(ValueError,'private rejected'): runner.main()
            context.assert_called_once_with('unused','teetime-startup-123-1')
            process.assert_not_called()

    @unittest.skipUnless(os.name=='posix','requires actual POSIX filesystem')
    def test_real_posix_context_requires_0700_exact_path_and_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            temporary=Path(directory).resolve()
            root=temporary/'teetime-private-123-1'
            root.mkdir(mode=0o700)
            env={'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':'thinmansoftware/bdc-xo',
                 'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1',
                 'RUNNER_TEMP':str(temporary)}
            with patch('teetime_startup_control.require_private_repository') as private:
                require_private_context(root,'teetime-startup-123-1',env)
                private.assert_called_once()
                with self.assertRaises(ValueError): require_private_context(root,'teetime-startup-123-2',env)
                root.chmod(0o755)
                with self.assertRaises(ValueError): require_private_context(root,'teetime-startup-123-1',env)
    def test_public_unknown_or_failed_visibility_is_not_accepted(self):
        for result in [SimpleNamespace(returncode=0,stdout='false'),
                       SimpleNamespace(returncode=1,stdout='true'),
                       SimpleNamespace(returncode=0,stdout='null')]:
            with patch('teetime_startup_control.subprocess.run',return_value=result):
                with self.assertRaisesRegex(RuntimeError,'private repository check failed'):
                    require_private_repository()
        with patch('teetime_startup_control.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout='true\n')) as run:
            require_private_repository()
            self.assertEqual(run.call_args.args[0],['gh','api','repos/thinmansoftware/bdc-xo','--jq','.private'])

    def test_public_or_non_dispatch_host_context_rejected_before_paths_or_gh(self):
        with patch('teetime_startup_control.require_private_repository') as gh:
            for env in [{},{'GITHUB_ACTIONS':'true','GITHUB_REPOSITORY':'thinmansoftware/bdc-harness',
                            'GITHUB_EVENT_NAME':'workflow_dispatch'}]:
                with self.assertRaises(ValueError): require_private_context('unused','teetime-startup-123-1',env)
            gh.assert_not_called()
    def test_closed_startup_labels_and_hash_environment(self):
        settings=startup_settings('teetime-startup-123-1')
        self.assertIn('teetime.startup-fixture=teetime-startup-123-1',settings)
        self.assertIn('TEE_TIME_STARTUP_BINARY_HASH='+BINARY_HASH,settings)
        self.assertNotIn('teetime.reviewer-case=positive',settings)
        for owner in ['other','']:
            with self.assertRaises(ValueError): startup_settings(owner)

    def test_source_binary_catalog_provenance_must_match_controller(self):
        value={'binaryHash':BINARY_HASH,'catalogHash':CATALOG_HASH}
        verify_startup_identity(value)
        for patch in [{'binaryHash':'c'*64},{'catalogHash':'c'*64}]:
            with self.assertRaises(ValueError): verify_startup_identity({**value,**patch})

    def test_startup_cleanup_uses_startup_ownership_and_removes_only_exact_id(self):
        calls=[]
        identifier='a'*64
        name='teetime-sandbox-probe-'+'a'*12
        def docker(*parts):
            calls.append(parts)
            if parts[0]=='inspect':
                return SimpleNamespace(returncode=0,stdout=json.dumps([{'Id':identifier,'Name':'/'+name,
                    'Config':{'Labels':{'teetime.startup-fixture':'teetime-startup-123-1'}}}]))
            return SimpleNamespace(returncode=0,stdout=identifier if len(calls)==1 else '')
        remove_owned_reviewer(docker,name,'teetime-startup-123-1',startup=True)
        self.assertIn(('rm','-f',identifier),calls)



class StartupControllerTests(unittest.TestCase):
    def control(self, clock=None, runner=None, emitter=None):
        self.now=[0.0]; self.events=[]
        return StartupController('teetime-startup-123-1','teetime-sandbox-probe-'+'a'*12,
            clock=clock or (lambda:self.now[0]), emitter=emitter or self.events.append,
            runner=runner or (lambda *args,**kwargs:(0,b'ready')))

    def test_closed_milestone_precedes_blocking_command_and_reports_actual_exit_only(self):
        def run(*args,**kwargs):
            self.assertEqual(self.events[-1]['phase'],'image-inspect')
            self.assertEqual(self.events[-1]['edge'],'start')
            self.assertEqual(kwargs['limit'],131072)
            self.assertLessEqual(kwargs['timeout'],115)
            return 7,b'PRIVATE-OUTPUT'
        controller=self.control(runner=run)
        result=controller.docker('docker','image','inspect','private-image')
        self.assertEqual(result.returncode,7)
        self.assertEqual(result.stdout,'PRIVATE-OUTPUT')
        self.assertEqual(self.events[-1]['exitCode'],7)
        self.assertNotIn('PRIVATE',json.dumps(self.events))
        self.assertNotIn('private-image',json.dumps(self.events))

    def test_one_main_deadline_and_cleanup_window_do_not_restart_per_command(self):
        controller=self.control();self.now[0]=118
        with self.assertRaises(TimeoutError):controller.docker('docker','inspect','ignored')
        controller.enter_cleanup();self.assertLessEqual(controller.remaining(120),27)
        self.now[0]=149
        with self.assertRaises(TimeoutError):controller.docker('docker','container','ls')
        early=self.control();self.now[0]=10;early.enter_cleanup();self.now[0]=39
        with self.assertRaises(TimeoutError):early.docker('docker','container','ls')

    def test_timeout_overflow_and_unknown_exit_remain_uncertain_not_synthetic_status(self):
        for failure in [TimeoutError('PRIVATE'),ValueError('PRIVATE'),OSError('PRIVATE')]:
            def run(*args,**kwargs):raise failure
            controller=self.control(runner=run)
            with self.assertRaises(RuntimeError):controller.docker('docker','create','private')
            last=self.events[-1]
            self.assertEqual(last['edge'],'failure')
            self.assertIsNone(last['exitCode'])
            self.assertNotIn('PRIVATE',json.dumps(self.events))

    def test_attach_keeps_original_native_output_and_duration_caps(self):
        observed=[]
        def run(*args,**kwargs):observed.append(kwargs);return 0,b'PRIVATE-PACKET'
        controller=self.control(runner=run)
        result=controller.attach(['docker','attach','fixed'],b'source')
        self.assertEqual(result,(0,b'PRIVATE-PACKET'))
        self.assertEqual(observed[0]['limit'],65536)
        self.assertLessEqual(observed[0]['timeout'],90)
        self.assertNotIn('PRIVATE',json.dumps(self.events))

    def test_unknown_operation_rejected_before_spawn_and_logging_failure_cannot_block_cleanup(self):
        calls=[]
        controller=self.control(runner=lambda *args,**kwargs:(calls.append(args) or (0,b'')))
        with self.assertRaises(ValueError):controller.docker('docker','exec','PRIVATE')
        self.assertEqual(calls,[])
        def fail(_event):raise OSError('PRIVATE')
        controller=self.control(emitter=fail,runner=lambda *args,**kwargs:(calls.append(args) or (0,b'')))
        with self.assertRaises(RuntimeError):controller.docker('docker','create','private')
        self.assertEqual(calls,[])
        controller.enter_cleanup();controller.docker('docker','container','ls')
        self.assertEqual(len(calls),1)

    def test_milestone_and_counter_bounds_are_independent_and_missing_is_null(self):
        controller=self.control()
        with patch('teetime_startup_control.resource_snapshot',return_value={
            'memoryAvailableBytes':None,'diskFreeBytes':None,'visibleControllerCgroupOomKills':None}):
            controller.resources('before')
        self.assertEqual(self.events[-1]['resources'],{
            'memoryAvailableBytes':None,'diskFreeBytes':None,'visibleControllerCgroupOomKills':None})
        for _ in range(70):
            try:controller.docker('docker','inspect','private')
            except RuntimeError:pass
        self.assertLessEqual(len(self.events),64)
        controller.enter_cleanup()
        controller.docker('docker','container','ls')


class StartupControllerIntegrationTests(unittest.TestCase):
    def test_outer_cleanup_protects_first_docker_failure_and_does_not_claim_absence(self):
        from unittest.mock import Mock
        spec=importlib.util.spec_from_file_location('teetime_startup_outer_cleanup_test',Path(__file__).with_name('run-codex-sandbox-probe.py'))
        runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        controller=Mock()
        controller.docker.side_effect=RuntimeError('first Docker outcome unknown')
        argv=['probe','--kind','startup','--image','fixed-image','--expected-sha','a'*40,
              '--startup-owner','teetime-startup-123-1','--startup-root','unused',
              '--apparmor-profile','teetime-probe-mount-123-1']
        with patch('sys.argv',argv),patch.object(runner,'require_private_context'), \
             patch.object(runner,'StartupController',return_value=controller,create=True), \
             patch.object(runner.subprocess,'run',side_effect=RuntimeError('first Docker outcome unknown')), \
             patch.object(runner,'remove_owned_reviewer',side_effect=RuntimeError('cleanup unverified')) as cleanup:
            with self.assertRaisesRegex(RuntimeError,'cleanup unverified'):runner.main()
        cleanup.assert_called_once()
        controller.enter_cleanup.assert_called_once()
        controller.finish_cleanup.assert_called_once_with(False)
        controller.resources.assert_any_call('after')


class StartupControllerProcessTests(unittest.TestCase):
    def test_real_synthetic_block_and_overflow_are_reaped_and_never_publish_child_data(self):
        import subprocess,sys,time
        from teetime_bounded_process import capture
        for source,limit in [('import time;time.sleep(20)',4096),('print("PRIVATE"*1000)',64)]:
            events=[];children=[];real_popen=subprocess.Popen
            def spawn(*args,**kwargs):
                child=real_popen(*args,**kwargs);children.append(child);return child
            controller=StartupController('teetime-startup-123-1','teetime-sandbox-probe-'+'a'*12,
                emitter=events.append)
            with patch('teetime_bounded_process.subprocess.Popen',side_effect=spawn):
                with self.assertRaises(RuntimeError):
                    controller.command([sys.executable,'-c',source],'attach',.2,limit)
            self.assertEqual(events[0]['edge'],'start')
            self.assertEqual(events[-1]['edge'],'failure')
            self.assertIsNone(events[-1]['exitCode'])
            self.assertNotIn('PRIVATE',json.dumps(events))
            self.assertTrue(children and all(child.poll() is not None for child in children))

    def test_terminated_synthetic_controller_has_start_receipt_and_no_false_cleanup_success(self):
        import subprocess,sys
        from teetime_bounded_process import capture
        parent=[];real_popen=subprocess.Popen
        def spawn(*args,**kwargs):
            child=real_popen(*args,**kwargs);parent.append(child);return child
        source=("import sys,time;sys.path.insert(0,sys.argv[1]);"
                "from teetime_startup_control import StartupController;"
                "c=StartupController('teetime-startup-123-1','teetime-sandbox-probe-aaaaaaaaaaaa',runner=lambda *a,**k:time.sleep(20));"
                "c.docker('docker','create','synthetic')")
        def observed(chunk):
            if b'"edge":"start"' in chunk:parent[0].kill()
        with patch('teetime_bounded_process.subprocess.Popen',side_effect=spawn):
            code,raw=capture([sys.executable,'-u','-c',source,str(Path(__file__).parent)],5,
                             limit=4096,on_stdout=observed)
        self.assertNotEqual(code,0)
        records=[json.loads(line) for line in raw.splitlines()]
        self.assertEqual(len(records),1)
        self.assertEqual(records[0]['phase'],'container-create')
        self.assertEqual(records[0]['edge'],'start')
        self.assertIsNone(records[0]['exitCode'])
        self.assertTrue(all(child.poll() is not None for child in parent))

    def test_resource_reads_are_byte_bounded_nullable_and_not_worker_oom_claims(self):
        reads=[]
        class Source(io.BytesIO):
            def read(self,size=-1):reads.append(size);return super().read(size)
        def opened(path,*args,**kwargs):
            return Source(b'MemAvailable: 17 kB\n' if path=='/proc/meminfo' else b'oom_kill 3\n')
        with patch('builtins.open',side_effect=opened),patch('teetime_startup_control.os.statvfs',
                return_value=SimpleNamespace(f_bavail=10,f_frsize=4096),create=True):
            from teetime_startup_control import resource_snapshot
            self.assertEqual(resource_snapshot(),{'memoryAvailableBytes':17408,'diskFreeBytes':40960,
                             'visibleControllerCgroupOomKills':3})
        self.assertEqual(reads,[65537,4097])
        with patch('builtins.open',side_effect=OSError('PRIVATE')),patch('teetime_startup_control.os.statvfs',
                side_effect=OSError('PRIVATE'),create=True):
            self.assertTrue(all(value is None for value in resource_snapshot().values()))


class StartupControllerIdentityTests(unittest.TestCase):
    def test_public_owned_identity_is_bounded_before_observation(self):
        for owner in ['teetime-startup-'+'1'*100+'-1','teetime-startup-1-'+'1'*100]:
            with self.assertRaises(ValueError):StartupController(owner,'teetime-sandbox-probe-aaaaaaaaaaaa')


class StartupUncertainCreationTests(unittest.TestCase):
    def test_uncertain_creation_reconciles_owned_id_before_removal(self):
        from unittest.mock import Mock
        spec=importlib.util.spec_from_file_location('teetime_startup_creation_test',Path(__file__).with_name('run-codex-sandbox-probe.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        state={'created':False,'removed':False};calls=[];identifier='b'*64
        controller=Mock()
        def factory(owner,name):state.update(owner=owner,name=name);return controller
        def docker(_binary,*parts,**kwargs):
            calls.append(parts)
            if parts[:2]==('image','inspect'):out='sha256:'+'a'*64
            elif parts[0]=='create':
                state['created']=True;raise RuntimeError('creation outcome unknown')
            elif parts[:2]==('container','ls'):out=identifier if state['created'] and not state['removed'] else ''
            elif parts[0]=='inspect':out=json.dumps([{'Id':identifier,'Name':'/'+state['name'],
                'Config':{'Labels':{'teetime.startup-fixture':state['owner']}}}])
            elif parts[0]=='rm':
                self.assertEqual(parts,('rm','-f',identifier));state['removed']=True;out=''
            else:raise AssertionError('unexpected operation')
            return SimpleNamespace(returncode=0,stdout=out)
        controller.docker.side_effect=docker
        argv=['probe','--kind','startup','--image','fixed-image','--expected-sha','a'*40,
              '--startup-owner','teetime-startup-123-1','--startup-root','unused',
              '--apparmor-profile','teetime-probe-mount-123-1']
        with patch('sys.argv',argv),patch.object(module,'require_private_context'), \
             patch.object(module,'StartupController',side_effect=factory):
            with self.assertRaisesRegex(RuntimeError,'creation outcome unknown'):module.main()
        self.assertTrue(state['removed'])
        controller.finish_cleanup.assert_called_once_with(True)
        self.assertFalse(any(parts[0]=='start' for parts in calls))

class StartupHeadroomTests(unittest.TestCase):
    def cgroup(self,changes=None):
        root='/sys/fs/cgroup'
        values={
            '/proc/self/mountinfo':'22 1 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
            '/proc/self/cgroup':'0::/jobs/task\n',
            root+'/cgroup.controllers':'cpu memory pids\n',
            root+'/jobs/memory.max':str(4*1024**3),
            root+'/jobs/memory.current':str(2*1024**3),
            root+'/jobs/task/memory.max':'max\n',
            root+'/jobs/task/memory.current':str(1024**3)}
        values.update(changes or {})
        def read(path,limit):
            value=values.get(str(path).replace('\\','/'))
            if isinstance(value,Exception):raise value
            if value is None:raise FileNotFoundError('PRIVATE')
            if len(value.encode('ascii'))>limit:raise ValueError('PRIVATE')
            return value
        return read

    def test_cgroup_ancestor_limit_is_accounted_even_when_leaf_is_unlimited(self):
        import teetime_startup_control as control
        with patch.object(control,'_cgroup_text',side_effect=self.cgroup(),create=True), \
             patch.object(Path,'is_symlink',return_value=False):
            self.assertEqual(control.effective_cgroup_headroom(),2*1024**3)

    def test_cgroup_unknown_or_hidden_ancestry_is_never_unlimited(self):
        import teetime_startup_control as control
        for changes in [
                {'/proc/self/cgroup':'0::/../outside'},
                {'/proc/self/cgroup':'1:memory:/jobs'},
                {'/proc/self/mountinfo':'22 1 0:1 /hidden /sys/fs/cgroup rw - cgroup2 cgroup rw'},
                {'/sys/fs/cgroup/memory.max':'max'},
                {'/sys/fs/cgroup/cgroup.controllers':'cpu'},
                {'/sys/fs/cgroup/jobs/memory.current':None},
                {'/sys/fs/cgroup/jobs/memory.current':'-1'},
                {'/sys/fs/cgroup/jobs/memory.current':OSError('PRIVATE')},
                {'/sys/fs/cgroup/jobs/memory.max':'true'},
                {'/sys/fs/cgroup/jobs/memory.max':'max\n\n'},
                {'/sys/fs/cgroup/jobs/memory.current':'1\n2'},
                {'/sys/fs/cgroup/jobs/memory.max':'9'*100},
                {'/proc/self/mountinfo':self.cgroup()('/proc/self/mountinfo',262144)*2},
                {'/proc/self/cgroup':'0::/'+'/'.join(['a']*33)}]:
            with self.subTest(changes=changes), \
                 patch.object(control,'_cgroup_text',side_effect=self.cgroup(changes),create=True), \
                 patch.object(Path,'is_symlink',return_value=False):
                self.assertIsNone(control.effective_cgroup_headroom())

    def test_cgroup_over_limit_is_zero_and_symlink_is_unknown(self):
        import teetime_startup_control as control
        with patch.object(control,'_cgroup_text',side_effect=self.cgroup({
                '/sys/fs/cgroup/jobs/memory.current':str(5*1024**3)}),create=True), \
             patch.object(Path,'is_symlink',return_value=False):
            self.assertEqual(control.effective_cgroup_headroom(),0)
        with patch.object(control,'_cgroup_text',side_effect=self.cgroup(),create=True), \
             patch.object(Path,'is_symlink',return_value=True):
            self.assertIsNone(control.effective_cgroup_headroom())

    def test_verified_root_exemption_is_known_and_identity_change_is_unknown(self):
        import teetime_startup_control as control
        read=self.cgroup({'/proc/self/cgroup':'0::/\n'})
        with patch.object(control,'_cgroup_text',side_effect=read,create=True), \
             patch.object(Path,'is_symlink',return_value=False):
            self.assertEqual(control.effective_cgroup_headroom(),9007199254740991)
        for changing in ['/proc/self/cgroup','/proc/self/mountinfo']:
            seen={}
            def changed(path,limit):
                key=str(path);seen[key]=seen.get(key,0)+1
                value=read(path,limit)
                return value+'\n' if key==changing and seen[key]>1 else value
            with self.subTest(changing=changing), \
                 patch.object(control,'_cgroup_text',side_effect=changed,create=True), \
                 patch.object(Path,'is_symlink',return_value=False):
                self.assertIsNone(control.effective_cgroup_headroom())

    def test_cgroup_file_reader_enforces_byte_and_ascii_bounds(self):
        import teetime_startup_control as control
        for raw in [b'x'*129,b'\xff']:
            stream=io.BytesIO(raw)
            with patch('builtins.open',return_value=stream):
                with self.assertRaises((ValueError,UnicodeError)):
                    control._cgroup_text('unused',128)

    def test_known_host_and_effective_cgroup_headroom_are_both_required(self):
        import teetime_startup_control as control
        minimum=1536*1024*1024
        disk_minimum=2*1024*1024*1024
        for memory,cgroup,disk,accepted in [
                (minimum,minimum,disk_minimum,True),
                (177405952,minimum*2,disk_minimum,False),
                (minimum*2,minimum-1,disk_minimum,False),
                (minimum,minimum,disk_minimum-1,False),
                (None,minimum,disk_minimum,False),
                (minimum,None,disk_minimum,False),
                (minimum,minimum,None,False),
                (True,minimum,disk_minimum,False)]:
            with self.subTest(memory=memory,cgroup=cgroup,disk=disk), \
                 patch.object(control,'resource_snapshot',return_value={
                     'memoryAvailableBytes':memory,'diskFreeBytes':disk,
                     'visibleControllerCgroupOomKills':None}), \
                 patch.object(control,'effective_cgroup_headroom',return_value=cgroup,create=True):
                if accepted:control.require_startup_headroom()
                else:
                    with self.assertRaisesRegex(RuntimeError,'startup resource headroom unavailable'):
                        control.require_startup_headroom()

    def test_failed_headroom_emits_failure_without_spawning_or_private_details(self):
        import teetime_startup_control as control
        events=[];calls=[]
        controller=StartupController('teetime-startup-123-1','teetime-sandbox-probe-'+'a'*12,
            emitter=events.append,runner=lambda *args,**kwargs:(calls.append(args) or (0,b'')))
        with patch.object(control,'require_startup_headroom',side_effect=RuntimeError('PRIVATE'),create=True):
            with self.assertRaisesRegex(RuntimeError,'startup resource headroom unavailable'):
                controller.require_headroom()
        self.assertEqual([(event['phase'],event['edge']) for event in events],
                         [('resource-gate','start'),('resource-gate','failure')])
        self.assertEqual(calls,[])
        self.assertNotIn('PRIVATE',json.dumps(events))

    def test_headroom_logging_failure_also_blocks_forward_work(self):
        import teetime_startup_control as control
        for fail_at in [1,2]:
            events=[]
            def emitter(event):
                events.append(event)
                if len(events)==fail_at:raise OSError('PRIVATE')
            controller=StartupController('teetime-startup-123-1','teetime-sandbox-probe-'+'a'*12,
                                         emitter=emitter)
            with patch.object(control,'require_startup_headroom') as check:
                with self.assertRaisesRegex(RuntimeError,'startup resource headroom unavailable'):
                    controller.require_headroom()
                self.assertEqual(check.call_count,0 if fail_at==1 else 1)

    def test_second_gate_failure_prevents_create_start_and_attach_but_allows_cleanup(self):
        from unittest.mock import Mock
        spec=importlib.util.spec_from_file_location('teetime_headroom_integration',Path(__file__).with_name('run-codex-sandbox-probe.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        controller=Mock();calls=[]
        controller.require_headroom.side_effect=[None,RuntimeError('startup resource headroom unavailable')]
        def docker(_binary,*parts,**kwargs):
            calls.append(parts)
            if parts[:2]==('image','inspect'):out='sha256:'+'a'*64
            elif parts[:2]==('container','ls'):out=''
            else:raise AssertionError('unexpected forward operation')
            return SimpleNamespace(returncode=0,stdout=out)
        controller.docker.side_effect=docker
        argv=['probe','--kind','startup','--image','fixed-image','--expected-sha','a'*40,
              '--startup-owner','teetime-startup-123-1','--startup-root','unused',
              '--apparmor-profile','teetime-probe-mount-123-1']
        with patch('sys.argv',argv),patch.object(module,'require_private_context'), \
             patch.object(module,'StartupController',return_value=controller):
            with self.assertRaisesRegex(RuntimeError,'startup resource headroom unavailable'):module.main()
        self.assertEqual(controller.require_headroom.call_count,2)
        self.assertFalse(any(parts[0] in {'create','start'} for parts in calls))
        controller.attach.assert_not_called()
        controller.enter_cleanup.assert_called_once()
        controller.finish_cleanup.assert_called_once_with(True)


if __name__=='__main__': unittest.main()
