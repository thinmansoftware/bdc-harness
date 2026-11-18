import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("producer", Path(__file__).with_name("verified-bundle-proof.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class ProducerGuards(unittest.TestCase):
    def test_checkout_failure_identifies_path_and_kind_without_file_contents(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            path = root / "tracked.ts"
            path.write_bytes(b"private payload")
            path.chmod(0o644)
            entry = b"100644 blob " + b"0" * 40 + b"\ttracked.ts\0"
            with patch.object(producer, "git", return_value=entry):
                with self.assertRaises(ValueError) as error:
                    producer.verified_checkout(root)
            self.assertIn('"path": "tracked.ts"', str(error.exception))
            self.assertIn('"blob_matches": false', str(error.exception))
            self.assertNotIn("private payload", str(error.exception))
    def archive(self, name="bun-linux-x64/bun", mode=0o100755):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as z:
            entry = zipfile.ZipInfo(name)
            entry.external_attr = mode << 16
            z.writestr(entry, b"verified executable fixture")
        return data.getvalue()

    def test_wrong_digest_does_not_extract_or_execute(self):
        unpack = getattr(producer, "unpack_verified", None)
        self.assertIsNotNone(unpack, "missing pre-execution archive gate")
        with tempfile.TemporaryDirectory() as d:
            dest = Path(d) / "runtime"
            with self.assertRaises(ValueError):
                unpack(self.archive(), "0" * 64, dest)
            self.assertFalse(dest.exists())

    def test_missing_digest_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                producer.unpack_verified(self.archive(), "", Path(d) / "runtime")

    def test_verified_archive_has_one_controlled_executable(self):
        data = self.archive()
        with tempfile.TemporaryDirectory() as d:
            exe = producer.unpack_verified(data, hashlib.sha256(data).hexdigest(), Path(d) / "runtime")
            self.assertEqual(exe.read_bytes(), b"verified executable fixture")
            self.assertEqual(exe.name, "bun")

    def test_traversal_symlink_and_unexpected_layout_are_rejected(self):
        for name, mode in [("../bun", 0o100755), ("bun-linux-x64/bun", 0o120777), ("other/bun", 0o100755)]:
            data = self.archive(name, mode)
            with tempfile.TemporaryDirectory() as d:
                with self.assertRaises(ValueError):
                    producer.unpack_verified(data, hashlib.sha256(data).hexdigest(), Path(d) / "runtime")

    def test_existing_or_cache_restored_location_is_rejected(self):
        data = self.archive()
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                producer.unpack_verified(data, hashlib.sha256(data).hexdigest(), Path(d))

    def test_runtime_changed_between_install_and_check_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            exe = Path(d) / "bun"
            exe.write_bytes(b"original")
            digest = producer.digest(exe.read_bytes())
            exe.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                producer.assert_runtime(exe, digest)

    def test_untracked_runtime_config_cannot_hide_in_snapshot(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "bunfig.toml").write_text('preload = ["bad.ts"]')
            with self.assertRaises(ValueError):
                producer.assert_no_untracked_config(root, set())

    def test_producer_never_reaches_check_after_install_mutates_runtime(self):
        data = self.archive()
        calls = []
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            def run(argv, **kwargs):
                calls.append(argv)
                self.assertEqual(argv[1:], ["install", "--frozen-lockfile"])
                executable = Path(argv[0])
                executable.chmod(0o755)
                executable.write_bytes(b"changed by predecessor")
            with patch.object(producer.platform, "system", return_value="Linux"), \
                 patch.object(producer.platform, "machine", return_value="x86_64"), \
                 patch.object(producer.urllib.request, "urlopen", return_value=io.BytesIO(data)), \
                 patch.object(producer, "ARCHIVE_SHA256", hashlib.sha256(data).hexdigest()), \
                 patch.object(producer, "verified_checkout", return_value="tree"), \
                 patch.object(producer, "git", return_value=b"checkout"), \
                 patch.object(producer.shutil, "which", side_effect=lambda *a, **k: str(next(root.glob("bundle-proof-*/bin/bun")))), \
                 patch.object(producer.subprocess, "run", side_effect=run), \
                 patch.dict(os.environ, {"RUNNER_TEMP": d}):
                with self.assertRaisesRegex(ValueError, "runtime_mutated"):
                    producer.run_producer(root)
            self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
