"""Authentic commit objects without treating their IDs as repository heads."""
import dataclasses
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from teetime_git_objects import GitObject, build_git_objects
from teetime_git_commit import CommitIdentity, MAX_MESSAGE_BYTES, MAX_TIMESTAMP, build_candidate_commit
from teetime_snapshot import SnapshotFile


class CommitTests(unittest.TestCase):
    def setUp(self):
        self.files = (SnapshotFile('data.bin', '100644', b'\0\xffbinary'),
                      SnapshotFile('src/run.sh', '100755', b'#!/bin/sh\nexit 0\n'))
        self.identity = CommitIdentity('ThinMan Source Controller', 'build@thinmansoftware.invalid')
        self.args = {'expected_format': 'sha1', 'parent_commit': 'a'*40,
            'identity': self.identity, 'timestamp': 1792324800, 'message': b'Fixed candidate\n'}

    def build(self, **overrides):
        return build_candidate_commit(self.files, **{**self.args, **overrides})

    def test_exact_immutable_payload_and_real_commit_oid(self):
        snapshot, commit = self.build()
        self.assertEqual(snapshot, build_git_objects(self.files, expected_format='sha1'))
        expected = ('tree '+snapshot.root_tree+'\nparent '+'a'*40+'\n'
            'author ThinMan Source Controller <build@thinmansoftware.invalid> 1792324800 +0000\n'
            'committer ThinMan Source Controller <build@thinmansoftware.invalid> 1792324800 +0000\n\n').encode()+self.args['message']
        self.assertEqual(commit.payload, expected)
        self.assertEqual(commit.kind, 'commit')
        self.assertEqual(commit.oid, hashlib.sha1(b'commit '+str(len(expected)).encode()+b'\0'+expected).hexdigest())
        self.assertNotEqual(commit.oid, snapshot.root_tree)
        self.assertEqual(self.build(), (snapshot, commit))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            commit.payload = b'changed'
        with self.assertRaises(dataclasses.FrozenInstanceError):
            self.identity.name = 'changed'

    def test_complete_content_parent_metadata_and_message_change_identity(self):
        expected = self.build()[1].oid
        for changed in [{'parent_commit': 'b'*40}, {'timestamp': 1792324801},
            {'message': b'Changed candidate\n'}, {'identity': CommitIdentity('Other', self.identity.email)}]:
            self.assertNotEqual(self.build(**changed)[1].oid, expected)
        changed = build_candidate_commit(self.files+(SnapshotFile('new', '100644', b'new'),), **self.args)
        self.assertNotEqual(changed[1].oid, expected)

    def test_explicit_format_parent_and_nonboolean_timestamp(self):
        for changed in [{'expected_format': 'sha256'}, {'expected_format': None},
            {'parent_commit': 'a'*39}, {'parent_commit': 'A'*40}, {'parent_commit': 'a'*40+'\n'},
            {'parent_commit': ['a'*40]}, {'timestamp': True}, {'timestamp': -1},
            {'timestamp': MAX_TIMESTAMP+1}, {'timestamp': 1.0}]:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                self.build(**changed)
        args = {key: value for key, value in self.args.items() if key != 'expected_format'}
        with self.assertRaises(TypeError):
            build_candidate_commit(self.files, **args)
        self.build(timestamp=0)
        self.build(timestamp=MAX_TIMESTAMP)

    def test_identity_fields_reject_header_injection_controls_and_ambiguity(self):
        for name in ['', ' leading', 'trailing ', 'a\nb', 'a\rb', 'a\tb', 'a<b', 'a>b', '\x7f', 'a'*81]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.build(identity=CommitIdentity(name, self.identity.email))
        for email in ['', ' a@b', 'a@b ', 'a b@c', 'a@b\nparent injected', 'a<b@c', 'a>b@c',
                      'a\x00@b', 'a\x7f@b', 'a'*255, 'not-an-email']:
            with self.subTest(email=email), self.assertRaises(ValueError):
                self.build(identity=CommitIdentity('Name', email))
        for identity in ['Name <a@b>', {'name': 'Name', 'email': 'a@b'}, None]:
            with self.assertRaises(ValueError):
                self.build(identity=identity)

    def test_message_bytes_preserved_exactly_and_bounds_enforced(self):
        message = b'first\n\nlast\n\n'
        self.assertTrue(self.build(message=message)[1].payload.endswith(b'\n\n'+message))
        self.build(message=b'x'*(MAX_MESSAGE_BYTES-1)+b'\n')
        for message in [b'', b'missing newline', b'x\0\n', b'x\r\n', b'\xff\n',
                        b'x'*MAX_MESSAGE_BYTES+b'\n', bytearray(b'x\n'), 'x\n']:
            with self.subTest(message=str(message)[:30]), self.assertRaises(ValueError):
                self.build(message=message)

    def test_commit_included_in_aggregate_object_bounds_and_collision_checks(self):
        snapshot, commit = self.build()
        size = sum(len(item.kind)+1+len(str(len(item.payload)))+1+len(item.payload)
                   for item in (*snapshot.objects, commit))
        with patch('teetime_git_commit.MAX_OBJECT_BYTES', size-1), self.assertRaises(ValueError):
            self.build()
        with patch('teetime_git_commit.MAX_OBJECTS', len(snapshot.objects)), self.assertRaises(ValueError):
            self.build()
        with patch('teetime_git_commit.MAX_OBJECT_BYTES', size):
            self.assertEqual(self.build()[1], commit)
        class Collision:
            def hexdigest(self):
                return snapshot.objects[0].oid
        with patch('teetime_git_commit.build_git_objects', return_value=snapshot), \
            patch('teetime_git_commit.hashlib.sha1', return_value=Collision()), self.assertRaises(ValueError):
            self.build()

    def test_mutable_or_invalid_complete_candidate_rejected(self):
        for files in [list(self.files), (SnapshotFile('../escape', '100644', b'x'),),
                      (SnapshotFile('link', '120000', b'target'),)]:
            with self.assertRaises(ValueError):
                build_candidate_commit(files, **self.args)

    def test_trusted_git_commit_tree_payload_and_oid_match_without_refs(self):
        git = shutil.which('git')
        self.assertIsNotNone(git, 'Git plumbing required; never skip')
        with tempfile.TemporaryDirectory(prefix='teetime-commit-') as temporary:
            root = Path(temporary)
            hooks = root/'hooks';hooks.mkdir()
            template = root/'template';template.mkdir()
            env = {key: value for key, value in os.environ.items() if key.upper() in
                   ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']}
            env.update({'HOME': str(root), 'USERPROFILE': str(root), 'XDG_CONFIG_HOME': str(root/'config'),
                'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0',
                'GIT_AUTHOR_NAME': self.identity.name, 'GIT_AUTHOR_EMAIL': self.identity.email,
                'GIT_COMMITTER_NAME': self.identity.name, 'GIT_COMMITTER_EMAIL': self.identity.email,
                'GIT_AUTHOR_DATE': '@'+str(self.args['timestamp'])+' +0000',
                'GIT_COMMITTER_DATE': '@'+str(self.args['timestamp'])+' +0000'})
            def run(*args, data=None):
                return subprocess.run([git, '--no-replace-objects', '-c', 'protocol.allow=never',
                    '-c', 'core.hooksPath='+str(hooks), '-c', 'core.attributesFile='+os.devnull,
                    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-C', str(root), *args],
                    input=data, env=env, capture_output=True, check=True, timeout=10).stdout
            run('init', '--bare', '--object-format=sha1', '--template='+str(template))
            snapshot = build_git_objects(self.files, expected_format='sha1')
            for item in snapshot.objects:
                self.assertEqual(run('hash-object', '-w', '-t', item.kind, '--stdin', data=item.payload).decode().strip(), item.oid)
            parent = run('commit-tree', snapshot.root_tree, data=b'Trusted test parent\n').decode().strip()
            snapshot, commit = self.build(parent_commit=parent)
            actual = run('commit-tree', snapshot.root_tree, '-p', parent, data=self.args['message']).decode().strip()
            self.assertEqual(actual, commit.oid)
            self.assertEqual(run('cat-file', 'commit', actual), commit.payload)
            self.assertEqual(run('hash-object', '-t', 'commit', '--stdin', data=commit.payload).decode().strip(), actual)
            self.assertEqual(run('for-each-ref'), b'')


if __name__ == '__main__':
    unittest.main()
