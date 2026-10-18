"""Pure complete-candidate transport checks; no model or Docker calls."""
import base64
import hashlib
import json
import unittest

from teetime_git_objects import build_git_objects
from teetime_snapshot import SnapshotFile, snapshot_manifest
from teetime_materialization_frame import MAX_FRAME, decode_frame, encode_frame


def identities(files):
    return {'expected_manifest_hash': hashlib.sha256(snapshot_manifest(files).encode('ascii')).hexdigest(),
            'expected_tree': build_git_objects(files, expected_format='sha1').root_tree}


class FrameTests(unittest.TestCase):
    def setUp(self):
        self.files = (SnapshotFile('bin/run.sh', '100755', b'#!/bin/sh\nexit 0\n'),
                      SnapshotFile('data.bin', '100644', bytes(range(256))))
        self.ids = identities(self.files)
        self.raw = None

    def frame(self):
        return encode_frame(self.files, **self.ids)

    def test_exact_binary_and_executable_round_trip(self):
        raw = self.frame()
        self.assertEqual(decode_frame(raw, **self.ids), self.files)
        self.assertEqual(encode_frame(tuple(reversed(self.files)), **self.ids), raw)
        self.assertTrue(raw.isascii())

    def test_empty_complete_snapshot(self):
        ids = identities(())
        self.assertEqual(decode_frame(encode_frame((), **ids), **ids), ())

    def test_foreign_expected_identity_rejected_at_both_ends(self):
        raw = self.frame()
        for key, value in [('expected_tree', '0'*40), ('expected_manifest_hash', '0'*64),
                           ('expected_tree', None), ('expected_manifest_hash', True)]:
            wrong = {**self.ids, key: value}
            with self.subTest(key=key, value=value):
                with self.assertRaises(ValueError):
                    encode_frame(self.files, **wrong)
                with self.assertRaises(ValueError):
                    decode_frame(raw, **wrong)

    def test_exact_canonical_json_and_duplicate_keys(self):
        raw = self.frame()
        for bad in [raw+b' ', raw+b'{}', b'\xef\xbb\xbf'+raw,
                    raw.replace(b'"version":1', b'"version":1,"version":1'),
                    raw.replace(b'"path":', b'"path":"other","path":', 1), b'{}',
                    b'[]', b'null', b'{"x":NaN}', b'['*10+b']'*10, b'\xff']:
            with self.subTest(bad=bad[:45]):
                with self.assertRaises(ValueError):
                    decode_frame(bad, **self.ids)

    def test_schema_types_base64_and_claimed_identity(self):
        original = json.loads(self.frame())
        changes = [('version', True), ('version', 2), ('files', {}),
                   ('sourceTree', '0'*40), ('manifestHash', '0'*64), ('extra', 1)]
        for key, value in changes:
            frame = {**original, key: value}
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    decode_frame(json.dumps(frame, sort_keys=True, separators=(',', ':')).encode(), **self.ids)
        for key, value in [('contentBase64', 'AA==\n'), ('contentBase64', 'AB=='),
                           ('contentBase64', '%%%='), ('contentBase64', 1),
                           ('mode', '100600'), ('path', '../bad'), ('extra', 1)]:
            frame = json.loads(self.frame())
            frame['files'][0][key] = value
            with self.subTest(key=key, value=value):
                with self.assertRaises(ValueError):
                    decode_frame(json.dumps(frame, sort_keys=True, separators=(',', ':')).encode(), **self.ids)

    def test_collisions_and_complete_inventory_rejected(self):
        for files in [self.files+(self.files[0],), self.files+(SnapshotFile('BIN/no', '100644', b'x'),),
                      (SnapshotFile('a', '100644', b'x'), SnapshotFile('a/b', '100644', b'y')),
                      (SnapshotFile('.codex/config', '100644', b'x'),)]:
            with self.assertRaises(ValueError):
                encode_frame(files, **self.ids)
        frame = json.loads(self.frame())
        frame['files'] = frame['files'][:-1]
        with self.assertRaises(ValueError):
            decode_frame(json.dumps(frame, sort_keys=True, separators=(',', ':')).encode(), **self.ids)

    def test_bounds_before_decoding(self):
        with self.assertRaises(ValueError):
            decode_frame(b' '* (MAX_FRAME+1), **self.ids)
        with self.assertRaises(ValueError):
            decode_frame(bytearray(self.frame()), **self.ids)
        oversized = (SnapshotFile('big.bin', '100644', b'x'*(1024*1024+1)),)
        with self.assertRaises(ValueError):
            encode_frame(oversized, **self.ids)
        frame = json.loads(self.frame())
        frame['files'][0]['contentBase64'] = base64.b64encode(b'x'*(1024*1024+1)).decode()
        with self.assertRaises(ValueError):
            decode_frame(json.dumps(frame, sort_keys=True, separators=(',', ':')).encode(), **self.ids)


if __name__ == '__main__':
    unittest.main()
