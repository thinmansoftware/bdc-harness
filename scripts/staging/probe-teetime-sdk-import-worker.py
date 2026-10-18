"""Fixed import-only initialization diagnostic. No auth, server, thread or query."""
import json
import os
from pathlib import Path
import queue
import sys

sys.path.insert(0, '/app/scripts/staging')
from teetime_bounded_process import capture
from teetime_fixture_diagnostics import ImportDiagnosticProtocol

if not __debug__ or os.getuid() != 1001 or sys.argv[1:]:
    raise SystemExit('invalid fixed import-only diagnostic')
os.chdir('/workspace')
if list(Path('/home/appuser').iterdir()):
    raise SystemExit('import-only HOME must start empty')
code = r'''
const emit=process.stdout.write.bind(process.stdout);
let phase='logger',exportsVerified=false,moduleIntercepted=false,factoryImported=false;
let importOnlySuccess=false,errorName=null,errorCode=null;
function mark(next){phase=next;emit(JSON.stringify({kind:'phase',phase})+'\n');}
try {
 mark('logger');
 const {rootLogger}=await import('/app/packages/paths/src/logger.ts');
 rootLogger.level='silent';
 console.log=console.info=console.warn=console.error=console.debug=()=>{};
 mark('resolve');
 const {mock}=await import('bun:test');
 const sdkPath=import.meta.resolve('@openai/codex-sdk','file:///app/packages/providers/src/codex/provider.ts');
 mark('real-import');
 const real=await import(sdkPath);
 const RealCodex=real.Codex,RealThread=real.Thread;
 exportsVerified=JSON.stringify(Object.keys(real).sort())===JSON.stringify(['Codex','Thread'])
  &&typeof RealCodex==='function'&&typeof RealThread==='function';
 if(!exportsVerified) throw new Error('unexpected SDK exports');
 mark('policy-options');
 const policy=await import('/app/packages/providers/src/codex/restricted-policy.ts');
 if(typeof policy.restrictedClientOptions!=='function'||typeof policy.restrictedThreadOptions!=='function')
  throw new Error('unexpected policy exports');
 class FixtureCodex extends RealCodex {
  constructor(){throw new Error('import-only construction prohibited');}
 }
 mark('mock-install');
 mock.module(sdkPath,()=>({Codex:FixtureCodex,Thread:RealThread}));
 mark('import-verify');
 const mocked=await import(sdkPath);
 moduleIntercepted=mocked.Codex===FixtureCodex&&mocked.Thread===RealThread;
 if(!moduleIntercepted) throw new Error('import interception failed');
 mark('factory-import');
 const factory=await import('/app/packages/providers/src/codex/restricted-run-factory.ts');
 factoryImported=typeof factory.createRestrictedCanaryWorkerProvider==='function'
  &&typeof factory.createRestrictedWorkerProvider==='function';
 if(!factoryImported) throw new Error('unexpected factory exports');
 importOnlySuccess=true;
} catch(error) {
 errorName=['Error','TypeError','SyntaxError','ResolveMessage'].includes(error?.name)?error.name:'other';
 errorCode=['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND','ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error?.code)?error.code:null;
}
emit(JSON.stringify({kind:'import-only-result',phase,importOnlySuccess,exportsVerified,moduleIntercepted,
 factoryImported,errorName,errorCode})+'\n');
'''
protocol = ImportDiagnosticProtocol()
status = None
failure = None
try:
    status, _ = capture(['bun', '-e', code], 35, limit=32768, on_stdout=protocol.feed)
    result = protocol.finish(status)
except (TimeoutError, queue.Empty):
    failure = 'capture-deadline'
except ValueError:
    failure = 'process-or-protocol-failure'
except Exception:
    failure = 'capture-failure'
home_unchanged = not list(Path('/home/appuser').iterdir())
workspace_unchanged = (set(path.name for path in Path('/workspace').iterdir()) == {'.codex', '.agents'}
    and all(not list(Path('/workspace', name).iterdir()) for name in ['.codex', '.agents']))
passed = (failure is None and result['importOnlySuccess'] and home_unchanged and workspace_unchanged)
print(json.dumps({'diagnosticPassed': passed, 'kind': 'import-only', 'failureCategory': failure,
    'lastValidatedPhase': protocol.last_phase, 'sdkExitCode': status,
    'result': protocol.final, 'homeUnchanged': home_unchanged, 'workspaceUnchanged': workspace_unchanged,
    'credentialsUsed': False, 'realProviderRequests': 0, 'artifactQualified': False}), flush=True)
if not passed:
    raise SystemExit(1)
