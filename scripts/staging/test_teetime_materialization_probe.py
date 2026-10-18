"""Pure resource-boundary fixtures; real daemon lifecycle is a separate gate."""
import copy
import time
import unittest

from probe_teetime_materialization import validate_manifest, validate_resources, require_state


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.now = time.time()
        self.manifest = {'owner': 'teetime-materialize-'+'a'*12, 'image': 'sha256:'+'b'*64,
            'source': 'c'*40, 'controllerPid': 123, 'controllerCreated': 'windows:123',
            'deadline': self.now+45}
        owner = self.manifest['owner']
        self.volume = {'Name': owner+'-data', 'Driver': 'local', 'Scope': 'local',
                       'Options': None, 'Labels': {'teetime.owner': owner}, 'Mountpoint': '/volume/owned'}
        self.command = ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'python3', '-I', 'fixed.py']
        self.info = {'Id': 'd'*64, 'Name': '/'+owner+'-test', 'Image': self.manifest['image'],
            'Config': {'User': '1001:1001', 'Labels': {'teetime.owner': owner},
                       'Entrypoint': ['/usr/bin/env'], 'Cmd': self.command, 'WorkingDir': '/tmp',
                       'Healthcheck': {'Test': ['NONE']}, 'OpenStdin': True, 'StdinOnce': True,
                       'AttachStdin': True},
            'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False, 'NetworkMode': 'none',
                'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'],
                'Memory': 512*1024**2, 'MemorySwap': 512*1024**2, 'NanoCpus': 1000000000,
                'PidsLimit': 128, 'LogConfig': {'Type': 'none'}, 'IpcMode': 'none',
                'Tmpfs': {'/tmp': 'rw,uid=1001,gid=1001,size=64m'},
                'Mounts': [{'Type': 'volume', 'Source': owner+'-data', 'Target': '/candidate',
                            'ReadOnly': True, 'VolumeOptions': {'NoCopy': True}}]},
            'Mounts': [{'Type': 'volume', 'Name': owner+'-data', 'Destination': '/candidate',
                        'RW': False, 'Driver': 'local', 'Propagation': '', 'Source': '/volume/owned'}],
            'State': {'Paused': False, 'OOMKilled': False, 'Error': '', 'Status': 'created',
                      'Running': False, 'Dead': False, 'ExitCode': 0}}

    def check(self):
        validate_resources(self.info, self.volume, [self.info['Id']], self.manifest, 'test', self.command)

    def test_valid_exact_owned_readonly_resource(self):
        self.assertEqual(validate_manifest(self.manifest, self.now), self.manifest)
        self.check()

    def test_foreign_manifest_names_deadlines_and_process_identity(self):
        for key, value in [('owner', 'arbitrary'), ('image', 'mutable:tag'), ('source', 'branch'),
                           ('controllerPid', True), ('controllerCreated', 'unknown'),
                           ('deadline', self.now-1), ('deadline', float('nan')), ('extra', 1)]:
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    validate_manifest({**self.manifest, key: value}, self.now)

    def test_readwrite_or_foreign_mount_rejected(self):
        for changed in [{'RW': True}, {'Name': 'foreign'}, {'Type': 'bind'}, {'Destination': '/elsewhere'}]:
            original = copy.deepcopy(self.info)
            self.info['Mounts'][0].update(changed)
            with self.assertRaises(ValueError):
                self.check()
            self.info = original

    def test_remaining_writer_or_foreign_volume_rejected(self):
        with self.assertRaises(ValueError):
            validate_resources(self.info, self.volume, [self.info['Id'], 'writer-id'], self.manifest,
                               'test', self.command)
        for key, value in [('Driver', 'remote'), ('Options', {'device': '/host'}),
                           ('Labels', {}), ('Name', 'other')]:
            with self.assertRaises(ValueError):
                validate_resources(self.info, {**self.volume, key: value}, [self.info['Id']],
                                   self.manifest, 'test', self.command)

    def test_unsafe_runtime_controls_and_command_rejected(self):
        for key, value in [('Privileged', True), ('NetworkMode', 'bridge'), ('ReadonlyRootfs', False),
                           ('Binds', ['/host:/candidate']), ('PidMode', 'host'), ('PidsLimit', 0),
                           ('SecurityOpt', []), ('CapAdd', ['SYS_ADMIN'])]:
            original = copy.deepcopy(self.info)
            self.info['HostConfig'][key] = value
            with self.assertRaises(ValueError):
                self.check()
            self.info = original
        self.info['Config']['Cmd'] = self.command+['unexpected']
        with self.assertRaises(ValueError):
            self.check()

    def test_test_mount_cannot_copy_up_or_declare_subpaths(self):
        for options in [{}, {'NoCopy': False}, {'NoCopy': True, 'Subpath': 'hidden'}]:
            self.info['HostConfig']['Mounts'][0]['VolumeOptions'] = options
            with self.assertRaises(ValueError):
                self.check()

    def test_resolved_mount_source_must_match_actual_volume(self):
        self.info['Mounts'][0]['Source'] = '/volume/foreign'
        with self.assertRaises(ValueError):
            self.check()

    def test_lifecycle_requires_created_then_running_then_expected_exit(self):
        require_state(self.info, 'created')
        with self.assertRaises(ValueError):
            require_state(self.info, 'running')
        self.info['State'].update({'Status': 'running', 'Running': True})
        require_state(self.info, 'running')
        with self.assertRaises(ValueError):
            require_state(self.info, 'created')
        self.info['State'].update({'Status': 'exited', 'Running': False})
        require_state(self.info, 'exited', expected_exit=0)
        with self.assertRaises(ValueError):
            require_state(self.info, 'running')
        self.info['State']['ExitCode'] = 17
        with self.assertRaises(ValueError):
            require_state(self.info, 'exited', expected_exit=0)
        require_state(self.info, 'exited', expected_exit=17)


if __name__ == '__main__':
    unittest.main()
