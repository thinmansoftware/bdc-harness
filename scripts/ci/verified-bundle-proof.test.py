import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import contextlib
import json

spec = importlib.util.spec_from_file_location("producer", Path(__file__).with_name("verified-bundle-proof.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class ProducerGuards(unittest.TestCase):
    def run_order_fixture(self, nonbuiltin):
        data = self.archive()
        output = io.StringIO()
        calls = []
        checkout, base, head = "c" * 40, "b" * 40, "a" * 40
        repo = Path(__file__).resolve().parents[2]
        generator = (repo / "scripts/generate-bundled-defaults.ts").read_text().encode()
        config = (repo / "bunfig.toml").read_text().encode()
        package = (repo / "package.json").read_text().encode()
        original_read = Path.read_bytes
        tools = {Path("/usr/bin/git"), Path(os.path.realpath("/usr/bin/python3"))}
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "scripts").mkdir()
            (root / "scripts/generate-bundled-defaults.ts").write_bytes(b'import x from "not-built-in";' if nonbuiltin else generator)
            (root / "bunfig.toml").write_bytes(config)
            (root / "package.json").write_bytes(package)
            bundle = root / producer.BUNDLE
            bundle.parent.mkdir(parents=True)
            bundle.write_bytes(b"bundle fixture\n")
            event = root / "event.json"
            event.write_text(json.dumps({"number": 1609, "pull_request": {"head": {"sha": head}, "base": {"sha": base}}}))
            def git(_root, *args):
                if args[0] == "show":
                    return (base + " " + head).encode()
                return checkout.encode()
            def run(argv, **kwargs):
                calls.append(argv[1:])
                if argv[1] == "install":
                    self.assertEqual("BUNDLE_PROOF_V1 " in output.getvalue(), not nonbuiltin)
            with patch.object(producer.platform, "system", return_value="Linux"), \
                 patch.object(producer.platform, "machine", return_value="x86_64"), \
                 patch.object(producer.urllib.request, "urlopen", return_value=io.BytesIO(data)), \
                 patch.object(producer, "ARCHIVE_SHA256", hashlib.sha256(data).hexdigest()), \
                 patch.object(producer, "verified_checkout", return_value="tree"), \
                 patch.object(producer, "git", side_effect=git), \
                 patch.object(producer.shutil, "which", side_effect=lambda *a, **k: str(next(root.glob("bundle-proof-*/bin/bun")))), \
                 patch.object(producer.subprocess, "run", side_effect=run), \
                 patch.object(Path, "read_bytes", lambda p: b"trusted managed tool" if p in tools else original_read(p)), \
                 patch.dict(os.environ, {"RUNNER_TEMP": d, "GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(event), "GITHUB_PATH": str(root / "path-output"), "GITHUB_REPOSITORY": "thinmansoftware/bdc-harness", "GITHUB_RUN_ID": "10", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_WORKFLOW_SHA": checkout, "GITHUB_WORKFLOW_REF": "workflow", "ImageOS": "ubuntu", "ImageVersion": "fixture"}), \
                 contextlib.redirect_stdout(output):
                producer.run_producer(root)
        return calls, output.getvalue()

    def test_receipt_and_dependency_free_check_precede_install(self):
        calls, output = self.run_order_fixture(False)
        self.assertEqual(calls, [["run", "scripts/generate-bundled-defaults.ts", "--check"], ["install", "--frozen-lockfile"]])
        self.assertEqual(output.count("BUNDLE_PROOF_V1 "), 1)

    def test_nonbuiltin_import_gets_no_receipt_or_postinstall_proof_fallback(self):
        calls, output = self.run_order_fixture(True)
        self.assertEqual(calls, [["install", "--frozen-lockfile"]])
        self.assertNotIn("BUNDLE_PROOF_V1 ", output)
        self.assertIn("BUNDLE_PROOF_UNAVAILABLE", output)
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

    def test_nonbuiltin_generator_is_ineligible_without_execution(self):
        check = getattr(producer, "generator_is_builtin_only", None)
        self.assertIsNotNone(check, "missing dependency-free generator gate")
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            script = root / "scripts/generate-bundled-defaults.ts"
            script.parent.mkdir()
            script.write_text('import evil from "external-module"; evil();')
            with patch.object(producer.subprocess, "run") as execute:
                self.assertFalse(check(root))
                execute.assert_not_called()

    def test_check_runtime_mutation_prevents_receipt_and_install(self):
        data = self.archive()
        calls = []
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            def run(argv, **kwargs):
                calls.append(argv)
                self.assertEqual(argv[1:], ["run", "scripts/generate-bundled-defaults.ts", "--check"])
                executable = Path(argv[0])
                executable.chmod(0o755)
                executable.write_bytes(b"changed by predecessor")
            with patch.object(producer.platform, "system", return_value="Linux"), \
                 patch.object(producer.platform, "machine", return_value="x86_64"), \
                 patch.object(producer.urllib.request, "urlopen", return_value=io.BytesIO(data)), \
                 patch.object(producer, "ARCHIVE_SHA256", hashlib.sha256(data).hexdigest()), \
                 patch.object(producer, "verified_checkout", return_value="tree"), \
                 patch.object(producer, "generator_is_builtin_only", return_value=True, create=True), \
                 patch.object(producer, "git", return_value=b"checkout"), \
                 patch.object(producer.shutil, "which", side_effect=lambda *a, **k: str(next(root.glob("bundle-proof-*/bin/bun")))), \
                 patch.object(producer.subprocess, "run", side_effect=run), \
                 patch.dict(os.environ, {"RUNNER_TEMP": d}):
                with self.assertRaisesRegex(ValueError, "runtime_mutated"):
                    producer.run_producer(root)
            self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
