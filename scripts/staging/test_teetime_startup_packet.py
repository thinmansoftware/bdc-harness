import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

from teetime_startup_packet import startup_metadata, capture_metadata, write_private_packet, read_private_metadata


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



class StartupWarningEnvelopeTests(unittest.TestCase):
    def envelope(self, warnings=None):
        return {'kind':'teetime-thread-start-debug-v2','outcome':packet(),
                'configWarnings':warnings if warnings is not None else [{'summary':'PRIVATE-WARNING','details':None}]}

    def test_new_envelope_preserves_legacy_rejection_and_projects_no_private_fields(self):
        raw=encode(self.envelope())
        with self.assertRaises(ValueError): startup_metadata(raw)
        result=capture_metadata(raw)
        self.assertEqual(result['kind'],'teetime-thread-start-metadata-v2')
        self.assertEqual(result['configWarnings'],{'kind':'configWarning','count':1})
        self.assertEqual(result['sha256'],hashlib.sha256(raw).hexdigest())
        self.assertEqual(result['bytes'],len(raw))
        self.assertEqual(result['rpcCode'],-32603)
        self.assertNotIn('PRIVATE',json.dumps(result))
        self.assertNotIn('summary',json.dumps(result))
        self.assertEqual(capture_metadata(encode(packet())),startup_metadata(encode(packet())))

    def test_optional_fields_null_details_and_complete_positive_ranges(self):
        for warning in [{'summary':'','details':None},
                        {'summary':'private','details':'details','path':'/private/path',
                         'range':{'start':{'line':2,'column':2},'end':{'line':1,'column':1}}}]:
            value=self.envelope([warning])
            value['outcome'].update(threadCreated=True,rpcError=None)
            result=capture_metadata(encode(value))
            self.assertTrue(result['threadCreated'])
            self.assertNotIn('private',json.dumps(result))

    def test_rejects_wrong_schema_types_ranges_versions_and_warning_limits(self):
        good={'summary':'private','details':None}
        bad=[{}, {'summary':'private'}, {**good,'summary':None}, {**good,'details':2},
             {**good,'path':None}, {**good,'range':None}, {**good,'extra':1},
             {**good,'summary':'\ud800'}, {**good,'range':{'start':{},'end':{}}}]
        for number in [0,-1,1.5,True,9007199254740992]:
            bad.append({**good,'range':{'start':{'line':number,'column':1},'end':{'line':1,'column':1}}})
        for warning in bad:
            with self.subTest(warning=repr(warning)):
                with self.assertRaises(ValueError): capture_metadata(encode(self.envelope([warning])))
        for warnings in [None,{},[good]*5,[{'summary':'x'*16384,'details':None}]]:
            value=self.envelope(); value['configWarnings']=warnings
            with self.assertRaises(ValueError): capture_metadata(encode(value))
        for patch in [{'kind':'unknown'}, {'extra':1}, {'outcome':self.envelope()}]:
            with self.assertRaises(ValueError): capture_metadata(encode({**self.envelope(),**patch}))
        raw=encode(self.envelope())
        with self.assertRaises(ValueError): capture_metadata(raw.replace(b'"outcome":',b'"outcome":{},"outcome":'))

    @unittest.skipUnless(os.name=='posix','requires actual POSIX filesystem')
    def test_private_custody_round_trips_v2_bytes_and_projects_only_metadata(self):
        raw=encode(self.envelope())
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            path=write_private_packet(root,'teetime-startup-123-1',raw)
            self.assertEqual(path.read_bytes(),raw)
            self.assertEqual(read_private_metadata(root,'teetime-startup-123-1'),capture_metadata(raw))


if __name__=='__main__': unittest.main()
