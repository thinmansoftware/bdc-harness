"""Controlled runtime producer for the admitted review-bundle proof."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import tempfile
import urllib.request
import zipfile

ARCHIVE_SHA256 = "8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed"
ARCHIVE_URL = "https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-linux-x64.zip"
BUNDLE = "packages/workflows/src/defaults/bundled-defaults.generated.ts"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unpack_verified(data, expected, destination):
    # No extraction, directory creation or executable invocation before this gate.
    if not re.fullmatch(r"[0-9a-f]{64}", expected) or digest(data) != expected:
        raise ValueError("archive_digest_mismatch")
    if destination.exists():
        raise ValueError("runtime_location_not_fresh")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        files = [e for e in entries if not e.is_dir()]
        if len(files) != 1 or files[0].filename != "bun-linux-x64/bun":
            raise ValueError("unsupported_archive_layout")
        if any(e.filename != "bun-linux-x64/" for e in entries if e.is_dir()):
            raise ValueError("unsupported_archive_directory")
        item = files[0]
        mode = item.external_attr >> 16
        if stat.S_IFMT(mode) != stat.S_IFREG or item.file_size > 200_000_000:
            raise ValueError("unsupported_archive_mode_or_size")
        executable = archive.read(item)
    destination.mkdir(mode=0o700)
    path = destination / "bun"
    with path.open("xb") as stream:
        stream.write(executable)
    path.chmod(0o555)
    return path


def assert_runtime(path, expected):
    if path.is_symlink() or not path.is_file() or digest(path.read_bytes()) != expected:
        raise ValueError("runtime_mutated")


def git(root, *args):
    return subprocess.check_output(["/usr/bin/git", "-C", str(root), *args])


def assert_no_untracked_config(root, tracked):
    # Newly introduced effective runtime/install/preload config must not be invisible.
    config_names = {"bunfig.toml", ".bunfig.toml", ".npmrc", ".gitattributes", "package.json", "tsconfig.json"}
    for directory, children, names in os.walk(root, followlinks=False):
        children[:] = [c for c in children if c not in {".git", "node_modules"}]
        for name in names:
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            if name in config_names or name.startswith(".env") or relative.startswith((".archon/commands/defaults/", ".archon/workflows/defaults/", "harness/policies/", "scripts/lane/")):
                if path.relative_to(root).as_posix() not in tracked:
                    raise ValueError("untracked_execution_config")


def verified_checkout(root):
    entries = git(root, "ls-tree", "-rz", "--full-tree", "HEAD").split(b"\0")
    tracked = set()
    for entry in entries:
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, kind, oid = metadata.decode("ascii").split()
        path = raw_path.decode("utf8", errors="strict")
        disk = root / path
        if mode not in {"100644", "100755"} or kind != "blob" or disk.is_symlink() or not stat.S_ISREG(disk.lstat().st_mode):
            raise ValueError("unsupported_checkout_entry")
        raw = disk.read_bytes()
        actual = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        if actual != oid or bool(disk.stat().st_mode & 0o111) != (mode == "100755"):
            raise ValueError("checkout_mutated_or_transformed")
        tracked.add(path)
    assert_no_untracked_config(root, tracked)
    return git(root, "rev-parse", "HEAD^{tree}").decode().strip()


def run_producer(root):
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("unsupported_runtime_platform")
    for _, children, _ in os.walk(root, followlinks=False):
        children[:] = [c for c in children if c != ".git"]
        if "node_modules" in children:
            raise ValueError("preexisting_dependency_cache")
    # A fresh private HOME prevents inherited user runtime/npm/preload configuration.
    home = Path(tempfile.mkdtemp(prefix="bundle-proof-", dir=os.environ["RUNNER_TEMP"]))
    with urllib.request.urlopen(ARCHIVE_URL, timeout=60) as response:
        archive = response.read(50_000_001)
    if len(archive) > 50_000_000:
        raise ValueError("archive_too_large")
    executable = unpack_verified(archive, ARCHIVE_SHA256, home / "bin")
    runtime_sha = digest(executable.read_bytes())
    # Node is part of the explicitly trusted managed runner toolchain, not a PR runtime.
    # Husky's frozen prepare entry uses its shebang even with HUSKY=0.
    node = shutil.which("node")
    if not node:
        raise ValueError("runner_node_unavailable")
    node_bytes = Path(os.path.realpath(node)).read_bytes()
    controlled_node = executable.parent / "node"
    controlled_node.write_bytes(node_bytes)
    controlled_node.chmod(0o555)
    node_sha = digest(node_bytes)
    initial_tree = verified_checkout(root)
    checkout = git(root, "rev-parse", "HEAD").decode().strip()
    parents = git(root, "show", "-s", "--format=%P", "HEAD").decode().strip().split()
    env = {
        "PATH": str(executable.parent) + ":/usr/bin:/bin",
        "HOME": str(home), "BUN_INSTALL": str(home), "CI": "true",
        "HUSKY": "0", "LANG": "C.UTF-8",
    }
    # HUSKY=0 is explicit producer delta: install must not create executable Git hooks.
    for args in [["install", "--frozen-lockfile"], ["run", "check:bundled"]]:
        assert_runtime(executable, runtime_sha)
        assert_runtime(controlled_node, node_sha)
        if shutil.which("bun", path=env["PATH"]) != str(executable):
            raise ValueError("shadowed_runtime")
        if verified_checkout(root) != initial_tree:
            raise ValueError("input_tree_changed")
        if git(root, "rev-parse", "HEAD").decode().strip() != checkout:
            raise ValueError("checkout_changed")
        subprocess.run([str(executable), *args], cwd=root, env=env, check=True)
        assert_runtime(executable, runtime_sha)
        assert_runtime(controlled_node, node_sha)
        for directory, _, names in os.walk(root / "node_modules", followlinks=False):
            if Path(directory).name == ".bin" and any(n in names for n in ("bun", "bunx")):
                raise ValueError("dependency_shadowed_runtime")
        if verified_checkout(root) != initial_tree:
            raise ValueError("input_tree_changed")
        if git(root, "rev-parse", "HEAD").decode().strip() != checkout:
            raise ValueError("checkout_changed")
    raw_bundle = (root / BUNDLE).read_bytes()
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request" and b"\r" not in raw_bundle:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        pr = event["pull_request"]
        if parents != [pr["base"]["sha"], pr["head"]["sha"]]:
            raise ValueError("tested_merge_parents_mismatch")
        proof = {
            "schema": 1, "repository": os.environ["GITHUB_REPOSITORY"],
            "run": int(os.environ["GITHUB_RUN_ID"]), "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
            "pr": event["number"], "head": pr["head"]["sha"], "base": pr["base"]["sha"],
            "checkout": checkout, "tree": initial_tree, "archive": ARCHIVE_SHA256,
            "runtime": runtime_sha, "bundle": digest(raw_bundle), "platform": "linux-x64",
            "image": os.environ.get("ImageOS", ""), "imageVersion": os.environ.get("ImageVersion", ""),
            "workflow": os.environ["GITHUB_WORKFLOW_SHA"], "workflowRef": os.environ["GITHUB_WORKFLOW_REF"],
            "python": platform.python_version(), "git": git(root, "--version").decode().strip(),
            "pythonSha256": digest(Path(os.path.realpath("/usr/bin/python3")).read_bytes()),
            "gitSha256": digest(Path("/usr/bin/git").read_bytes()),
            "nodeSha256": node_sha,
        }
        print("BUNDLE_PROOF_V1 " + base64.b64encode(json.dumps(proof, sort_keys=True).encode()).decode(), flush=True)
    elif b"\r" in raw_bundle:
        print("BUNDLE_PROOF_UNAVAILABLE raw_bundle_not_LF", flush=True)
    # Subsequent ordinary tests use the same verified executable; proof covers install/check only.
    with open(os.environ["GITHUB_PATH"], "a") as stream:
        stream.write(str(executable.parent) + "\n")


if __name__ == "__main__":
    run_producer(Path.cwd())
