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
# Approved anchor generator has exactly fs/promises and path built-in imports.
# Exact source admission, rather than a permissive source-text import parser,
# rejects new static/dynamic imports and transitive repository modules alike.
BUILTIN_GENERATOR_SHA256 = "9cc028a6a440036c50aabd14dc385cabfa5d32520ea882779371863499c24220"
BUILTIN_BUNFIG_SHA256 = "213d5743d063c71efa683a4202997ebdcc53cdd90eacd1c5bdee54a540daecb3"
BUILTIN_PACKAGE_SHA256 = "1d95004005d3d8a59a6079e93bd811dbe9339a2c8718b90b8162f6650d9b8add"


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
            # Git paths/hashes/modes only: never print source, config or environment values.
            raise ValueError("checkout_mutated_or_transformed " + json.dumps({
                "path": path, "blob_matches": actual == oid, "expected_blob": oid,
                "actual_blob": actual, "expected_mode": mode,
                "actual_mode": oct(stat.S_IMODE(disk.stat().st_mode)),
            }, sort_keys=True))
        tracked.add(path)
    assert_no_untracked_config(root, tracked)
    return git(root, "rev-parse", "HEAD^{tree}").decode().strip()


def generator_is_builtin_only(root):
    try:
        return (digest((root / "scripts/generate-bundled-defaults.ts").read_bytes()) == BUILTIN_GENERATOR_SHA256
                and digest((root / "bunfig.toml").read_bytes()) == BUILTIN_BUNFIG_SHA256
                and digest((root / "package.json").read_bytes()) == BUILTIN_PACKAGE_SHA256
                and not (root / ".bunfig.toml").exists()
                and not any(root.glob(".env*")))
    except OSError:
        return False


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
    # The only repository code allowed before proof is the exact admitted,
    # built-in-only generator. Direct invocation avoids root package lifecycle hooks.
    eligible_generator = generator_is_builtin_only(root)
    if eligible_generator:
        assert_runtime(executable, runtime_sha)
        assert_runtime(controlled_node, node_sha)
        if shutil.which("bun", path=env["PATH"]) != str(executable):
            raise ValueError("shadowed_runtime")
        if verified_checkout(root) != initial_tree:
            raise ValueError("input_tree_changed")
        if git(root, "rev-parse", "HEAD").decode().strip() != checkout:
            raise ValueError("checkout_changed")
        subprocess.run([str(executable), "run", "scripts/generate-bundled-defaults.ts", "--check"], cwd=root, env=env, check=True)
        assert_runtime(executable, runtime_sha)
        assert_runtime(controlled_node, node_sha)
        if verified_checkout(root) != initial_tree:
            raise ValueError("input_tree_changed")
        if git(root, "rev-parse", "HEAD").decode().strip() != checkout:
            raise ValueError("checkout_changed")
    raw_bundle = (root / BUNDLE).read_bytes() if eligible_generator else b""
    if eligible_generator and os.environ.get("GITHUB_EVENT_NAME") == "pull_request" and b"\r" not in raw_bundle:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        pr = event["pull_request"]
        if parents != [pr["base"]["sha"], pr["head"]["sha"]]:
            raise ValueError("tested_merge_parents_mismatch")
        proof = {
            "schema": 1, "repository": os.environ["GITHUB_REPOSITORY"],
            "phase": "preinstall", "dependenciesInstalled": False, "generator": BUILTIN_GENERATOR_SHA256,
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
    elif not eligible_generator:
        print("BUNDLE_PROOF_UNAVAILABLE non_builtin_or_unadmitted_generator_config", flush=True)
    elif b"\r" in raw_bundle:
        print("BUNDLE_PROOF_UNAVAILABLE raw_bundle_not_LF", flush=True)
    # Receipt is already complete. Installation and ordinary CI are outside the
    # equality-proof interval. Never retry or produce another receipt after install.
    subprocess.run([str(executable), "install", "--frozen-lockfile"], cwd=root, env=env, check=True)
    assert_runtime(executable, runtime_sha)
    assert_runtime(controlled_node, node_sha)
    for directory, _, names in os.walk(root / "node_modules", followlinks=False):
        if Path(directory).name == ".bin" and any(n in names for n in ("bun", "bunx")):
            raise ValueError("dependency_shadowed_runtime")
    # Subsequent ordinary tests use the same verified executable.
    with open(os.environ["GITHUB_PATH"], "a") as stream:
        stream.write(str(executable.parent) + "\n")


if __name__ == "__main__":
    run_producer(Path.cwd())
