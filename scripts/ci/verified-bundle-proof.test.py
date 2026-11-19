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
import base64
import shutil
import subprocess

# Real git, found on PATH before any test patches subprocess or shutil.
REAL_GIT = shutil.which("git")

spec = importlib.util.spec_from_file_location("producer", Path(__file__).with_name("verified-bundle-proof.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


def synthetic_merge(base, head):
    # A two-parent commit object and its real sha1, so merge_parents sees consistent git output.
    raw = (b"tree " + b"0" * 40 + b"\nparent " + base.encode() + b"\nparent " + head.encode()
           + b"\nauthor t <t@example.invalid> 0 +0000\ncommitter t <t@example.invalid> 0 +0000\n\nmerge\n")
    return raw, hashlib.sha1(b"commit " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


def fake_git(raw, sha):
    def git(_root, *args):
        if "cat-file" in args:
            return raw
        return sha.encode()
    return git


class ProducerGuards(unittest.TestCase):
    def run_order_fixture(self, nonbuiltin, root_files=None, tracked=frozenset(), expect_receipt=None):
        expect_receipt = (not nonbuiltin) if expect_receipt is None else expect_receipt
        data = self.archive()
        output = io.StringIO()
        calls = []
        base, head = "b" * 40, "a" * 40
        merge_object, checkout = synthetic_merge(base, head)
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
            for relative, raw in (root_files or {}).items():
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                (root / relative).write_bytes(raw)
            event = root / "event.json"
            event.write_text(json.dumps({"number": 1609, "pull_request": {"head": {"sha": head}, "base": {"sha": base}}}))
            git = fake_git(merge_object, checkout)
            def run(argv, **kwargs):
                calls.append(argv[1:])
                if argv[1] == "install":
                    self.assertEqual("BUNDLE_PROOF_V1 " in output.getvalue(), expect_receipt)
            with patch.object(producer.platform, "system", return_value="Linux"), \
                 patch.object(producer.platform, "machine", return_value="x86_64"), \
                 patch.object(producer.urllib.request, "urlopen", return_value=io.BytesIO(data)), \
                 patch.object(producer, "ARCHIVE_SHA256", hashlib.sha256(data).hexdigest()), \
                 patch.object(producer, "verified_checkout", return_value=("tree", frozenset(tracked))), \
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
    # WO-HARNESS-BUNDLE-REVIEW-PROOF-REPAIR-01 D1: the repo tracks .env.example and
    # .env.staging.example at its root, so the old root `.env*` glob refused every checkout.
    def test_tracked_env_example_templates_still_get_one_receipt(self):
        templates = {".env.example": b"FOO=placeholder\n", ".env.staging.example": b"BAR=placeholder\n"}
        calls, output = self.run_order_fixture(False, templates, set(templates))
        self.assertEqual(output.count("BUNDLE_PROOF_V1 "), 1)
        self.assertNotIn("BUNDLE_PROOF_UNAVAILABLE", output)
        self.assertEqual(calls, [["run", "scripts/generate-bundled-defaults.ts", "--check"], ["install", "--frozen-lockfile"]])

    def eligible_root(self, root):
        repo = Path(__file__).resolve().parents[2]
        (root / "scripts").mkdir()
        for relative in ("scripts/generate-bundled-defaults.ts", "bunfig.toml", "package.json"):
            (root / relative).write_bytes((repo / relative).read_text().encode())
        return {"scripts/generate-bundled-defaults.ts", "bunfig.toml", "package.json"}

    def test_untracked_env_file_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            tracked = self.eligible_root(root)
            # Premise: the root is otherwise eligible, so the refusal below is the .env file's.
            self.assertTrue(producer.generator_is_builtin_only(root, tracked))
            (root / ".env").write_bytes(b"SECRET=placeholder\n")
            with self.assertRaisesRegex(ValueError, "untracked_execution_config"):
                producer.assert_no_untracked_config(root, tracked)
            self.assertFalse(producer.generator_is_builtin_only(root, tracked))

    def test_tracked_real_env_file_gets_no_receipt(self):
        # A tracked .env, .env.local, .env.development (a name Bun loads by default), and a
        # root DIRECTORY named .env.example holding a tracked file.
        cases = [
            {".env": b"A=1\n"},
            {".env.local": b"A=1\n"},
            {".env.development": b"A=1\n"},
            {".env.example/inner.txt": b"A=1\n"},
        ]
        for files in cases:
            with self.subTest(files=sorted(files)):
                calls, output = self.run_order_fixture(False, files, set(files), expect_receipt=False)
                self.assertIn("BUNDLE_PROOF_UNAVAILABLE non_builtin_or_unadmitted_generator_config", output)
                self.assertNotIn("BUNDLE_PROOF_V1", output)
                self.assertEqual(calls, [["install", "--frozen-lockfile"]])

    # WO-HARNESS-BUNDLE-REVIEW-PROOF-REPAIR-01 D6: actions/checkout fetches the merge commit at
    # depth 1, and git hides a shallow commit's parents from %P.
    def test_depth_one_merge_checkout_gets_both_parents_and_one_receipt(self):
        self.assertIsNotNone(REAL_GIT, "real git is required on PATH")
        repo = Path(__file__).resolve().parents[2]
        setup = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"]

        def sh(cwd, *args):
            return subprocess.run([REAL_GIT, *setup, *args], cwd=cwd, check=True, capture_output=True).stdout.decode().strip()

        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            src = work / "src"
            src.mkdir()
            sh(src, "init", "-q", "-b", "dev")
            files = {
                "scripts/generate-bundled-defaults.ts": (repo / "scripts/generate-bundled-defaults.ts").read_text().encode(),
                "bunfig.toml": (repo / "bunfig.toml").read_text().encode(),
                "package.json": (repo / "package.json").read_text().encode(),
                producer.BUNDLE: b"bundle fixture\n",
                ".env.example": b"FOO=placeholder\n",
            }
            for relative, raw in files.items():
                (src / relative).parent.mkdir(parents=True, exist_ok=True)
                (src / relative).write_bytes(raw)
            sh(src, "add", "-A")
            sh(src, "commit", "-q", "-m", "start")
            sh(src, "checkout", "-q", "-b", "feature")
            (src / "feature.txt").write_bytes(b"feature\n")
            sh(src, "add", "-A")
            sh(src, "commit", "-q", "-m", "feature")
            head = sh(src, "rev-parse", "HEAD")
            sh(src, "checkout", "-q", "dev")
            (src / "dev.txt").write_bytes(b"dev\n")
            sh(src, "add", "-A")
            sh(src, "commit", "-q", "-m", "dev moves on")
            base = sh(src, "rev-parse", "HEAD")
            sh(src, "merge", "-q", "--no-ff", "feature", "-m", "merge")
            merge = sh(src, "rev-parse", "HEAD")
            clone = work / "clone"
            sh(work, "clone", "-q", "-c", "core.autocrlf=false", "--depth", "1", "--branch", "dev", src.as_uri(), str(clone))
            self.assertEqual(sh(clone, "rev-parse", "HEAD"), merge)
            self.assertEqual(sh(clone, "show", "-s", "--format=%P", "HEAD"), "")
            tracked = frozenset(files) | {"feature.txt", "dev.txt"}

            def real_git(root, *args):
                # subprocess.run is patched below (check_output uses it), so run git through Popen.
                process = subprocess.Popen([REAL_GIT, "-C", str(root), *args], stdout=subprocess.PIPE)
                out, _ = process.communicate()
                if process.returncode:
                    raise subprocess.CalledProcessError(process.returncode, args)
                return out

            runner = work / "runner"
            runner.mkdir()
            event = work / "event.json"
            event.write_text(json.dumps({"number": 1619, "pull_request": {"head": {"sha": head}, "base": {"sha": base}}}))
            data = self.archive()
            output = io.StringIO()
            calls = []
            original_read = Path.read_bytes
            tools = {Path("/usr/bin/git"), Path(os.path.realpath("/usr/bin/python3"))}
            with patch.object(producer.platform, "system", return_value="Linux"), \
                 patch.object(producer.platform, "machine", return_value="x86_64"), \
                 patch.object(producer.urllib.request, "urlopen", return_value=io.BytesIO(data)), \
                 patch.object(producer, "ARCHIVE_SHA256", hashlib.sha256(data).hexdigest()), \
                 patch.object(producer, "verified_checkout", return_value=("tree", tracked)), \
                 patch.object(producer, "git", side_effect=real_git), \
                 patch.object(producer.shutil, "which", side_effect=lambda *a, **k: str(next(runner.glob("bundle-proof-*/bin/bun")))), \
                 patch.object(producer.subprocess, "run", side_effect=lambda argv, **k: calls.append(argv[1:])), \
                 patch.object(Path, "read_bytes", lambda p: b"trusted managed tool" if p in tools else original_read(p)), \
                 patch.dict(os.environ, {"RUNNER_TEMP": str(runner), "GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(event), "GITHUB_PATH": str(work / "path-output"), "GITHUB_REPOSITORY": "thinmansoftware/bdc-harness", "GITHUB_RUN_ID": "10", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_WORKFLOW_SHA": merge, "GITHUB_WORKFLOW_REF": "workflow", "ImageOS": "ubuntu", "ImageVersion": "fixture"}), \
                 contextlib.redirect_stdout(output):
                producer.run_producer(clone)
                parents = producer.merge_parents(clone)
            self.assertEqual(parents, [base, head])
            lines = [line for line in output.getvalue().splitlines() if line.startswith("BUNDLE_PROOF_V1 ")]
            self.assertEqual(len(lines), 1)
            receipt = json.loads(base64.b64decode(lines[0].split(" ", 1)[1]))
            self.assertEqual((receipt["base"], receipt["head"], receipt["checkout"]), (base, head, merge))
            self.assertEqual(calls, [["run", "scripts/generate-bundled-defaults.ts", "--check"], ["install", "--frozen-lockfile"]])

            raw = real_git(clone, "--no-replace-objects", "cat-file", "commit", "HEAD")
            def answering(obj, head_sha):
                return lambda _root, *args: obj if "cat-file" in args else head_sha.encode()
            with patch.object(producer, "git", side_effect=answering(raw, "f" * 40)):
                with self.assertRaisesRegex(ValueError, "commit_object_mismatch"):
                    producer.merge_parents(clone)
            upper = raw.replace(b"parent " + head.encode(), b"parent " + head.upper().encode(), 1)
            upper_sha = hashlib.sha1(b"commit " + str(len(upper)).encode() + b"\0" + upper).hexdigest()
            with patch.object(producer, "git", side_effect=answering(upper, upper_sha)):
                with self.assertRaisesRegex(ValueError, "unsupported_commit_parent"):
                    producer.merge_parents(clone)

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
                self.assertFalse(check(root, frozenset()))
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
                 patch.object(producer, "verified_checkout", return_value=("tree", frozenset())), \
                 patch.object(producer, "generator_is_builtin_only", return_value=True, create=True), \
                 patch.object(producer, "git", side_effect=fake_git(*synthetic_merge("b" * 40, "a" * 40))), \
                 patch.object(producer.shutil, "which", side_effect=lambda *a, **k: str(next(root.glob("bundle-proof-*/bin/bun")))), \
                 patch.object(producer.subprocess, "run", side_effect=run), \
                 patch.dict(os.environ, {"RUNNER_TEMP": d}):
                with self.assertRaisesRegex(ValueError, "runtime_mutated"):
                    producer.run_producer(root)
            self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
