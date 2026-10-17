import base64
import io
import json
import unittest

from teetime_auth_receiver import validate_payload

def fixture(exp=5000):
    claims=base64.urlsafe_b64encode(json.dumps({'exp':exp}).encode()).rstrip(b'=').decode()
    return json.dumps({'auth_mode':'chatgpt','tokens':{'access_token':'header.'+claims+'.synthetic',
        'id_token':'synthetic','refresh_token':'synthetic','account_id':'synthetic'}}).encode()

class ReceiverValidation(unittest.TestCase):
    def test_valid_payload_is_preserved_without_serialization(self):
        raw=fixture()
        self.assertEqual(validate_payload(io.BytesIO(raw),1000),raw)

    def test_expired_near_expiry_and_malformed_payload_rejected(self):
        for raw in [fixture(2800),fixture(999),fixture(float('inf')),fixture(True),b'{}',b'not json',b'x'*65537,
                    b'{"auth_mode":"apikey"}',fixture().replace(b'"synthetic"',b'null')]:
            with self.subTest(raw_length=len(raw)):
                with self.assertRaises(ValueError) as caught:
                    validate_payload(io.BytesIO(raw),1000)
                self.assertEqual(str(caught.exception),'credential receipt rejected')

    def test_duplicate_json_keys_rejected(self):
        raw=fixture().replace(b'"auth_mode": "chatgpt"',b'"auth_mode":"apikey","auth_mode":"chatgpt"')
        with self.assertRaises(ValueError): validate_payload(io.BytesIO(raw),1000)

    def test_alternate_credentials_and_unknown_fields_rejected(self):
        for field,value in [('OPENAI_API_KEY','synthetic'),('api_key','synthetic'),('extra',None)]:
            data=json.loads(fixture());data[field]=value
            with self.assertRaises(ValueError): validate_payload(io.BytesIO(json.dumps(data).encode()),1000)
        data=json.loads(fixture());data['OPENAI_API_KEY']=None
        validate_payload(io.BytesIO(json.dumps(data).encode()),1000)

if __name__=='__main__': unittest.main()
