"""CI-cancellation cleanup restricted to one exact reviewer fixture owner label."""
import argparse
import subprocess
from teetime_reviewer_probe import reviewer_settings, remove_owned_reviewer
from teetime_startup_control import startup_settings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--owner', required=True)
    parser.add_argument('--startup', action='store_true')
    args = parser.parse_args()
    if args.startup: startup_settings(args.owner)
    else: reviewer_settings('positive', args.owner)

    def docker(*parts):
        return subprocess.run(['docker', *parts], capture_output=True, text=True, timeout=15)

    label='teetime.startup-fixture' if args.startup else 'teetime.reviewer-fixture'
    inventory = docker('container','ls','-a','--filter','label='+label+'='+args.owner,
                       '--format','{{.Names}}')
    if inventory.returncode or len(inventory.stdout) > 4096:
        raise RuntimeError('reviewer owner inventory failed')
    names = inventory.stdout.splitlines()
    if len(names) > (1 if args.startup else 4):
        raise RuntimeError('reviewer owner inventory exceeded finite cases')
    for name in names:
        remove_owned_reviewer(docker, name, args.owner, startup=args.startup)
    print('Owned reviewer fixture containers verified absent')


if __name__ == '__main__':
    main()
