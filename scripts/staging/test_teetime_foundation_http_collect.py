"""Owned loopback fixtures only; no app, provider or production port is contacted."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import socket
import threading
import time
import unittest
from unittest.mock import patch

import teetime_foundation_http_collect as collector
from test_teetime_foundation_http import responses

REAL_CONNECTION=http.client.HTTPConnection
REAL_TIMER=threading.Timer


@contextmanager
def fixture(fault=None,*,late_connect=False):
    by_request={(value.method,value.path):value for value in responses()}
    release=threading.Event()
    handlers=[]
    requests=[]
    connections=[]
    sockets=[]
    timers=[]
    class Handler(BaseHTTPRequestHandler):
        protocol_version='HTTP/1.1'
        def handle(self):
            handlers.append(threading.current_thread())
            try: super().handle()
            except (OSError,ValueError): pass
        def log_message(self,*_): pass
        def respond(self):
            requests.append((self.command,self.path))
            value=by_request[(self.command,self.path)]
            active=fault if value.case_id=='root-get' or fault=='every-delay' else None
            body=value.body
            headers=list(value.headers)
            if active=='every-delay': release.wait(.025)
            if active=='header-trickle':
                self.wfile.write(b'HTTP/1.1 200 OK\r\nX-Trickle: ');self.wfile.flush()
                for _ in range(100):
                    if release.wait(.01): break
                    self.wfile.write(b'x');self.wfile.flush()
                self.close_connection=True
                return
            status=302 if active=='redirect' else value.status
            self.send_response(status)
            if active=='redirect': headers.append(('Location','https://external.invalid/never-follow'))
            if active=='bad-headers': headers.append(('Content-Type','text/html'))
            if active=='many-headers': headers.extend(('X-'+str(i),'v') for i in range(65))
            chunked=active in ('chunked','incomplete-chunk','oversized-chunk')
            if chunked: headers.append(('Transfer-Encoding','chunked'))
            elif self.command!='HEAD': headers.append(('Content-Length',str(len(body)+(7 if active=='short' else 0))))
            for name,value_ in headers: self.send_header(name,value_)
            self.send_header('Connection','close');self.end_headers()
            if self.command=='HEAD': return
            if active=='idle': release.wait(1)
            if active=='trickle':
                for byte in body:
                    if release.wait(.01): break
                    self.wfile.write(bytes([byte]));self.wfile.flush()
            elif chunked:
                if active=='oversized-chunk': body=b'x'*524289
                for chunk in [body[:10],body[10:]]:
                    if not chunk: continue
                    self.wfile.write(('%x\r\n'%len(chunk)).encode()+chunk+b'\r\n')
                if active!='incomplete-chunk': self.wfile.write(b'0\r\n\r\n')
            else: self.wfile.write(body)
            self.wfile.flush()
        do_GET=do_HEAD=do_OPTIONS=do_POST=do_PUT=do_PATCH=do_DELETE=respond
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    server.daemon_threads=True
    service=threading.Thread(target=lambda:server.serve_forever(poll_interval=.01),daemon=True)
    service.start()
    def connect(host,port,*,timeout):
        if (host,port)!=('127.0.0.1',3187): raise AssertionError('nonfixed production endpoint')
        connection=REAL_CONNECTION('127.0.0.1',server.server_port,timeout=timeout)
        original=connection.connect
        def tracked():
            original();sockets.append(connection.sock)
            if late_connect: time.sleep(.08)
        connection.connect=tracked
        connections.append(connection)
        return connection
    def timer(interval,function):
        value=REAL_TIMER(interval,function)
        timers.append(value)
        return value
    try:
        with patch.object(collector.http.client,'HTTPConnection',side_effect=connect),patch.object(collector.threading,'Timer',side_effect=timer):
            yield requests,connections,sockets,timers
    finally:
        release.set()
        server.shutdown();server.server_close();service.join(1)
        for thread in handlers: thread.join(1)
        if service.is_alive() or any(thread.is_alive() for thread in handlers):
            raise AssertionError('fixture thread cleanup failed')


class FoundationHTTPCollectTests(unittest.TestCase):
    def assert_closed(self,connections,sockets,timers):
        self.assertTrue(connections)
        self.assertTrue(all(value.sock is None for value in connections))
        self.assertTrue(all(value.fileno()==-1 for value in sockets))
        self.assertTrue(all(not value.is_alive() for value in timers))

    def test_actual_normal_and_chunked_collection_and_cleanup(self):
        for mode in [None,'chunked']:
            with fixture(mode) as (requests,connections,sockets,timers):
                result=collector.collect_foundation_http()
                self.assertEqual(len(result.data.observations),9)
                self.assertTrue(result.python_version.startswith('3.12.'))
                self.assertFalse(hasattr(result,'approved'))
                self.assertEqual(requests,[(value.method,value.path) for value in responses()])
                self.assert_closed(connections,sockets,timers)

    def test_redirect_bad_headers_short_and_incomplete_or_oversized_chunk_never_retry(self):
        for mode in ['redirect','bad-headers','many-headers','short','incomplete-chunk','oversized-chunk']:
            with fixture(mode) as (requests,connections,sockets,timers):
                with self.assertRaises(collector.HTTPCollectionError): collector.collect_foundation_http()
                self.assertEqual(len(requests),1)
                self.assert_closed(connections,sockets,timers)

    def test_idle_timeout_and_trickles_use_one_overall_deadline(self):
        for mode in ['idle','trickle','header-trickle']:
            with fixture(mode) as (requests,connections,sockets,timers),patch.object(collector,'IDLE_SECONDS',.05),patch.object(collector,'TOTAL_SECONDS',.12):
                started=time.monotonic()
                with self.assertRaisesRegex(collector.HTTPCollectionError,'timeout'): collector.collect_foundation_http()
                self.assertLess(time.monotonic()-started,.8)
                self.assertEqual(len(requests),1)
                self.assert_closed(connections,sockets,timers)

    def test_late_socket_publication_after_deadline_is_closed_without_request(self):
        with fixture(late_connect=True) as (requests,connections,sockets,timers),patch.object(collector,'TOTAL_SECONDS',.03):
            with self.assertRaisesRegex(collector.HTTPCollectionError,'timeout'): collector.collect_foundation_http()
            self.assertEqual(requests,[])
            self.assert_closed(connections,sockets,timers)

    def test_changed_stdlib_limits_are_rejected_before_connection(self):
        with patch.object(collector.http.client,'_MAXHEADERS',1000),patch.object(collector.http.client,'HTTPConnection') as connect:
            with self.assertRaisesRegex(collector.HTTPCollectionError,'runtime'): collector.collect_foundation_http()
            connect.assert_not_called()

    def test_expiry_racing_cancel_closes_owned_socket_and_stops_next_request(self):
        callbacks=[]
        class RacingTimer:
            def __init__(self,interval,function):
                self.function=function
                self.worker=None
            def start(self): pass
            def cancel(self):
                self.worker=threading.Thread(target=self.function)
                self.worker.start()
                callbacks.append(self.worker)
            def join(self,timeout): self.worker.join(timeout)
            def is_alive(self): return self.worker is not None and self.worker.is_alive()
        with fixture() as (requests,connections,sockets,_),patch.object(collector.threading,'Timer',RacingTimer):
            with self.assertRaisesRegex(collector.HTTPCollectionError,'timeout'):
                collector.collect_foundation_http()
            self.assertEqual(len(requests),1)
            self.assertEqual(len(connections),1)
            self.assert_closed(connections,sockets,callbacks)

    def test_deadline_is_shared_across_all_requests(self):
        with fixture('every-delay') as (requests,connections,sockets,timers),patch.object(collector,'TOTAL_SECONDS',.09):
            with self.assertRaisesRegex(collector.HTTPCollectionError,'timeout'):
                collector.collect_foundation_http()
            self.assertGreater(len(requests),1)
            self.assertLess(len(requests),9)
            self.assert_closed(connections,sockets,timers)

    def test_timer_start_failure_closes_connection_without_request(self):
        class UnstartedTimer:
            def __init__(self,*_): pass
            def start(self): raise RuntimeError('untrusted detail')
            def cancel(self): pass
            def join(self,*_): raise RuntimeError('cannot join unstarted thread')
        with fixture() as (requests,connections,sockets,_),patch.object(collector.threading,'Timer',UnstartedTimer):
            with self.assertRaisesRegex(collector.HTTPCollectionError,'^foundation HTTP runtime rejected$'):
                collector.collect_foundation_http()
            self.assertEqual(requests,[])
            self.assert_closed(connections,sockets,[])

    def test_close_failure_fails_closed_with_sanitized_error(self):
        with fixture() as (requests,connections,sockets,timers):
            factory=collector.http.client.HTTPConnection.side_effect
            def close_failure(*args,**kwargs):
                connection=factory(*args,**kwargs)
                original=connection.close
                def close():
                    original()
                    raise OSError('remote-untrusted-detail')
                connection.close=close
                return connection
            with patch.object(collector.http.client,'HTTPConnection',side_effect=close_failure):
                with self.assertRaisesRegex(collector.HTTPCollectionError,'^foundation HTTP cleanup rejected$'):
                    collector.collect_foundation_http()
            self.assertEqual(len(requests),1)
            self.assert_closed(connections,sockets,timers)


if __name__=='__main__': unittest.main()
