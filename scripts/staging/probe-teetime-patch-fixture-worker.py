"""Pinned upstream SSE pattern, real SDK/CLI, loopback only, synthetic auth."""
import gzip
import http.server
import io
import json
import itertools
import os
from pathlib import Path
import sys
import threading
import urllib.parse

if not __debug__:
    raise RuntimeError('assertion-enabled Python required')
assert os.getuid() == 1001
sys.path.insert(0,'/app/scripts/staging')
from teetime_bounded_process import capture
os.chdir('/workspace')
home = Path('/home/appuser/.codex')
assert not home.exists()
home.mkdir(mode=0o700)
auth = home/'auth.json'
original = b'{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-auth-fixture"}'
auth.write_bytes(original)
patch = '*** Begin Patch\n*** Add File: /workspace/canary.txt\n+tee-time-canary-ready\n*** End Patch\n'
state = {'requests':0,'errors':[],'toolSchemaVerified':False,'matchingToolOutputs':[],
         'websocketUpgradeAttempts':0,'requestShapes':[],'observationErrors':[]}


def observation_error(label):
    if len(state['observationErrors']) < 16:
        state['observationErrors'].append(label)


def resource_counters():
    result = {}
    for name in ['pids.events','pids.current','pids.peak','memory.events']:
        try:
            raw = Path('/sys/fs/cgroup',name).read_bytes()
            assert len(raw) <= 4096
            result[name] = raw.decode('ascii').strip()
        except Exception:
            result[name] = None
    return result


def turn_contexts():
    contexts = []
    try:
        if not (home/'sessions').is_dir():
            raise ValueError('session directory absent')
        session_files = list(itertools.islice((home/'sessions').rglob('*.jsonl'),5))
        if not session_files or len(session_files) > 4:
            raise ValueError('session inventory unknown')
        for path in session_files:
            with path.open('rb') as handle:
                raw = handle.read(524289)
            if len(raw) > 524288:
                raise ValueError('session observation bound')
            for line in raw.splitlines(keepends=True):
                if not line.endswith(b'\n'):
                    observation_error('incomplete session tail')
                    continue
                row = json.loads(line)
                if row.get('type') == 'turn_context':
                    contexts.append({key:value for key,value in row['payload'].items() if
                        'permission' in key or 'sandbox' in key or 'workspace' in key or key == 'cwd'})
    except Exception as error:
        observation_error('turn context: '+type(error).__name__)
    return contexts


def observe_arg0(contexts):
    items = []
    try:
        for context in contexts:
            for entry in context.get('file_system_sandbox_policy',{}).get('entries',[]):
                raw = entry.get('path',{}).get('path','')
                if raw.startswith('file://'):
                    parsed = urllib.parse.urlparse(raw)
                    if parsed.netloc:
                        continue
                    path = urllib.parse.unquote(parsed.path)
                else:
                    path = raw
                if not path.startswith('/home/appuser/.codex/tmp/arg0/'):
                    continue
                candidate = Path(path)
                item = {'path':path,'pathEncoding':'uri' if raw.startswith('file://') else 'native',
                        'exists':candidate.exists()}
                if candidate.exists():
                    value = candidate.stat()
                    entries = list(itertools.islice(candidate.iterdir(),17))
                    if len(entries) > 16:
                        raise ValueError('arg0 enumeration bound')
                    links = []
                    for member in entries:
                        target = os.readlink(member) if member.is_symlink() else None
                        if len(member.name) > 255 or target is not None and len(target) > 512:
                            raise ValueError('arg0 link bound')
                        links.append({'name':member.name,'symlink':member.is_symlink(),'target':target})
                    item.update({'uid':value.st_uid,'mode':oct(value.st_mode & 0o777),'entries':links})
                items.append(item)
        if not items:
            observation_error('arg0 path not observed')
    except Exception as error:
        observation_error('arg0: '+type(error).__name__)
    return items


state['resourcesBeforeSdk'] = resource_counters()


def completed(identifier):
    # Pinned core/tests/common/responses.rs::ev_completed.
    return {'type':'response.completed','response':{'id':identifier,'usage':{
        'input_tokens':0,'input_tokens_details':None,'output_tokens':0,
        'output_tokens_details':None,'total_tokens':0}}}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == '/v1/responses' and self.headers.get('Upgrade','').lower() == 'websocket':
            state['websocketUpgradeAttempts'] += 1
        elif len(state['errors']) < 8:
            state['errors'].append('unexpected GET '+self.path[:128])
        self.send_response(404)
        self.send_header('Content-Length','0')
        self.send_header('Connection','close')
        self.end_headers()
        self.close_connection = True

    def do_POST(self):
        try:
            self.connection.settimeout(5)
            state['requests'] += 1
            assert state['requests'] <= 2 and self.path == '/v1/responses'
            size = int(self.headers.get('Content-Length','0'))
            assert 0 < size <= 1048576 and not self.headers.get('Transfer-Encoding')
            body = self.rfile.read(size)
            assert len(body) == size
            encoding = self.headers.get('Content-Encoding','identity')
            if encoding == 'gzip':
                body = gzip.GzipFile(fileobj=io.BytesIO(body)).read(1048577)
            else:
                assert encoding == 'identity'
            assert len(body) <= 1048576
            request = json.loads(body)
            if len(state['requestShapes']) < 2:
                state['requestShapes'].append({'keys':sorted(request),
                    'model':request.get('model'),'toolTypes':[tool.get('type') for tool in request.get('tools',[])],
                    'inputTypes':[item.get('type') for item in request.get('input',[])]})
            assert request['model'] == 'gpt-5.6-sol' and request.get('stream') is True
            if state['requests'] == 1:
                additional = [item for item in request['input'] if item.get('type') == 'additional_tools']
                if 'tools' in request:
                    assert not additional
                    tools = request['tools']
                else:
                    assert len(additional) == 1 and additional[0]['role'] == 'developer', 'additional_tools envelope'
                    tools = additional[0]['tools']
                state['toolAdvertisement'] = [{'type':tool.get('type'),'name':tool.get('name'),
                    'format':tool.get('format',{}).get('type'),
                    'children':[{'type':item.get('type'),'name':item.get('name'),
                        'format':item.get('format',{}).get('type')} for item in tool.get('tools',[])]}
                    for tool in tools]
                # Pinned tools/tool_spec.rs::create_tools_json_for_responses_lite
                # groups builtins inside the functions namespace.
                matches = [(tool,None) for tool in tools if tool.get('name') == 'apply_patch']
                executable = [(tool,None) for tool in tools if tool.get('name') == 'exec']
                for group in tools:
                    if group.get('type') == 'namespace' and group.get('name') == 'functions':
                        matches.extend((tool,'functions') for tool in group['tools'] if tool.get('name') == 'apply_patch')
                        executable.extend((tool,'functions') for tool in group['tools'] if tool.get('name') == 'exec')
                call_name = 'apply_patch'
                call_input = patch
                if not matches:
                    assert len(executable) == 1, 'one code-mode exec advertisement'
                    description = executable[0][0]['description']
                    assert 'apply_patch(input: string)' in description, 'advertised nested freeform patch'
                    assert 'text(value:' in description, 'advertised text helper'
                    # Pinned code-mode-protocol/description.rs freeform declaration
                    # and execute_spec.rs SOURCE grammar, no injected extra tools.
                    matches = executable
                    call_name = 'exec'
                    call_input = 'text(await tools.apply_patch('+json.dumps(patch)+'));'
                    state['patchRoute'] = 'code_mode_exec'
                assert len(matches) == 1 and matches[0][0]['type'] == 'custom', 'one advertised custom apply_patch'
                assert matches[0][0].get('format',{}).get('type') == 'grammar', 'apply_patch grammar'
                state['toolSchemaVerified'] = True
                # Pinned ev_custom_tool_call_with_namespace / unwrapped helper.
                call = {
                    'type':'custom_tool_call','name':call_name,'input':call_input,
                    'call_id':'teetime-fixed-patch'}
                if matches[0][1] is not None:
                    call['namespace'] = matches[0][1]
                events = [{'type':'response.output_item.done','item':call},completed('teetime-response-1')]
            else:
                outputs = [item for item in request['input'] if
                    item.get('type') == 'custom_tool_call_output' and
                    item.get('call_id') == 'teetime-fixed-patch']
                assert len(outputs) == 1 and len(json.dumps(outputs).encode()) <= 16384
                state['matchingToolOutputs'] = outputs
                # Observe before terminal completion, while the actual CLI and
                # its randomized helper directory are still alive.
                state['resourcesAfterPatchBeforeDiagnostics'] = resource_counters()
                state['contextsBeforeCompletion'] = turn_contexts()
                state['arg0BeforeCompletion'] = observe_arg0(state['contextsBeforeCompletion'])
                events = [completed('teetime-response-2')]
            # Exact pinned sse helper representation; no invented delta events.
            data = ''.join('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n'
                           for event in events).encode()
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream')
            self.send_header('Content-Length',str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as error:
            if len(state['errors']) < 8:
                state['errors'].append(type(error).__name__+':'+str(error)[:128])
            self.send_error(400)


server = http.server.HTTPServer(('127.0.0.1',0),Handler)
server_thread = threading.Thread(target=server.serve_forever,daemon=True)
server_thread.start()
url = 'http://127.0.0.1:'+str(server.server_address[1])+'/v1'
code = r'''
try {
const {restrictedClientOptions,restrictedThreadOptions}=await import('/app/packages/providers/src/codex/restricted-policy.ts');
const {Codex}=await import('/app/node_modules/@openai/codex-sdk/dist/index.js');
const original=restrictedClientOptions('teetime-connect-v1');
const {HTTP_PROXY,HTTPS_PROXY,...env}=original.env;
const codex=new Codex({...original,env,baseUrl:process.env.TEETIME_FIXTURE_URL,apiKey:'synthetic-only'});
const thread=codex.startThread(restrictedThreadOptions());
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),20000);
const events=[];
const eventTimings=[];
const started=performance.now();
let error=null;
try {
 const streamed=await thread.runStreamed('Synthetic infrastructure fixture. Create only canary.txt.',{signal:controller.signal});
 for await (const event of streamed.events) {
  if(events.length>=64) throw new Error('fixture event bound');
  events.push(event);
  eventTimings.push(Math.round(performance.now()-started));
 }
} catch(e) {error=String(e).slice(0,2000);}
finally {clearTimeout(timer);}
console.log(JSON.stringify({events,eventTimings,error,aborted:controller.signal.aborted}));
} catch(error) {
 console.log(JSON.stringify({events:[],error:String(error).slice(0,2000),aborted:false}));
}
'''
try:
    # Use a fixed source wrapper for the loopback port; no inherited host env.
    bootstrap = 'process.env.TEETIME_FIXTURE_URL='+json.dumps(url)+';\n'+code
    process_code, output = capture(['bun','-e',bootstrap],25,limit=65536)
    if process_code:
        sdk = {'events':[],'error':'fixture SDK process failed','aborted':False}
    else:
        sdk = json.loads(output)
finally:
    server.shutdown()
    server.server_close()
    server_thread.join(timeout=3)
assert not server_thread.is_alive()
artifact = Path('/workspace/canary.txt')
file_events = [event['item'] for event in sdk['events'] if
    event.get('type') == 'item.completed' and event.get('item',{}).get('type') == 'file_change']
contexts = turn_contexts()
state['resourcesAfterSdk'] = resource_counters()
report = {'operations':state,'sdk':sdk,'fileEvents':file_events,'credentialsUsed':False,
    'effectiveTurnContexts':contexts,
    'realProviderRequests':0,'artifactExact':artifact.is_file() and artifact.read_bytes() == b'tee-time-canary-ready\n',
    'syntheticAuthUnchanged':auth.read_bytes() == original,
    'workspaceEntriesExact':set(p.name for p in Path('/workspace').iterdir()) == {'.codex','.agents','canary.txt'},
    'deviations':['loopback openai_base_url','synthetic API credential','proxy variables removed for loopback'],
    'contextSource':'unchanged real restrictedClientOptions and restrictedThreadOptions'}
report['diagnosticPassed'] = (state['requests'] == 2 and not state['errors'] and state['toolSchemaVerified'] and
    len(state['matchingToolOutputs']) == 1 and sdk['error'] is None and not sdk['aborted'] and
    len(file_events) == 1 and file_events[0]['status'] == 'completed' and report['artifactExact'] and
    report['workspaceEntriesExact'] and report['syntheticAuthUnchanged'])
print(json.dumps(report),flush=True)
