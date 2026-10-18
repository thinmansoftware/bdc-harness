"""Linux-only export tests; no credentials, model or network."""
import io
import os
from pathlib import Path
import tempfile
import unittest
import copy

from teetime_snapshot import read_snapshot
from teetime_snapshot_exporter import export_snapshot, decode_frame
from probe_teetime_snapshot_capture import (command_for, validate_resources, validate_manifest,
                                           guard_controller, validate_controller_identity)


class SnapshotExporterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ['.codex', '.agents']:
            (self.root/name).mkdir()

    def test_linux_descriptor_operations_are_required(self):
        self.assertEqual(os.name, 'posix', 'run this required suite in the Linux qualification image')
        self.assertIn(os.open, os.supports_dir_fd)

    def test_captures_added_ignored_binary_executable_files(self):
        (self.root/'.gitignore').write_bytes(b'ignored.tmp\n')
        (self.root/'ignored.tmp').write_bytes(b'\x00\xff')
        (self.root/'src').mkdir()
        (self.root/'src/new.sh').write_bytes(b'exit 0\n')
        (self.root/'src/new.sh').chmod(0o755)
        scope = ('.gitignore', 'ignored.tmp', 'src/new.sh')
        raw = export_snapshot(self.root, scope)
        inventory, archive = decode_frame(raw, scope)
        files = read_snapshot(archive, inventory)
        self.assertEqual(inventory, tuple(sorted(scope)))
        self.assertEqual(files[1].content, b'\x00\xff')
        self.assertEqual(files[2].git_mode, '100755')
        self.assertEqual(raw, export_snapshot(self.root, scope))

    def test_empty_candidate_is_valid_but_required_masks_are_not_optional(self):
        raw = export_snapshot(self.root, ())
        inventory, archive = decode_frame(raw, ())
        self.assertEqual(read_snapshot(archive, inventory), ())
        (self.root/'.codex').rmdir()
        with self.assertRaises(ValueError):
            export_snapshot(self.root, ())

    def test_rejects_hidden_metadata_contents_and_links(self):
        for mask in ['.codex', '.agents']:
            path = self.root/mask/'hidden'
            path.write_bytes(b'hidden')
            with self.subTest(mask=mask), self.assertRaises(ValueError):
                export_snapshot(self.root, ())
            path.unlink()
        (self.root/'.codex').rmdir()
        (self.root/'.codex').symlink_to(self.root/'.agents', target_is_directory=True)
        with self.assertRaises((ValueError, OSError)):
            export_snapshot(self.root, ())

    def test_rejects_symlink_hardlink_fifo_and_unapproved_file(self):
        path = self.root/'bad'
        path.symlink_to('/etc/passwd')
        with self.assertRaises((ValueError, OSError)):
            export_snapshot(self.root, ('bad',))
        path.unlink()
        (self.root/'first').write_bytes(b'hardlink')
        os.link(self.root/'first', path)
        with self.assertRaises(ValueError):
            export_snapshot(self.root, ('first', 'bad'))
        path.unlink()
        (self.root/'first').unlink()
        os.mkfifo(path)
        with self.assertRaises(ValueError):
            export_snapshot(self.root, ('bad',))
        path.unlink()
        path.write_bytes(b'not approved')
        with self.assertRaises(ValueError):
            export_snapshot(self.root, ())

    def test_rejects_credential_paths_and_case_collisions(self):
        for name in ['.env', 'CON', '.git']:
            path = self.root/name
            path.write_bytes(b'x')
            with self.subTest(name=name), self.assertRaises(ValueError):
                export_snapshot(self.root, (name,))
            path.unlink()
        (self.root/'A').write_bytes(b'a')
        (self.root/'a').write_bytes(b'b')
        with self.assertRaises(ValueError):
            export_snapshot(self.root, ('A', 'a'))

    def test_rejects_file_bounds(self):
        path = self.root/'large'
        path.write_bytes(b'x'*(1024*1024+1))
        with self.assertRaises(ValueError):
            export_snapshot(self.root, ('large',))

    def test_frame_rejects_truncation_trailing_data_scope_and_damage(self):
        (self.root/'file').write_bytes(b'content')
        raw = export_snapshot(self.root, ('file',))
        for bad in [raw[:10], raw[:-1], raw+b'x', b'X'+raw[1:]]:
            with self.subTest(length=len(bad)), self.assertRaises(ValueError):
                decode_frame(bad, ('file',))
        with self.assertRaises(ValueError):
            decode_frame(raw, ())
        corrupted = bytearray(raw)
        corrupted[-1024] = 1
        with self.assertRaises(ValueError):
            decode_frame(bytes(corrupted), ('file',))


class CaptureBoundaryTests(unittest.TestCase):
    def fixture(self):
        manifest = {'owner': 'teetime-capture-'+'a'*12, 'image': 'sha256:'+'b'*64,
                    'source': 'c'*40, 'deadline': 45, 'controllerPid': 123,
                    'controllerCreated': 'windows:123456'}
        volume = {'Name': manifest['owner']+'-data', 'Driver': 'local', 'Options': {}, 'Scope': 'local',
                  'Labels': {'teetime.owner': manifest['owner']}, 'Mountpoint': '/owned-volume'}
        infos = []
        for role in ['worker', 'exporter']:
            infos.append({'Id': ('d' if role == 'worker' else 'e')*64, 'Name': '/'+manifest['owner']+'-'+role,
                'Image': manifest['image'], 'State': {'Running': role == 'worker', 'Paused': role == 'worker'},
                'Config': {'Labels': {'teetime.owner': manifest['owner']}, 'User': '1001:1001',
                           'Entrypoint': ['/usr/bin/env'], 'Cmd': command_for(role, 'clean'),
                           'OpenStdin': False, 'Tty': False},
                'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True, 'Privileged': False,
                    'CapDrop': ['ALL'], 'CapAdd': None, 'SecurityOpt': ['no-new-privileges:true'],
                    'Memory': 128*1024**2, 'MemorySwap': 128*1024**2, 'NanoCpus': 1000000000,
                    'PidsLimit': 64, 'LogConfig': {'Type': 'none'}, 'IpcMode': 'none',
                    'Tmpfs': {'/tmp': 'rw,uid=1001,gid=1001,size=8m'}},
                'Mounts': [{'Type': 'volume', 'Name': volume['Name'], 'Source': volume['Mountpoint'],
                            'Destination': '/workspace', 'Driver': 'local', 'RW': role == 'worker'}]})
        return (*infos, volume, [info['Id'] for info in infos], manifest, 'clean', True)

    def test_expected_paused_boundary_passes(self):
        validate_resources(*self.fixture())

    def test_unpaused_identity_mount_and_reference_drift_reject(self):
        mutations = [lambda v: v[0]['State'].update(Paused=False),
                     lambda v: v[0].update(Image='sha256:'+'f'*64),
                     lambda v: v[1]['Mounts'][0].update(RW=True),
                     lambda v: v[0]['Mounts'].append({'Type': 'bind'}),
                     lambda v: v[2].update(Options={'device': '/host'}),
                     lambda v: v[3].append('f'*64),
                     lambda v: v[0]['Config'].update(Cmd=['untrusted']),
                     lambda v: v[1]['HostConfig'].update(NetworkMode='default')]
        for mutate in mutations:
            values = copy.deepcopy(self.fixture())
            mutate(values)
            with self.assertRaises(ValueError):
                validate_resources(*values)

    def test_watchdog_scope_and_deadline_reject(self):
        good = self.fixture()[4]
        self.assertEqual(validate_manifest(good, 0), good)
        for key, value in [('owner', 'other-resource'), ('image', 'latest'), ('deadline', True),
                           ('deadline', 61), ('deadline', float('nan')), ('source', 'branch')]:
            invalid = {**good, key: value}
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate_manifest(invalid, 0)

    def test_delayed_creation_is_rejected_before_docker_call(self):
        class Watchdog:
            def poll(self):
                return None
        guard_controller(Watchdog(), 25, 24)
        for now in [25, 26, 45, 100]:
            with self.subTest(now=now), self.assertRaises(ValueError):
                guard_controller(Watchdog(), 25, now)
        class DeadWatchdog:
            def poll(self):
                return 0
        with self.assertRaises(ValueError):
            guard_controller(DeadWatchdog(), 25, 1)

    def test_reused_pid_creation_identity_mismatch_rejects(self):
        validate_controller_identity('windows:123456', 'windows:123456')
        with self.assertRaises(ValueError):
            validate_controller_identity('windows:123457', 'windows:123456')
        with self.assertRaises(ValueError):
            validate_controller_identity('linux:123456', 'windows:123456')


if __name__ == '__main__':
    unittest.main()
