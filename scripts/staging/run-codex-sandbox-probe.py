"""Run synthetic, non-model sandbox qualification in an inspected disposable container."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid


def main():
    if not __debug__:
        raise RuntimeError("Python optimization disables required safety assertions")
    parser = argparse.ArgumentParser()
    parser.add_argument("--docker", default="docker")
    parser.add_argument("--image", required=True)
    parser.add_argument("--expected-sha", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    profile = root / "codex-probe-seccomp.json"
    baseline = json.loads((root / "moby-default-seccomp.json").read_text())
    candidate = json.loads(profile.read_text())
    inventory = json.loads((root / "codex-probe-minimization.json").read_text())
    assert len(inventory) == 12 and all(item["removed"] is False for item in inventory)
    assert candidate == {**baseline, "syscalls": baseline["syscalls"] +
                         [item["rule"] for item in inventory]}, "unreviewed seccomp delta"
    source = (root / "probe-codex-sandbox.ts").read_bytes()
    name = "teetime-sandbox-probe-" + uuid.uuid4().hex[:12]
    temporary = {"/tmp", "/home/appuser", "/workspace", "/protected"}

    def docker(*parts, **kwargs):
        return subprocess.run([args.docker, *parts], capture_output=True,
                              text=True, timeout=120, **kwargs)

    options = ["create", "-i", "--name", name, "--network", "none", "--read-only",
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
               "--security-opt", "seccomp=" + str(profile), "--user", "1001:1001",
               "--workdir", "/workspace", "--env", "HOME=/home/appuser",
               "--env", "TEE_TIME_SANDBOX_PROBE=1", "--entrypoint", "bun"]
    for path in sorted(temporary):
        options.extend(["--tmpfs", path + ":uid=1001,gid=1001"])
    options.extend([args.image, "run", "-"])
    try:
        created = docker(*options)
        if created.returncode:
            raise RuntimeError("disposable probe container creation failed")
        inspected = docker("inspect", name, check=True)
        data = json.loads(inspected.stdout)[0]
        host, config = data["HostConfig"], data["Config"]
        assert data["Name"] == "/" + name
        assert host["NetworkMode"] == "none" and host["ReadonlyRootfs"]
        assert not host.get("Privileged") and not host.get("CapAdd")
        assert "ALL" in host["CapDrop"]
        assert "no-new-privileges:true" in host["SecurityOpt"]
        seccomp = [item for item in host["SecurityOpt"] if item.startswith("seccomp=")]
        assert len(seccomp) == 1 and json.loads(seccomp[0][8:]) == candidate
        assert not host.get("PortBindings") and not host.get("Devices")
        assert not host.get("PidMode") and not host.get("Binds")
        assert not data["Mounts"], "unexpected persistent mount"
        assert set(host["Tmpfs"]) == temporary
        assert config["User"] == "1001:1001" and config["WorkingDir"] == "/workspace"
        assert config["Entrypoint"] == ["bun"] and config["Cmd"] == ["run", "-"]
        environment = dict(item.split("=", 1) for item in config["Env"] if "=" in item)
        assert environment.get("ARCHON_BUILD_SHA") == args.expected_sha
        assert environment.get("TEE_TIME_SANDBOX_PROBE") == "1"
        result = docker("start", "-ai", name, input=source.decode("utf-8"))
        # Never print arbitrary container output or inherited image environment.
        if result.returncode:
            stopped = json.loads(docker("inspect", name, check=True).stdout)[0]
            print(json.dumps({"probeFailureBoundary": {
                "imageId": data["Image"], "apparmor": stopped.get("AppArmorProfile"),
                "pid": stopped["State"]["Pid"], "containerId": stopped["Id"],
                "network": host["NetworkMode"], "readOnlyRoot": host["ReadonlyRootfs"],
                "user": config["User"], "capDrop": host["CapDrop"],
                "profileSha256": hashlib.sha256(profile.read_bytes()).hexdigest()}}), flush=True)
            # Synthetic probe only: emit its bounded assertion header, not raw output.
            diagnostic = next((line[:500] for line in result.stderr.splitlines()
                               if line.startswith("error: ")), "no probe assertion header")
            raise RuntimeError("sandbox assertions failed; exit=" + str(result.returncode)
                               + "; " + diagnostic)
        evidence = json.loads(result.stdout.strip())
        assert evidence["passed"] is True and evidence["modelInvocations"] == 0
        print(json.dumps({"passed": True, "imageId": data["Image"],
                          "sourceSha": args.expected_sha,
                          "profileSha256": hashlib.sha256(profile.read_bytes()).hexdigest(),
                          "probeSha256": hashlib.sha256(source).hexdigest(),
                          "probe": evidence}))
    finally:
        remaining = docker("container", "ls", "-aq", "--filter", "name=^/" + name + "$")
        if remaining.returncode:
            raise RuntimeError("could not verify probe cleanup for " + name)
        if remaining.stdout.strip() and docker("rm", "-f", name).returncode:
            raise RuntimeError("probe cleanup failed for " + name)


if __name__ == "__main__":
    main()
