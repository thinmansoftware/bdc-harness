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
from teetime_startup_control import startup_settings, verify_startup_identity, require_private_repository, require_private_context, BINARY_HASH, CATALOG_HASH
from teetime_reviewer_probe import remove_owned_reviewer
from teetime_startup_packet import startup_metadata


class StartupControlTests(unittest.TestCase):
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


if __name__=='__main__': unittest.main()
