"""Synthetic observed-response data only. No server or application is executed."""
from dataclasses import FrozenInstanceError, replace
import hashlib
import unittest

from teetime_foundation_http import HTTP_CASES, HTTPResponseData, validate_foundation_http


def responses():
    result=[]
    for case_id,method,path,status,limit in HTTP_CASES:
        headers=()
        body=b''
        if case_id=='root-get':
            headers=(('Content-Type','text/html; charset=utf-8'),)
            body=b'<h1>What&#x27;s That Tee Time Again?</h1><p>Simulated prototype. No live availability or bookings.</p>'
        elif case_id=='health-get':
            headers=(('content-type','application/json'),('Cache-Control','max-age=0, NO-STORE'))
            body=b' { "mode" : "simulated", "status" : "ok" } '
        elif case_id=='health-head': headers=(('Cache-Control','no-store'),('Content-Length','34'))
        elif case_id=='health-options': headers=(('aLLoW','GET,HEAD, OPTIONS'),)
        elif case_id=='missing-get':
            headers=(('Content-Type','text/html'),)
            body=b'<h1>Not found</h1>'
        result.append(HTTPResponseData(case_id,method,path,status,headers,body,True,False))
    return tuple(result)


def changed(target_case,**patch):
    return tuple(replace(value,**patch) if value.case_id==target_case else value for value in responses())


class FoundationHTTPTests(unittest.TestCase):
    def test_complete_matrix_returns_only_immutable_observations_and_hashes(self):
        source=responses()
        result=validate_foundation_http(source)
        self.assertEqual(len(result.observations),9)
        self.assertEqual(result.observations[0].body_sha256,hashlib.sha256(source[0].body).hexdigest())
        self.assertEqual(result.observations[0].body_bytes,len(source[0].body))
        self.assertFalse(hasattr(result,'approved'))
        self.assertFalse(hasattr(result,'ready'))
        with self.assertRaises(FrozenInstanceError): result.observations=()
        with self.assertRaises(FrozenInstanceError): result.observations[0].status=500
        mutable=list(source)
        copied=validate_foundation_http(tuple(mutable))
        mutable[0]=replace(mutable[0],body=b'changed after validation')
        self.assertEqual(copied.observations[0].body_sha256,result.observations[0].body_sha256)

    def test_health_requires_exact_unique_json_keys_and_values(self):
        for body in [b'{"status":"ok","mode":"live"}',b'{"status":"ok","mode":"simulated","extra":1}',
          b'{"status":"bad","status":"ok","mode":"simulated"}',
          b'{"status":"bad","\\u0073tatus":"ok","mode":"simulated"}',
          b'{"status":"ok","mode":"simulated"} trailing',b'\xff',b'NaN']:
            with self.assertRaises(ValueError): validate_foundation_http(changed('health-get',body=body))

    def test_cache_control_does_not_accept_substrings_or_quoted_extension_values(self):
        for control in ['public','x-no-store','max-age="no-store"','extension="x,no-store,y"',
                        'no-store=true','extension="unfinished','no-store, no-store']:
            headers=(('Content-Type','application/json'),('Cache-Control',control))
            with self.assertRaises(ValueError): validate_foundation_http(changed('health-get',headers=headers))
        headers=(('Content-Type','application/json'),('Cache-Control','extension="a,b", no-store'))
        self.assertEqual(len(validate_foundation_http(changed('health-get',headers=headers)).observations),9)

    def test_allow_set_and_empty_observed_head_options_bodies(self):
        for allow in ['GET, HEAD','GET, HEAD, OPTIONS, PATCH','GET,GET,HEAD,OPTIONS','get,HEAD,OPTIONS']:
            with self.assertRaises(ValueError): validate_foundation_http(changed('health-options',headers=(('Allow',allow),)))
        for case_id in ['health-head','health-options']:
            with self.assertRaises(ValueError): validate_foundation_http(changed(case_id,body=b'unexpected'))

    def test_status_case_completeness_and_types_fail_closed(self):
        for patch in [{'status':302},{'status':True},{'completed':False},{'completed':1},
                      {'truncated':True},{'truncated':0},{'body':bytearray(b'bad')},
                      {'method':'POST'},{'path':'https://external.invalid/'},{'case_id':'other'}]:
            with self.assertRaises(ValueError): validate_foundation_http(changed('root-get',**patch))
        source=responses()
        for collection in [source[:-1],source+source[:1],(source[0],source[0])+source[2:],list(source)]:
            with self.assertRaises(ValueError): validate_foundation_http(collection)

    def test_headers_encoding_singletons_and_bounds(self):
        for headers in [tuple(('x-'+str(i),'v') for i in range(65)),
                        (('X-Huge','x'*16385),),(('Content-Type','text/html'),('content-type','text/html')),
                        (('Content-Type','text/html'),('Content-Encoding','gzip')),
                        (('Content-Type','text/html'),('X-Bad','bad\r\nheader')),
                        (('Content-Type','text/html; charset=iso-8859-1'),),
                        tuple(('x-'+str(i),'x'*4000) for i in range(5)),
                        [('Content-Type','text/html')]]:
            with self.assertRaises(ValueError): validate_foundation_http(changed('root-get',headers=headers))
        with self.assertRaises(ValueError): validate_foundation_http(changed('root-get',body=b'\xff'))
        for case_id,_method,_path,_status,limit in HTTP_CASES:
            with self.assertRaises(ValueError): validate_foundation_http(changed(case_id,body=b'x'*(limit+1)))

    def test_ambiguous_or_incomplete_framing_fails_even_when_flag_claims_complete(self):
        for headers in [(('Content-Type','text/html'),('Content-Length','999')),
                        (('Content-Type','text/html'),('Content-Length','not-a-number')),
                        (('Content-Type','text/html'),('Transfer-Encoding','chunked'),('Content-Length','1')),
                        (('Content-Type','text/html'),('Transfer-Encoding','gzip'))]:
            with self.assertRaises(ValueError): validate_foundation_http(changed('root-get',headers=headers))

    def test_root_presence_and_content_types_are_observed_checks_not_browser_acceptance(self):
        with self.assertRaises(ValueError): validate_foundation_http(changed('root-get',body=b'<h1>Different page</h1>'))
        with self.assertRaises(ValueError): validate_foundation_http(changed('root-get',headers=(('Content-Type','application/json'),)))
        with self.assertRaises(ValueError): validate_foundation_http(changed('health-get',headers=(('Content-Type','text/plain'),('Cache-Control','no-store'))))


if __name__=='__main__': unittest.main()
