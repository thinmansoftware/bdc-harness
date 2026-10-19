"""Credential-free checks for the closed supervised minimal diagnostic branch."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from teetime_artifact_contract import canonical
from teetime_joined_fixture import strict_json
from teetime_minimal_execution import parse_minimal_execution
from teetime_minimal_protocol import diagnostic_hashes, validate_diagnostic_ready, validate_diagnostic_report
from teetime_successor_observation import frozen_file


def check(root, package_hash, mode, raw=b''):
    if mode not in ('metadata','predecessor','ready','report'):
        raise ValueError('closed minimal controller mode required')
    root=Path(root)
    package=frozen_file(root/'minimal-execution.json','sha256:'+package_hash,32768)
    execution=parse_minimal_execution(package,package_hash)
    hashes=diagnostic_hashes(root/'scripts/staging',execution.source,execution.base_source)
    if hashes != dict(execution.selected_hashes):
        raise ValueError('measured minimal helper inventory differs')
    if mode in ('metadata','predecessor'):
        if raw:raise ValueError('unexpected diagnostic check input')
        if mode=='predecessor':
            from teetime_successor_observation import observe_minimal_local
            return observe_minimal_local(root.parent,execution)
        return {'packageHash':execution.package_hash,'preparedBindingHash':execution.prepared_binding_hash,
            'authorityHash':execution.authority_hash,'runPolicyHash':execution.run_policy_hash,
            'providerPolicyHash':execution.provider_policy_hash,'runId':execution.run_id,
            'image':execution.image,'source':execution.source,'baseSource':execution.base_source,
            'operatorInputHash':execution.operator_input_hash,
            'predecessors':[dict(item) for item in execution.predecessors]}
    # Wrapper adds delimiters to two protocol lines, each independently <=32768.
    if type(raw) is not bytes or not 1 <= len(raw) <= 65600 or not raw.isascii():
        raise ValueError('bounded minimal controller check input required')
    value=strict_json(raw)
    if mode=='report' and (type(value) is not dict or set(value)!= {'ready','report','exitCode'}):
        raise ValueError('closed minimal report wrapper required')
    ready=value if mode=='ready' else value['ready']
    validate_diagnostic_ready(ready,nonce=ready['nonce'],image=execution.image,
        base_source=execution.base_source,source=execution.source,hashes=hashes)
    if mode=='ready':return {'readyVerified':True}
    report=validate_diagnostic_report(canonical(value['report']).encode('ascii'),value['exitCode'],ready=ready)
    outcome=report['result'];worker=outcome['workerResult']
    task=worker['taskReceipt'] if worker else None
    return {'passed':outcome['passed'],'cleanupVerified':outcome['cleanupVerified'],
        'proxyMetricsVerified':outcome['proxyMetricsVerified'],
        'modelInvocations':task['modelInvocations'] if task else None}


class SilentParser(argparse.ArgumentParser):
    def error(self,message):raise ValueError('closed controller arguments required')


if __name__=='__main__':
    try:
        parser=SilentParser(add_help=False)
        parser.add_argument('mode',choices=['metadata','predecessor','ready','report'])
        parser.add_argument('package_hash')
        args=parser.parse_args()
        raw=sys.stdin.buffer.read(65601) if args.mode in ('ready','report') else b''
        value=check(Path(__file__).resolve().parents[2],args.package_hash,args.mode,raw)
        sys.stdout.write(json.dumps(value,sort_keys=True,separators=(',',':')))
    except Exception:
        raise SystemExit(1) from None
