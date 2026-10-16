"""Ensure diagnostic cleanup never unloads a profile with an unremoved user."""
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

class CleanupTests(unittest.TestCase):
    def exercise(self, owned=True, removal_succeeds=True):
        name = "teetime-probe-audit-123-1"
        commands = []
        remaining = True
        def execute(argv, **kwargs):
            nonlocal remaining
            commands.append(argv)
            if argv[:3] == ["docker", "ps", "-aq"]:
                return subprocess.CompletedProcess(argv, 0, "abc\n" if remaining else "", "")
            if argv[:2] == ["docker", "inspect"]:
                item = {"Id": "abc", "Name": "/teetime-sandbox-probe-123456789abc",
                        "AppArmorProfile": name, "HostConfig": {"SecurityOpt": []},
                        "Config": {"Labels": {"teetime.audit-profile": name if owned else "other"}}}
                return subprocess.CompletedProcess(argv, 0, json.dumps([item]), "")
            if argv[:3] == ["docker", "rm", "-f"]:
                remaining = not removal_succeeds
                return subprocess.CompletedProcess(argv, 0 if removal_succeeds else 1, "", "")
            if argv[:3] == ["sudo", "apparmor_parser", "-R"]:
                self.assertFalse(remaining, "unloaded profile while still used")
                return subprocess.CompletedProcess(argv, 0, "", "")
            raise AssertionError("unexpected command")
        with tempfile.TemporaryDirectory() as temp:
            source = str(Path(temp) / name)
            with patch("subprocess.run", side_effect=execute), patch.dict("os.environ", {"RUNNER_TEMP": temp}), patch("sys.argv", ["cleanup", name, source]):
                if owned and removal_succeeds:
                    runpy.run_path(str(Path(__file__).with_name("cleanup-apparmor-audit.py")))
                else:
                    with self.assertRaises(SystemExit):
                        runpy.run_path(str(Path(__file__).with_name("cleanup-apparmor-audit.py")))
        return commands

    def test_owned_container_removed_before_unload(self):
        commands = self.exercise()
        self.assertTrue(any(cmd[:3] == ["sudo", "apparmor_parser", "-R"] for cmd in commands))

    def test_unowned_container_retains_profile(self):
        commands = self.exercise(owned=False)
        self.assertFalse(any(cmd[0] == "sudo" or cmd[:2] == ["docker", "rm"] for cmd in commands))

    def test_failed_removal_retains_profile(self):
        commands = self.exercise(removal_succeeds=False)
        self.assertFalse(any(cmd[0] == "sudo" for cmd in commands))

if __name__ == "__main__":
    unittest.main()
