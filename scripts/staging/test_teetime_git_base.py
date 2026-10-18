"""Actual temporary Git objects; never customer repositories or model calls."""
import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from teetime_git_base import read_git_base, encode_result
from teetime_materialization_frame import decode_frame


class BaseReaderTests(unittest.TestCase):
    def setUp(self):
        self.git=str(Path(shutil.which('git')).resolve())
        repository=Path(__file__).resolve().parents[2]
        dependencies=repository/'node_modules'
        self.pool=dependencies/'.cache/teetime-git-base-fixtures'
        for path in [dependencies,self.pool.parent,self.pool]:
            if path!=dependencies:path.mkdir(exist_ok=True)
            if (not path.is_dir() or path.is_symlink() or
                bool(getattr(path.lstat(),'st_file_attributes',0)&0x400) or path.resolve()!=path):
                raise ValueError('fixture pool indirection rejected')
        self.temp=tempfile.TemporaryDirectory(prefix='teetime-git-base-',dir=self.pool)
        self.root=Path(self.temp.name).resolve()
        self.addCleanup(self.cleanup_fixture)
        self.env={key:value for key,value in os.environ.items() if key.upper() in
            ['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP']}
        self.env.update({'HOME':str(self.root),'USERPROFILE':str(self.root),
            'XDG_CONFIG_HOME':str(self.root/'config'),'GIT_CONFIG_NOSYSTEM':'1',
            'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_COUNT':'0','GIT_TERMINAL_PROMPT':'0'})
        subprocess.run([self.git,'-C',str(repository),'check-ignore','--quiet','--',str(self.root)],
            env=self.env,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
        self.hooks=self.root/'hooks';self.hooks.mkdir()
        self.template=self.root/'template';self.template.mkdir()
        self.run_git('init','--initial-branch=staging','--object-format=sha1',
            '--template='+str(self.template),str(self.root))
        self.run_git('config','user.name','Synthetic Test')
        self.run_git('config','user.email','synthetic@example.invalid')
        (self.root/'data.bin').write_bytes(b'\x00\xffbinary')
        (self.root/'README.md').write_bytes(b'Synthetic base\n')
        self.run_git('add','--','data.bin','README.md')
        self.run_git('commit','-m','Synthetic base')
        self.commit=self.run_git('rev-parse','HEAD').decode().strip()

    def cleanup_fixture(self):
        root=self.root
        if (root.parent!=self.pool.resolve() or not root.name.startswith('teetime-git-base-') or
            root.is_symlink() or bool(getattr(root.lstat(),'st_file_attributes',0)&0x400) or root.resolve()!=root):
            raise ValueError('unsafe fixture cleanup')
        # Only the exclusive root created by this test; old failed roots stay retained.
        self.temp.cleanup()

    def run_git(self,*args,input=None):
        return subprocess.run([self.git,'--no-replace-objects','-c','protocol.allow=never',
            '-c','core.hooksPath='+str(self.hooks),'-c','core.attributesFile='+os.devnull,
            '-c','commit.gpgsign=false','-c','tag.gpgsign=false','-c','core.autocrlf=false',
            '-C',str(self.root),*args],input=input,check=True,env=self.env,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10).stdout

    def test_complete_binary_committed_base_ignores_working_changes(self):
        (self.root/'data.bin').write_bytes(b'wrong working bytes')
        (self.root/'untracked.txt').write_bytes(b'ignored')
        result=read_git_base(self.git,str(self.root),self.commit)
        frame=base64.b64decode(result['frameBase64'],validate=True)
        files=decode_frame(frame,expected_manifest_hash=result['manifestHash'],expected_tree=result['sourceTree'])
        self.assertEqual([(f.path,f.content) for f in files],[('README.md',b'Synthetic base\n'),('data.bin',b'\x00\xffbinary')])
        self.assertEqual(result['baseCommit'],self.commit)
        self.assertEqual(result['sourceTree'],self.run_git('rev-parse',self.commit+'^{tree}').decode().strip())
        self.assertEqual(json.loads(encode_result(result)),result)

    def linked_worktree(self):
        path=self.root/'linked-fixture'
        self.run_git('remote','add','origin','https://github.com/'+ 'thinmansoftware/whats-that-tee-time.git')
        self.run_git('worktree','add','-b','demo-fixture',str(path),self.commit)
        self.addCleanup(lambda:self.run_git('worktree','remove',str(path)))
        self.run_git('update-ref','refs/remotes/origin/staging',self.commit)
        return path

    def test_registered_worktree_requires_canonical_origin(self):
        path=self.linked_worktree()
        self.run_git('remote','remove','origin')
        with self.assertRaises(ValueError):self.observe(path)

    def observe(self,path,**kwargs):
        return read_git_base(self.git,str(self.root),self.commit,worktree=str(path),
            run_scope=kwargs.get('run_scope',self.commit),branch='demo-fixture')

    def test_registered_named_head_and_both_staging_refs_observed(self):
        result=self.observe(self.linked_worktree())
        self.assertEqual(result['worktreeObservation'],{
            'state':'registered-head-and-both-bases-observed-stable',
            'headCommit':self.commit,'headBranch':'demo-fixture',
            'localStagingCommit':self.commit,'remoteStagingCommit':self.commit})

    def test_wrong_head_detached_head_and_missing_remote_rejected(self):
        path=self.linked_worktree()
        with self.assertRaises(ValueError):self.observe(path,run_scope='0'*40)
        self.run_git('update-ref','-d','refs/remotes/origin/staging')
        with self.assertRaises(ValueError):self.observe(path)
        self.run_git('update-ref','refs/remotes/origin/staging',self.commit)
        admin=Path((path/'.git').read_text().strip()[8:])
        (admin/'HEAD').write_text(self.commit+'\n',encoding='ascii')
        with self.assertRaises(ValueError):self.observe(path)

    def test_worktree_backlink_and_common_directory_required(self):
        path=self.linked_worktree()
        admin=Path((path/'.git').read_text().strip()[8:])
        for name,changed in [('gitdir',str(self.root/'.git')+'\n'),('commondir','../../../outside\n')]:
            file=admin/name;original=file.read_bytes()
            try:
                file.write_bytes(changed.encode())
                with self.assertRaises(ValueError):self.observe(path)
            finally:file.write_bytes(original)

    def test_ref_movement_during_committed_capture_rejected(self):
        path=self.linked_worktree()
        other=self.run_git('commit-tree',self.run_git('rev-parse',self.commit+'^{tree}').decode().strip(),
            '-p',self.commit,input=b'Synthetic advanced staging\n').decode().strip()
        from teetime_git_base import capture as actual_capture
        moved=False
        def capture_and_move(args,*rest,**kwargs):
            nonlocal moved
            result=actual_capture(args,*rest,**kwargs)
            if not moved and 'cat-file' in args:
                self.run_git('update-ref','refs/remotes/origin/staging',other);moved=True
            return result
        with patch('teetime_git_base.capture',side_effect=capture_and_move),self.assertRaises(ValueError):
            self.observe(path)
        self.assertTrue(moved)

    def test_missing_or_noncommit_or_malformed_identity_rejected(self):
        blob=self.run_git('hash-object','--stdin',input=b'blob').decode().strip()
        for oid in ['0'*40,blob,self.commit.upper(),'HEAD']:
            with self.subTest(oid=oid),self.assertRaises(ValueError):read_git_base(self.git,str(self.root),oid)
        with self.assertRaises(ValueError):read_git_base('git',str(self.root),self.commit)

    def test_unsafe_metadata_indirection_rejected_without_object_read(self):
        paths=['objects/info/alternates','objects/info/http-alternates','info/grafts','shallow','commondir','objects/pack/fixture.promisor']
        for name in paths:
            p=self.root/'.git'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('unsafe')
            with self.subTest(name=name),self.assertRaises(ValueError):read_git_base(self.git,str(self.root),self.commit)
            p.unlink()
        self.run_git('replace',self.commit,self.commit)
        with self.assertRaises(ValueError):read_git_base(self.git,str(self.root),self.commit)

    def test_repository_include_and_partial_clone_config_rejected(self):
        config=self.root/'.git/config';original=config.read_bytes()
        for extra in [b'\n[include]\npath = /outside/config\n',b'\n[remote "origin"]\npromisor = true\n',b'\n[extensions]\npartialClone = origin\n']:
            config.write_bytes(original+extra)
            with self.assertRaises(ValueError):read_git_base(self.git,str(self.root),self.commit)
        config.write_bytes(original)

    def test_unsupported_symlink_tree_rejected(self):
        blob=self.run_git('hash-object','-w','--stdin',input=b'outside').decode().strip()
        self.run_git('update-index','--add','--cacheinfo','120000,'+blob+',link')
        tree=self.run_git('write-tree').decode().strip()
        commit=self.run_git('commit-tree',tree,'-p',self.commit,input=b'Synthetic link\n').decode().strip()
        with self.assertRaises(ValueError):read_git_base(self.git,str(self.root),commit)

    def test_file_output_and_process_bounds_fail_closed(self):
        with patch('teetime_git_base.MAX_FILE',2),self.assertRaises(ValueError):
            read_git_base(self.git,str(self.root),self.commit)

    def test_executable_mode_and_case_colliding_committed_names(self):
        self.run_git('update-index','--chmod=+x','--','data.bin')
        tree=self.run_git('write-tree').decode().strip()
        commit=self.run_git('commit-tree',tree,'-p',self.commit,input=b'Synthetic mode\n').decode().strip()
        result=read_git_base(self.git,str(self.root),commit)
        files=decode_frame(base64.b64decode(result['frameBase64']),expected_manifest_hash=result['manifestHash'],expected_tree=result['sourceTree'])
        self.assertEqual(next(f.git_mode for f in files if f.path=='data.bin'),'100755')
        blob=self.run_git('hash-object','-w','--stdin',input=b'synthetic').decode().strip()
        tree=self.run_git('mktree',input=('100644 blob '+blob+'\tA.md\n100644 blob '+blob+'\ta.md\n').encode()).decode().strip()
        commit=self.run_git('commit-tree',tree,input=b'Synthetic collision\n').decode().strip()
        with self.assertRaises(ValueError):read_git_base(self.git,str(self.root),commit)

    def test_aggregate_and_metadata_count_bounds(self):
        for name in ['data.bin','README.md']:(self.root/name).write_bytes(b'x'*64)
        self.run_git('add','--','data.bin','README.md');self.run_git('commit','-m','Synthetic aggregate')
        commit=self.run_git('rev-parse','HEAD').decode().strip()
        with patch('teetime_git_base.MAX_TOTAL',100),self.assertRaises(ValueError):read_git_base(self.git,str(self.root),commit)
        with patch('teetime_git_base.MAX_METADATA_ENTRIES',0),self.assertRaises(ValueError):read_git_base(self.git,str(self.root),commit)
        result=read_git_base(self.git,str(self.root),self.commit)
        with patch('teetime_git_base.MAX_OUTPUT',2),self.assertRaises(ValueError):encode_result(result)
        with patch('teetime_git_base.capture',side_effect=TimeoutError('synthetic timeout')),self.assertRaises(ValueError):
            read_git_base(self.git,str(self.root),self.commit)


if __name__=='__main__':unittest.main()
