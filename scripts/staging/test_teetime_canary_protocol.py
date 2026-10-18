import io
import struct
import unittest
from teetime_canary_protocol import encode_frame, read_frame


class FramingTests(unittest.TestCase):
    def test_binary_round_trip(self):
        value = bytes(range(256)) * 256
        self.assertEqual(read_frame(io.BytesIO(encode_frame(value))), value)

    def test_partial_header_and_body_rejected(self):
        for raw in [b'', b'\0', b'\0\0\0', struct.pack('!I', 5) + b'four']:
            with self.subTest(size=len(raw)), self.assertRaises(ValueError):
                read_frame(io.BytesIO(raw))

    def test_zero_and_oversized_rejected(self):
        for size in [0, 65537, 2**32 - 1]:
            with self.subTest(size=size), self.assertRaises(ValueError):
                read_frame(io.BytesIO(struct.pack('!I', size)))

    def test_extra_and_duplicate_frames_rejected(self):
        for suffix in [b'x', encode_frame(b'second')]:
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                read_frame(io.BytesIO(encode_frame(b'first') + suffix))

    def test_fragmented_reads(self):
        class Fragmented(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(size, 2))
        self.assertEqual(read_frame(Fragmented(encode_frame(b'fragmented'))), b'fragmented')


if __name__ == '__main__':
    unittest.main()
