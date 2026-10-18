"""Pure HTTP observation checks. No socket, server custody or app acceptance."""
from dataclasses import dataclass
import hashlib
import html
import json
import re

from teetime_artifact_contract import canonical, unique_object, reject_constant, validate_depth


HTTP_CASES=(('root-get','GET','/',200,524288),
            ('health-get','GET','/api/health',200,4096),
            ('health-head','HEAD','/api/health',200,4096),
            ('health-options','OPTIONS','/api/health',204,4096),
            ('health-post','POST','/api/health',405,4096),
            ('health-put','PUT','/api/health',405,4096),
            ('health-patch','PATCH','/api/health',405,4096),
            ('health-delete','DELETE','/api/health',405,4096),
            ('missing-get','GET','/__teetime_missing__',404,65536))
TOKEN=re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
QUOTED=re.compile(r'"(?:[\t !#-\[\]-~]|\\[\t -~])*"')
SINGLETONS={'content-type','cache-control','allow','content-length','transfer-encoding','content-encoding','location'}


@dataclass(frozen=True)
class HTTPResponseData:
    case_id: str
    method: str
    path: str
    status: int
    headers: tuple[tuple[str,str],...]
    body: bytes
    completed: bool
    truncated: bool


@dataclass(frozen=True)
class HTTPObservation:
    case_id: str
    method: str
    path: str
    status: int
    body_bytes: int
    body_sha256: str
    headers_sha256: str


@dataclass(frozen=True)
class ValidatedHTTPData:
    observations: tuple[HTTPObservation,...]


def http_list(value):
    parts=[]
    start=0
    quoted=escaped=False
    for index,char in enumerate(value):
        if quoted:
            if escaped: escaped=False
            elif char=='\\': escaped=True
            elif char=='"': quoted=False
        elif char=='"': quoted=True
        elif char==',':
            parts.append(value[start:index].strip())
            start=index+1
    parts.append(value[start:].strip())
    if quoted or escaped or any(not part for part in parts):
        raise ValueError('foundation HTTP list rejected')
    return parts


def no_store(value):
    directives={}
    for item in http_list(value):
        name,equals,argument=item.partition('=')
        name=name.strip().lower()
        argument=argument.strip()
        if (TOKEN.fullmatch(name) is None or name in directives
                or equals and TOKEN.fullmatch(argument) is None and QUOTED.fullmatch(argument) is None):
            raise ValueError('foundation cache directive rejected')
        directives[name]=(equals,argument)
    if directives.get('no-store')!=('',''):
        raise ValueError('foundation no-store directive required')


def media_type(headers,wanted):
    parts=headers.get('content-type','').split(';')
    if parts[0].strip().lower()!=wanted: raise ValueError('foundation media type rejected')
    seen=set()
    for item in parts[1:]:
        name,equals,argument=item.strip().partition('=')
        name=name.strip().lower()
        argument=argument.strip()
        if (not equals or TOKEN.fullmatch(name) is None or name in seen
                or TOKEN.fullmatch(argument) is None and QUOTED.fullmatch(argument) is None):
            raise ValueError('foundation media parameter rejected')
        seen.add(name)
        if name=='charset' and argument.strip('"').lower() not in ('utf-8','utf8'):
            raise ValueError('foundation UTF-8 charset required')


def header_map(pairs):
    if type(pairs) is not tuple or len(pairs)>64:
        raise ValueError('foundation header count or type rejected')
    result={}
    total=0
    for pair in pairs:
        if type(pair) is not tuple or len(pair)!=2:
            raise ValueError('foundation raw header pair rejected')
        name,value=pair
        if (type(name) is not str or type(value) is not str or not 1<=len(name)<=16384
                or len(value)>16384 or not name.isascii() or not value.isascii()
                or TOKEN.fullmatch(name) is None or any(ord(char)<32 and char!='\t' or ord(char)==127 for char in value)):
            raise ValueError('foundation header encoding rejected')
        total+=len(name)+len(value)+4
        if total>16384: raise ValueError('foundation header bytes exceeded')
        lower=name.lower()
        if lower in SINGLETONS and lower in result:
            raise ValueError('foundation duplicate singleton header')
        result[lower]=value.strip()
    if result.get('content-encoding','identity').lower()!='identity':
        raise ValueError('foundation encoded body rejected')
    if 'transfer-encoding' in result and ('content-length' in result or result['transfer-encoding'].lower()!='chunked'):
        raise ValueError('foundation ambiguous body framing')
    return result,total


def validate_case_headers(case_id,headers):
    if case_id in ('root-get','missing-get'): media_type(headers,'text/html')
    if case_id=='health-get': media_type(headers,'application/json')
    if case_id in ('health-get','health-head'): no_store(headers.get('cache-control',''))
    if case_id=='health-options':
        allowed=http_list(headers.get('allow',''))
        if len(allowed)!=3 or set(allowed)!={'GET','HEAD','OPTIONS'}:
            raise ValueError('foundation Allow method set rejected')


def validate_foundation_http(records):
    if type(records) is not tuple or len(records)!=len(HTTP_CASES):
        raise ValueError('foundation complete HTTP cases required')
    total=0
    observed=[]
    for record,case in zip(records,HTTP_CASES):
        case_id,method,path,status,limit=case
        if (type(record) is not HTTPResponseData or any(type(field) is not str for field in (record.case_id,record.method,record.path))
                or record.case_id!=case_id or record.method!=method
                or record.path!=path or type(record.status) is not int or record.status!=status
                or type(record.completed) is not bool or record.completed is not True
                or type(record.truncated) is not bool or record.truncated is not False
                or type(record.body) is not bytes or len(record.body)>limit):
            raise ValueError('foundation HTTP case observation rejected')
        headers,header_bytes=header_map(record.headers)
        validate_case_headers(case_id,headers)
        total+=header_bytes+len(record.body)
        if total>1048576: raise ValueError('foundation aggregate HTTP bytes exceeded')
        if 'content-length' in headers:
            length=headers['content-length']
            if not re.fullmatch('[0-9]{1,20}',length): raise ValueError('foundation Content-Length rejected')
            if method!='HEAD' and int(length)!=len(record.body):
                raise ValueError('foundation incomplete observed body')
        if method in ('HEAD','OPTIONS') and record.body:
            raise ValueError('foundation empty observed body required')
        try: text=record.body.decode('utf-8')
        except UnicodeError: raise ValueError('foundation HTTP UTF-8 required') from None
        if case_id=='root-get':
            unescaped=html.unescape(text)
            if any(expected not in unescaped for expected in ["What's That Tee Time Again?",'Simulated prototype. No live availability or bookings.']):
                raise ValueError('foundation root text presence required')
        if case_id=='health-get':
            try:
                validate_depth(text)
                value=json.loads(text,object_pairs_hook=unique_object,parse_constant=reject_constant)
            except (ValueError,RecursionError): raise ValueError('foundation health JSON rejected') from None
            if type(value) is not dict or value!={'status':'ok','mode':'simulated'}:
                raise ValueError('foundation exact simulated health required')
        observed.append(HTTPObservation(case_id,method,path,status,len(record.body),
                        hashlib.sha256(record.body).hexdigest(),
                        hashlib.sha256(canonical(record.headers).encode('ascii')).hexdigest()))
    return ValidatedHTTPData(tuple(observed))
