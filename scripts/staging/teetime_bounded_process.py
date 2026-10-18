"""Cross-platform bounded capture; child output is never written to a file."""
import queue
import subprocess
import threading
import time


def capture(argv, timeout, limit=4096, input_bytes=None, on_stdout=None, *, env=None):
    if input_bytes is not None and (not isinstance(input_bytes, bytes) or len(input_bytes) > 65536):
        raise ValueError('bounded subprocess input exceeded')
    child = subprocess.Popen(argv, stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    events = queue.Queue(maxsize=8)
    stop = threading.Event()
    if input_bytes is not None:
        def write():
            try:
                child.stdin.write(input_bytes)
                child.stdin.close()
            except (BrokenPipeError, OSError):
                pass
            finally:
                try:
                    child.stdin.close()
                except OSError:
                    pass
        threading.Thread(target=write, daemon=True).start()
    def read(stream, kind):
        try:
            while not stop.is_set():
                chunk = stream.read1(1024)
                while not stop.is_set():
                    try:
                        events.put((kind, chunk), timeout=.1)
                        break
                    except queue.Full:
                        pass
                if not chunk:
                    break
        finally:
            stream.close()
    for stream, kind in [(child.stdout, 'out'), (child.stderr, 'err')]:
        threading.Thread(target=read, args=(stream, kind), daemon=True).start()
    output = bytearray()
    total = 0
    ended = set()
    deadline = time.monotonic()+timeout
    try:
        while len(ended) != 2:
            remaining = deadline-time.monotonic()
            if remaining <= 0:
                raise TimeoutError('bounded subprocess timeout')
            kind, chunk = events.get(timeout=remaining)
            if not chunk:
                ended.add(kind)
                continue
            total += len(chunk)
            if total > limit:
                raise ValueError('bounded subprocess output exceeded')
            if kind == 'out':
                output.extend(chunk)
                if on_stdout is not None:
                    on_stdout(chunk)
        return child.wait(timeout=max(.1, deadline-time.monotonic())), bytes(output)
    finally:
        stop.set()
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
