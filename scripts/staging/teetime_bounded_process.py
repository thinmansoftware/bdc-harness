"""Cross-platform bounded capture; child output is never written to a file."""
import queue
import subprocess
import threading
import time


def capture(argv, timeout, limit=4096):
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    events = queue.Queue(maxsize=8)
    stop = threading.Event()
    def read(stream, kind):
        try:
            while not stop.is_set():
                chunk = stream.read(1024)
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
        return child.wait(timeout=max(.1, deadline-time.monotonic())), bytes(output)
    finally:
        stop.set()
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
