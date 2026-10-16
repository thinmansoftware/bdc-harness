"""Assert isolation without emitting Docker environment values or credentials."""
import json
import subprocess
import sys

container, expected_sha, project = sys.argv[1:4]
result = subprocess.run(["docker", "inspect", container], capture_output=True, text=True, check=True)
data = json.loads(result.stdout)[0]
host = data["HostConfig"]
config = data["Config"]
assert data["Name"] == "/" + container, "container identity mismatch"
assert host["NetworkMode"] == "none", "network enabled"
assert host["ReadonlyRootfs"] is True, "writable root"
assert config["User"] == "1001:1001", "unexpected UID"
assert "ALL" in host["CapDrop"], "capabilities not dropped"
assert not host.get("CapAdd"), "capabilities added"
assert not host.get("Privileged"), "privileged container"
assert "no-new-privileges:true" in host["SecurityOpt"], "privilege escalation allowed"
assert not host.get("PortBindings"), "published ports"
assert not host.get("Devices"), "host devices"
assert not host.get("PidMode"), "shared PID namespace"
assert host["RestartPolicy"]["Name"] == "no", "automatic restart"
assert set(data["NetworkSettings"]["Networks"]) <= {"none"}, "external network attached"
assert config["Entrypoint"] == ["bun", "packages/server/src/index.ts"], "entrypoint mismatch"
assert config["Labels"]["com.docker.compose.project"] == project, "project mismatch"
environment = dict(item.split("=", 1) for item in config["Env"] if "=" in item)
assert environment.get("ARCHON_BUILD_SHA") == expected_sha, "image source SHA mismatch"
assert environment.get("ARCHON_OFFLINE_QUALIFICATION") == "1", "offline mode missing"
mounts = data["Mounts"]
assert {mount["Destination"] for mount in mounts} == {"/.archon", "/tmp", "/home/appuser", "/host-artifacts"}, "unexpected mount set"
for mount in mounts:
    if mount["Destination"] == "/.archon":
        assert mount["Type"] == "volume", "database is not isolated volume"
        assert mount["Name"] == project + "_qualification-data", "shared database volume"
    else:
        assert mount["Type"] == "tmpfs", "persistent provider home or artifacts"
assert data["State"]["Health"]["Status"] == "healthy", "container unhealthy"
print(json.dumps({"passed": True, "container": container, "project": project,
    "sourceSha": expected_sha, "imageId": data["Image"], "network": "none",
    "readOnlyRoot": True, "user": config["User"], "ports": [],
    "mounts": [{"type": m["Type"], "destination": m["Destination"]} for m in mounts]}))
