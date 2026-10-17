"""Unload an owned diagnostic profile only after all its containers are gone."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

name, source = sys.argv[1:]
if not re.fullmatch(r"teetime-probe-(audit|mount)-[0-9]+-[0-9]+", name):
    raise SystemExit("invalid diagnostic profile identity")
path = Path(source).resolve()
if path.name != name or path.parent != Path(os.environ["RUNNER_TEMP"]).resolve():
    raise SystemExit("invalid diagnostic profile path")

def using_profile():
    ids = subprocess.run(["docker", "ps", "-aq"], capture_output=True, text=True,
                         timeout=30, check=True).stdout.split()
    if not ids:
        return []
    result = subprocess.run(["docker", "inspect", *ids], capture_output=True, text=True,
                            timeout=30, check=True)
    return [item for item in json.loads(result.stdout)
            if item.get("AppArmorProfile") == name or
            "apparmor=" + name in item["HostConfig"].get("SecurityOpt", [])]

for item in using_profile():
    if (item["Config"].get("Labels", {}).get("teetime.audit-profile") != name or
            not re.fullmatch(r"/teetime-sandbox-probe-[0-9a-f]{12}", item["Name"])):
        raise SystemExit("unowned profile user remains; retain profile: " + item["Name"])
    result = subprocess.run(["docker", "rm", "-f", item["Id"]], capture_output=True,
                            text=True, timeout=30)
    if result.returncode:
        raise SystemExit("container cleanup failed; retain profile: " + item["Name"])
remaining = using_profile()
if remaining:
    raise SystemExit("profile still in use; retain profile: " + name)
subprocess.run(["sudo", "apparmor_parser", "-R", str(path)], check=True, timeout=30)
