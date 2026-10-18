"""Recheck private visibility and the exact private file. Never echo file data."""
import argparse
import json
from teetime_startup_control import require_private_context, verify_startup_identity
from teetime_startup_packet import read_private_metadata


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',required=True)
    parser.add_argument('--owner',required=True)
    args=parser.parse_args()
    require_private_context(args.root,args.owner)
    metadata=read_private_metadata(args.root,args.owner)
    verify_startup_identity(metadata)
    print(json.dumps(metadata))


if __name__=='__main__': main()
