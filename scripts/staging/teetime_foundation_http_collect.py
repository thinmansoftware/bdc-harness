"""Fixed loopback HTTP collector; no server custody or admission authority."""
from dataclasses import dataclass
import http.client
import platform
import re
import socket
import sys
import threading
import time

from teetime_foundation_http import (
    HTTP_CASES, HTTPResponseData, ValidatedHTTPData, header_map,
    validate_case_headers, validate_foundation_http,
)

IDLE_SECONDS=2.0
TOTAL_SECONDS=15.0


class HTTPCollectionError(RuntimeError):
    """Closed error categories only; never include remote bytes or exceptions."""


@dataclass(frozen=True)
class CollectedHTTPData:
    data: ValidatedHTTPData
    python_version: str


def collect_foundation_http():
    if (sys.implementation.name!='cpython' or sys.version_info[:2]!=(3,12)
            or http.client._MAXLINE!=65536 or http.client._MAXHEADERS!=100):
        raise HTTPCollectionError('foundation HTTP runtime rejected')
    deadline=time.monotonic()+TOTAL_SECONDS
    expired=threading.Event()
    records=[]

    def remaining():
        value=deadline-time.monotonic()
        if expired.is_set() or value<=0:
            raise HTTPCollectionError('foundation HTTP timeout')
        return min(IDLE_SECONDS,value)

    for case_id,method,path,status,limit in HTTP_CASES:
        connection=response=owned=timer=None
        timer_started=False
        category=None
        cleanup_failed=threading.Event()
        try:
            connection=http.client.HTTPConnection('127.0.0.1',3187,timeout=remaining())
            connection.connect()
            owned=connection.sock
            remaining()
            if owned is None: raise ValueError('socket absent')

            def expire(target=owned,failed=cleanup_failed):
                expired.set()
                try: target.shutdown(socket.SHUT_RDWR)
                except OSError: pass
                try: target.close()
                except OSError: failed.set()

            timer=threading.Timer(max(0,deadline-time.monotonic()),expire)
            timer.daemon=True
            timer.start()
            timer_started=True
            owned.settimeout(remaining())
            connection.request(method,path,headers={
                'Accept':'*/*','Accept-Encoding':'identity','Connection':'close',
            })
            owned.settimeout(remaining())
            response=connection.getresponse()
            remaining()
            pairs=tuple(response.getheaders())
            headers,_=header_map(pairs)
            if response.status!=status: raise ValueError('status rejected')
            validate_case_headers(case_id,headers)
            if 'content-length' in headers:
                length=headers['content-length']
                if not re.fullmatch('[0-9]{1,20}',length): raise ValueError('length rejected')
                if method!='HEAD' and int(length)>limit: raise ValueError('body exceeded')
            body=bytearray()
            while not response.isclosed():
                owned.settimeout(remaining())
                part=response.read1(min(65536,limit+1-len(body)))
                remaining()
                if not part: break
                body.extend(part)
                if len(body)>limit: raise ValueError('body exceeded')
            if (response.length not in (None,0)
                    or response.chunked and response.chunk_left is not None):
                raise ValueError('incomplete body')
            records.append(HTTPResponseData(case_id,method,path,response.status,
                                           pairs,bytes(body),True,False))
        except HTTPCollectionError:
            category='timeout'
        except (TimeoutError,socket.timeout):
            category='timeout'
        except (OSError,http.client.HTTPException,ValueError):
            category='observation'
        except RuntimeError:
            category='runtime'
        finally:
            if timer is not None:
                try:
                    timer.cancel()
                    if timer_started:
                        timer.join(.5)
                        if timer.is_alive(): cleanup_failed.set()
                except RuntimeError: cleanup_failed.set()
            # Timer ownership ends before the socket can be replaced or reused.
            for resource in (response,connection,owned):
                if resource is not None:
                    try: resource.close()
                    except (OSError,ValueError): cleanup_failed.set()
        if cleanup_failed.is_set():
            raise HTTPCollectionError('foundation HTTP cleanup rejected') from None
        if expired.is_set() or deadline<=time.monotonic(): category='timeout'
        if category is not None:
            raise HTTPCollectionError('foundation HTTP '+category+' rejected') from None
    remaining()
    try: validated=validate_foundation_http(tuple(records))
    except ValueError:
        raise HTTPCollectionError('foundation HTTP observation rejected') from None
    remaining()
    return CollectedHTTPData(validated,platform.python_version())
