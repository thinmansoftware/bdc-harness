import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

from teetime_startup_packet import startup_metadata, write_private_packet, read_private_metadata


def packet():
    return {'kind':'teetime-thread-start-debug-v1',
            'steps':['initialize','initialized','thread/start'], 'threadCreated':False,
            'rpcError':{'code':-32603,'message':'synthetic-private-error','data':{'detail':'private-data'}},
            'binaryHash':'b'*64,'sourceFixtureHash':'59f2bbc19bce43c67d6f1cdd99886953a256d948788d85810c774b17375c1fb6',
            'catalogHash':'c'*64,'authUnchanged':True,'catalogUnchanged':True,
            'childReaped':True,'modelTurnsSent':0}


def encode(value):
    return json.dumps(value,separators=(',',':')).encode()


class StartupPacketTests(unittest.TestCase):
    def test_public_projection_never_contains_private_rpc_data_or_approval(self):
        raw=encode(packet())
        result=startup_metadata(raw)
        self.assertEqual(result['rpcCode'],-32603)
        self.assertEqual(result['bytes'],len(raw))
        self.assertEqual(result['sha256'],hashlib.sha256(raw).hexdigest())
        self.assertNotIn('private',json.dumps(result))
        self.assertNotIn('passed',result)
        self.assertNotIn('approval',result)

    def test_created_thread_is_diagnostic_state_not_qualification(self):
        value={**packet(),'threadCreated':True,'rpcError':None}
        result=startup_metadata(encode(value))
        self.assertTrue(result['threadCreated'])
        self.assertIsNone(result['rpcCode'])
        self.assertNotIn('passed',result)

    def test_rejects_invalid_unicode_in_private_data_keys_and_values(self):
        for data in [{'bad':'\ud800'}, {'\udfff':'value'}, ['\ud800']]:
            value=packet()
            value['rpcError']['data']=data
            with self.assertRaises(ValueError): startup_metadata(encode(value))

    def test_rejects_deep_or_nonfinite_private_data(self):
        deep=0
        for _ in range(33): deep=[deep]
        for data in [float('inf'),deep]:
            value=packet()
            value['rpcError']['data']=data
            with self.assertRaises(ValueError): startup_metadata(encode(value))

    def test_rejects_extra_duplicate_partial_unbounded_or_query_packets(self):
        base=packet()
        for patch in [{'extra':'private'},{'steps':['initialize','thread/start','turn/start']},
                      {'threadCreated':True},{'rpcError':None},{'authUnchanged':False},
                      {'childReaped':False},{'modelTurnsSent':True},{'modelTurnsSent':1},
                      {'rpcError':{'code':True,'message':'private'}},
                      {'rpcError':{'code':1,'message':'x'*32769}}, {'binaryHash':'not-a-hash'}]:
            with self.assertRaises(ValueError): startup_metadata(encode({**base,**patch}))
        raw=encode(base)
        for value in [b'',b'x'*65537,b'NaN',b'\xff',raw.replace(b'"kind":',b'"kind":"duplicate","kind":'),raw+b' extra']:
            with self.assertRaises(ValueError): startup_metadata(value)

    def test_writer_is_exclusive_owner_only_and_refuses_unsupported_platforms(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            if os.name!='posix':
                with self.assertRaises(RuntimeError): write_private_packet(root,'teetime-startup-123-1',encode(packet()))
                self.assertEqual(list(root.iterdir()),[])
                return
            path=write_private_packet(root,'teetime-startup-123-1',encode(packet()))
            self.assertEqual(path.read_bytes(),encode(packet()))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode),0o700)
            self.assertEqual(read_private_metadata(root,'teetime-startup-123-1'),startup_metadata(encode(packet())))
            with self.assertRaises(ValueError): write_private_packet(root,'teetime-startup-123-1',encode(packet()))
            self.assertEqual(path.read_bytes(),encode(packet()))

    def test_invalid_owner_or_packet_creates_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for owner,raw in [('foreign',encode(packet())),('teetime-startup-123-1',b'invalid')]:
                with self.assertRaises(ValueError): write_private_packet(root,owner,raw)
            self.assertEqual(list(root.iterdir()),[])

    @unittest.skipUnless(os.name=='posix','requires actual POSIX filesystem')
    def test_symlink_root_and_preexisting_owner_cannot_redirect_private_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            target=root/'target'
            target.mkdir()
            alias=root/'alias'
            alias.symlink_to(target,target_is_directory=True)
            with self.assertRaises(ValueError): write_private_packet(alias,'teetime-startup-123-1',encode(packet()))
            (root/'teetime-startup-123-1').symlink_to(target,target_is_directory=True)
            with self.assertRaises(ValueError): write_private_packet(root,'teetime-startup-123-1',encode(packet()))
            self.assertEqual(list(target.iterdir()),[])

    @unittest.skipUnless(os.name=='posix','requires actual POSIX filesystem')
    def test_upload_reader_rejects_extra_files_weaker_permissions_and_hardlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            path=write_private_packet(root,'teetime-startup-123-1',encode(packet()))
            extra=path.parent/'extra'
            extra.write_text('private')
            with self.assertRaises(ValueError): read_private_metadata(root,'teetime-startup-123-1')
            extra.unlink()
            path.chmod(0o644)
            with self.assertRaises(ValueError): read_private_metadata(root,'teetime-startup-123-1')
            path.chmod(0o600)
            os.link(path,root/'hardlink')
            with self.assertRaises(ValueError): read_private_metadata(root,'teetime-startup-123-1')


if __name__=='__main__': unittest.main()
