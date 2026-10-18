"""Bounded binary framing shared by the operator and remote canary launcher."""
import struct

MAX_AUTH_BYTES = 65536


def read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise ValueError('incomplete credential frame')
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)


def read_frame(stream):
    size = struct.unpack('!I', read_exact(stream, 4))[0]
    if not 0 < size <= MAX_AUTH_BYTES:
        raise ValueError('invalid credential frame size')
    payload = read_exact(stream, size)
    if stream.read(1):
        raise ValueError('trailing credential frame data')
    return payload


def encode_frame(payload):
    if not isinstance(payload, bytes) or not 0 < len(payload) <= MAX_AUTH_BYTES:
        raise ValueError('invalid credential frame size')
    return struct.pack('!I', len(payload)) + payload
