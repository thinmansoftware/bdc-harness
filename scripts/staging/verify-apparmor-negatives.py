"""Require both specifically scoped kernel denial records; errno alone is insufficient."""
from pathlib import Path
import re
import sys
profile, log = sys.argv[1:]
if not re.fullmatch(r'teetime-probe-mount-[0-9]+-[0-9]+', profile):
    raise SystemExit('unowned profile')
lines = [line for line in Path(log).read_text().splitlines()
         if 'apparmor="DENIED"' in line and 'operation="mount"' in line
         and ('profile="' + profile + '"') in line and 'comm="teetime-neg"' in line
         and 'fstype="tmpfs"' in line and 'srcname="tmpfs"' in line]
required = [('/protected/negative-mount/', 'rw, nosuid, nodev'), ('/tmp/', 'rw, nosuid, noexec')]
for destination, flags in required:
    matches = [line for line in lines if ('name="' + destination + '"') in line
               and ('flags="' + flags + '"') in line]
    if len(matches) != 1:
        raise SystemExit('missing or ambiguous AppArmor negative audit for ' + destination)
    print(matches[0])
print('Both scoped AppArmor negative records verified')
