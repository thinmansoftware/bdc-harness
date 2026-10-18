"""Real SDK/CLI/provider, synthetic loopback responses; no model/provider access."""
import gzip
import hashlib
import http.server
import io
import json
import os
import queue
from pathlib import Path
import sys
import threading

sys.path.insert(0, '/app/scripts/staging')
from teetime_artifact_contract import parse_artifact
from teetime_bounded_process import capture
from teetime_fixture_diagnostics import DiagnosticProtocol
from teetime_snapshot import SnapshotFile, snapshot_manifest

if not __debug__ or os.getuid() != 1001 or sys.argv[1:] not in [['success'], ['duplicate']]:
    raise SystemExit('invalid fixed artifact fixture')
case = sys.argv[1]
os.chdir('/workspace')
home = Path('/home/appuser/.codex')
if home.exists():
    raise SystemExit('fixture HOME must start empty')
home.mkdir(mode=0o700)
auth = home/'auth.json'
original = b'{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-auth-fixture"}'
auth.write_bytes(original)
auth.chmod(0o600)
base = (SnapshotFile('README.md', '100644', b'trusted fixture base\n'),)
policy = Path('/app/packages/providers/src/codex/restricted-policy.ts').read_bytes()
binding = {'runId': 'artifact-fixture-run', 'nodeId': 'implement', 'attempt': 1,
    'authorityHash': 'sha256:'+'a'*64, 'policyHash': 'sha256:'+hashlib.sha256(policy).hexdigest(),
    'baseManifestHash': hashlib.sha256(snapshot_manifest(base).encode()).hexdigest()}
content = '<p>synthetic-artifact-ready</p>\n'
artifact = json.dumps({'version': 1, 'binding': binding, 'operations': [
    {'action': 'write', 'path': 'index.html', 'baseHash': None, 'mode': '100644', 'content': content}]},
    sort_keys=True, separators=(',', ':'))
state = {'requests': 0, 'websocketUpgradeAttempts': 0, 'errors': [], 'modelVerified': False}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == '/v1/responses' and self.headers.get('Upgrade', '').lower() == 'websocket':
            state['websocketUpgradeAttempts'] += 1
        else:
            if len(state['errors']) < 8:
                state['errors'].append('unexpected_get')
        self.send_response(404)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True

    def do_POST(self):
        try:
            self.connection.settimeout(5)
            state['requests'] += 1
            if state['requests'] != 1 or self.path != '/v1/responses':
                raise ValueError('unexpected_request')
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 1048576 or self.headers.get('Transfer-Encoding'):
                raise ValueError('request_bound')
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError('request_incomplete')
            encoding = self.headers.get('Content-Encoding', 'identity')
            if encoding == 'gzip':
                body = gzip.GzipFile(fileobj=io.BytesIO(body)).read(1048577)
            elif encoding != 'identity':
                raise ValueError('request_encoding')
            if len(body) > 1048576:
                raise ValueError('decoded_request_bound')
            request = json.loads(body)
            if request.get('model') != 'gpt-5.6-sol' or request.get('stream') is not True:
                raise ValueError('request_model')
            state['modelVerified'] = True
            # Exact pinned responses.rs::ev_assistant_message representation.
            events = [{'type': 'response.output_item.done', 'item': {
                'type': 'message', 'role': 'assistant', 'id': 'artifact-message-'+str(index),
                'content': [{'type': 'output_text', 'text': artifact}]}}
                for index in range(2 if case == 'duplicate' else 1)]
            events.append({'type': 'response.completed', 'response': {'id': 'artifact-response', 'usage': {
                'input_tokens': 0, 'input_tokens_details': None, 'output_tokens': 0,
                'output_tokens_details': None, 'total_tokens': 0}}})
            data = ''.join('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n' for event in events).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            if len(state['errors']) < 8:
                state['errors'].append('request_rejected')
            self.send_error(400)


server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
server_thread = threading.Thread(target=server.serve_forever, daemon=True)
server_thread.start()
url = 'http://127.0.0.1:'+str(server.server_address[1])+'/v1'
code = r'''
const emit=process.stdout.write.bind(process.stdout);
let intercepted=0,threads=0,optionsVerified=false,threadOptionsVerified=false,importIntercepted=false;
let accepted=false,bytesBase64=null,lifecycle=null;
let phase='logger',errorName=null,errorCode=null;
function mark(next){phase=next;emit(JSON.stringify({kind:'phase',phase})+'\n');}
const counts={};
const controller=new AbortController();
const timer=setTimeout(()=>{if(!lifecycle||!lifecycle.closed)controller.abort();},25000);
try {
 mark('logger');
 const {rootLogger}=await import('/app/packages/paths/src/logger.ts');
 rootLogger.level='silent';
 console.log=console.info=console.warn=console.error=console.debug=()=>{};
 mark('resolve');
 const {isDeepStrictEqual}=await import('node:util');
 const {mock}=await import('bun:test');
 const sdkPath=import.meta.resolve('@openai/codex-sdk','file:///app/packages/providers/src/codex/provider.ts');
 mark('real-import');
 const real=await import(sdkPath);
 const RealCodex=real.Codex;
 const RealThread=real.Thread;
 mark('policy-options');
 const {restrictedClientOptions,restrictedThreadOptions}=await import('/app/packages/providers/src/codex/restricted-policy.ts');
 const expected=restrictedClientOptions('teetime-connect-v1');
 class FixtureCodex extends RealCodex {
  constructor(options) {
   if(!isDeepStrictEqual(options,expected)) throw new Error('unexpected original options');
   const {HTTP_PROXY,HTTPS_PROXY,...env}=options.env;
   const changed={...options,env,baseUrl:FIXTURE_URL,apiKey:'synthetic-only'};
   const {baseUrl,apiKey,env:actualEnv,...unchanged}=changed;
   const {env:originalEnv,...expectedUnchanged}=expected;
   if(!isDeepStrictEqual(unchanged,expectedUnchanged)||!isDeepStrictEqual(actualEnv,env)) throw new Error('unexpected fixture option delta');
   super(changed);
   intercepted++; optionsVerified=true;
  }
  startThread(options) {
   if(!isDeepStrictEqual(options,restrictedThreadOptions())) throw new Error('thread options changed');
   threads++; threadOptionsVerified=true;
   return super.startThread(options);
  }
 }
 mark('mock-install');
 mock.module(sdkPath,()=>({Codex:FixtureCodex,Thread:RealThread}));
 mark('import-verify');
 importIntercepted=(await import(sdkPath)).Codex===FixtureCodex;
 if(!importIntercepted) throw new Error('SDK import was not intercepted');
 mark('factory-import');
 const {createRestrictedCanaryWorkerProvider}=await import('/app/packages/providers/src/codex/restricted-run-factory.ts');
 const {collectArtifactStream}=await import('/app/scripts/staging/teetime-artifact-stream.ts');
 const {ArtifactProviderLifecycle}=await import('/app/scripts/staging/teetime-sdk-lifecycle.ts');
 mark('factory-construct');
 const provider=createRestrictedCanaryWorkerProvider({runId:'artifact-fixture-run',policyDigest:FIXTURE_POLICY,workspace:'/workspace'});
 lifecycle=new ArtifactProviderLifecycle(controller,()=>clearTimeout(timer));
 async function* observed() {
  for await(const chunk of lifecycle.observe(provider.sendQuery('Synthetic infrastructure fixture. Return one JSON artifact message only. Do not use tools or modify any files.','/workspace',undefined,{abortSignal:controller.signal}))) {
   counts[chunk.type]=(counts[chunk.type]??0)+1;
   if(Object.keys(counts).length>8) throw new Error('event type bound');
   yield chunk;
  }
 }
 mark('collect');
 const bytes=await collectArtifactStream(observed(),controller.signal);
 bytesBase64=Buffer.from(bytes).toString('base64');
 accepted=true;
 mark('complete');
} catch(error) {
 errorName=['Error','TypeError','SyntaxError','ResolveMessage'].includes(error?.name)?error.name:'other';
 errorCode=['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error?.code)?error.code:null;
 if(lifecycle)lifecycle.abortIfActive();else controller.abort();
} finally {
 if(lifecycle)lifecycle.abortIfActive();else controller.abort();
 clearTimeout(timer);
}
const abortedBeforeCleanup=controller.signal.aborted;
const normalProviderEnd=lifecycle?.normalEnd??false,providerIteratorClosed=lifecycle?.closed??false;
emit(JSON.stringify({kind:'result',accepted,bytesBase64,intercepted,threads,optionsVerified,threadOptionsVerified,
 importIntercepted,normalProviderEnd,providerIteratorClosed,counts,abortedBeforeCleanup,phase,errorName,errorCode})+'\n');
'''
bootstrap = 'const FIXTURE_URL='+json.dumps(url)+';\nconst FIXTURE_POLICY='+json.dumps(binding['policyHash'])+';\n'+code
protocol = DiagnosticProtocol()
exit_code = None
failure = None
try:
    exit_code, _ = capture(['bun', '-e', bootstrap], 35, limit=32768, on_stdout=protocol.feed)
    if exit_code != 0:
        failure = 'sdk-nonzero-exit'
    else:
        sdk = protocol.finish(exit_code)
except (TimeoutError, queue.Empty):
    failure = 'sdk-capture-deadline'
except ValueError:
    failure = 'sdk-capture-or-protocol-bound'
except Exception:
    failure = 'sdk-capture-failure'
finally:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=3)
if server_thread.is_alive():
    failure = 'server-stop-failure'
if failure:
    # Markers and even a final result cannot salvage a process or capture failure.
    print(json.dumps({'diagnosticPassed': False, 'case': case, 'failureCategory': failure,
        'sdkExitCode': exit_code, 'lastValidatedPhase': protocol.last_phase,
        'finalObserved': protocol.final is not None, 'operations': state,
        'syntheticAuthUnchanged': auth.read_bytes() == original,
        'credentialsUsed': False, 'realProviderRequests': 0}), flush=True)
    raise SystemExit(1)
candidate_verified = False
if sdk['accepted']:
    import base64
    raw = base64.b64decode(sdk['bytesBase64'], validate=True)
    candidate = parse_artifact(raw, base_files=base, expected_binding=binding,
                               allowed_paths={'index.html': ('100644',)})
    candidate_verified = (raw == artifact.encode() and candidate.files == (
        base[0], SnapshotFile('index.html', '100644', content.encode())))
workspace_unchanged = (set(path.name for path in Path('/workspace').iterdir()) == {'.codex', '.agents'}
    and all(not list(Path('/workspace', name).iterdir()) for name in ['.codex', '.agents']))
common = (state['requests'] == 1 and not state['errors'] and state['modelVerified']
          and sdk['intercepted'] == 1 and sdk['threads'] == 1 and sdk['optionsVerified']
          and sdk['threadOptionsVerified'] and sdk['importIntercepted']
          and sdk['providerIteratorClosed']
          and auth.read_bytes() == original and workspace_unchanged)
outcome = (candidate_verified and sdk['counts'] == {'assistant': 1, 'result': 1}
           and sdk['normalProviderEnd'] and not sdk['abortedBeforeCleanup']) if case == 'success' else (
           not sdk['accepted'] and sdk['bytesBase64'] is None and not candidate_verified
           and sdk['counts'] == {'assistant': 2} and not sdk['normalProviderEnd'])
print(json.dumps({'diagnosticPassed': common and outcome, 'case': case, 'operations': state,
    'sdk': sdk, 'candidateVerified': candidate_verified, 'syntheticAuthUnchanged': auth.read_bytes() == original,
    'credentialsUsed': False, 'realProviderRequests': 0, 'workspaceUnchanged': workspace_unchanged,
    'deviations': ['loopback base URL', 'synthetic API credential', 'proxy variables removed'],
    'observableBoundary': 'provider chunks; normalizer does not expose raw events after first completion'}), flush=True)
