"""Controller custody tests; no Docker, network, account or application execution."""
import base64
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('framework', Path(__file__).with_name('qualify-teetime-framework.py'))
framework = importlib.util.module_from_spec(spec)
spec.loader.exec_module(framework)


class FrameworkCustodyTests(unittest.TestCase):
    def test_mounts_accept_only_expected_volume_and_optional_tmpfs_records(self):
        volume = {'Type': 'volume', 'Name': 'owned', 'Source': '/owned', 'Destination': '/workspace', 'RW': False}
        allowed = {'/tmp': 'uid=1001,size=512m'}
        framework.validate_mounts([volume], 'owned', '/owned', True, allowed)
        framework.validate_mounts([volume, {'Type': 'tmpfs', 'Destination': '/tmp'}], 'owned', '/owned', True, allowed)
        for extra in [[{'Type': 'bind', 'Destination': '/host'}],
                      [{'Type': 'tmpfs', 'Destination': '/other'}],
                      [{'Type': 'tmpfs', 'Destination': '/tmp'}] * 2]:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                framework.validate_mounts([volume, *extra], 'owned', '/owned', True, allowed)

    def test_volume_requires_plain_local_owned_storage(self):
        name = 'test-volume'
        valid = {'Name': name, 'Driver': 'local', 'Scope': 'local', 'Options': None,
                 'Labels': {'bdc.teetime.owner': framework.OWNER},
                 'Mountpoint': '/var/lib/docker/volumes/test-volume/_data'}
        framework.validate_volume(valid, name)
        for delta in [{'Driver': 'other'}, {'Options': {'device': '/host'}},
                      {'Labels': {}}, {'Name': 'foreign'}, {'Mountpoint': '/host'}]:
            with self.subTest(delta=delta), self.assertRaises(ValueError):
                framework.validate_volume({**valid, **delta}, name)

    def test_writer_inventory_binds_all_source_and_generated_bytes(self):
        def record(data):
            return {'base64': base64.b64encode(data).decode(), 'bytes': len(data),
                    'sha256': hashlib.sha256(data).hexdigest()}
        files = {name: record(name.encode()) for name in framework.FIXED_NAMES}
        output = {'passed': True, 'files': dict(files)}
        hashes, generated = framework.accept_writer_output({'files': files}, output)
        self.assertEqual(hashes, {name: item['sha256'] for name, item in files.items()})
        self.assertEqual(generated, [])
        for name in ['app/page.tsx', 'bun.lock', 'walkthrough/environment.spec.ts']:
            changed = {**output, 'files': {**files, name: record(b'changed')}}
            with self.subTest(name=name), self.assertRaises(ValueError):
                framework.accept_writer_output({'files': files}, changed)
        changed = {**output, 'files': {**files, 'next-env.d.ts': record(b'generated')}}
        hashes, generated = framework.accept_writer_output({'files': files}, changed)
        self.assertEqual(generated, ['next-env.d.ts'])
        self.assertEqual(hashes['next-env.d.ts'], hashlib.sha256(b'generated').hexdigest())
        corrupt = {**output, 'files': {**files, 'app/page.tsx': {**files['app/page.tsx'], 'base64': '!!!!'}}}
        with self.assertRaises(ValueError):
            framework.accept_writer_output({'files': files}, corrupt)

    def test_verifier_program_binds_accepted_inventory(self):
        hashes = {name: 'a' * 64 for name in framework.FIXED_NAMES}
        source = framework.bound_verifier(hashes)
        self.assertIn('writer and verifier source differ', source)
        self.assertNotIn('EXPECTED_HASHES_TO_FREEZE', source)
        with self.assertRaises(ValueError):
            framework.bound_verifier({**hashes, 'unexpected': 'b' * 64})


if __name__ == '__main__':
    unittest.main()
