"""One frozen synthetic framework case on the Windows staging operator.

No app implementation, account, provider, published port or shared source mount.
Operator freezes SOURCE/PAYLOAD_HASH/PROFILE_HASH from reviewed Git bytes first.
"""
from pathlib import Path
import base64,hashlib,json,os,re,subprocess,time

SOURCE='SOURCE_TO_FREEZE'
PAYLOAD_HASH='PAYLOAD_TO_FREEZE'
PROFILE_HASH='971a338323570a78dbfcb6337720373afab0fa9b621e6a0f48be404fb5a4dae6'
IMAGE='sha256:41cccc7d75787aae96695a5ad64a5b209553e95c2f511e482abc7b24201cccbe'
OWNER='teetime-framework-'+SOURCE[:12]
ROOT=Path.home()/OWNER
PROFILE=Path.home()/'teetime-browser-profile-809ecbfd48c6.json'
CMD=[r'C:\Program Files\Docker\Docker\resources\bin\docker.exe','--config',str(Path.home()/'teetime-demo-deps-f98bf393d13d/docker-config'),'--host','npipe:////./pipe/dockerDesktopLinuxEngine']
ENV={k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PATH','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMFILES','PROGRAMDATA'}}
FIXED_NAMES={'package.json','bun.lock','tsconfig.json','next-env.d.ts','next.config.mjs','playwright.config.ts','app/layout.tsx','app/page.tsx','tests/environment.test.ts','walkthrough/environment.spec.ts'}

WRITER=r'''
const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');
const data=JSON.parse(fs.readFileSync(0,'utf8')),root='/workspace/app';
const expected=['package.json','bun.lock','tsconfig.json','next-env.d.ts','next.config.mjs','playwright.config.ts','app/layout.tsx','app/page.tsx','tests/environment.test.ts','walkthrough/environment.spec.ts'];
if(Object.keys(data.files).sort().join('|')!==expected.sort().join('|'))throw Error('fixed fixture inventory');
fs.mkdirSync(root,{recursive:true});fs.mkdirSync('/workspace/tmp',{recursive:true});
for(const name of expected){const b=Buffer.from(data.files[name].base64,'base64');if(b.length!==data.files[name].bytes||crypto.createHash('sha256').update(b).digest('hex')!==data.files[name].sha256)throw Error('fixed source hash');fs.mkdirSync(require('path').dirname(root+'/'+name),{recursive:true});fs.writeFileSync(root+'/'+name,b,{flag:'wx'});}
fs.cpSync('/tmp/teetime-bun-cache','/workspace/bun-cache',{recursive:true});
const env={PATH:'/opt/teetime/node/bin:/opt/teetime/bun:/usr/bin:/bin',HOME:'/workspace/tmp',TMPDIR:'/workspace/tmp',NEXT_TELEMETRY_DISABLED:'1',CI:'1',BUN_INSTALL_CACHE_DIR:'/workspace/bun-cache'};
function run(id,args){const r=cp.spawnSync(args[0],args.slice(1),{cwd:root,env,encoding:'utf8',timeout:120000,maxBuffer:1048576});if(r.status!==0)throw Error(id+': '+(r.stderr||r.stdout||'failed').slice(-6000));return {id,exitCode:r.status};}
const stages=[];stages.push(run('frozen-install',['/opt/teetime/bun/bun','install','--frozen-lockfile','--ignore-scripts','--linker=hoisted','--no-progress']));
stages.push(run('type-generation',['/opt/teetime/node/bin/node',root+'/node_modules/next/dist/bin/next','typegen',root]));
fs.mkdirSync(root+'/.next',{recursive:true});
const files={};for(const name of expected){const b=fs.readFileSync(root+'/'+name);files[name]={bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),base64:b.toString('base64')};}
if(files['package.json'].sha256!==data.files['package.json'].sha256||files['bun.lock'].sha256!==data.files['bun.lock'].sha256)throw Error('frozen package/lock changed');
console.log(JSON.stringify({kind:'framework-writer',passed:true,stages,files}));
'''

VERIFIER=r'''
const fs=require('fs'),cp=require('child_process'),crypto=require('crypto'),root='/workspace/app';
const names=['package.json','bun.lock','tsconfig.json','next-env.d.ts','next.config.mjs','playwright.config.ts','app/layout.tsx','app/page.tsx','tests/environment.test.ts','walkthrough/environment.spec.ts'];
function snapshot(){return Object.fromEntries(names.map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(root+'/'+n)).digest('hex')]));}
const before=snapshot(),env={PATH:'/opt/teetime/node/bin:/opt/teetime/bun:/usr/bin:/bin',HOME:'/tmp/teetime-home',TMPDIR:'/tmp',NEXT_TELEMETRY_DISABLED:'1',CI:'1',PLAYWRIGHT_BROWSERS_PATH:'/ms-playwright',NODE_OPTIONS:'--max-old-space-size=1024'};
const expected=EXPECTED_HASHES_TO_FREEZE;
if(names.some(n=>before[n]!==expected[n]))throw Error('writer and verifier source differ');
fs.mkdirSync('/tmp/teetime-home',{recursive:true});
const commands=[['unit',['/opt/teetime/bun/bun','test','./tests']],['build',['/opt/teetime/node/bin/node',root+'/node_modules/next/dist/bin/next','build','--webpack']],['typecheck',['/opt/teetime/node/bin/node',root+'/node_modules/typescript/bin/tsc','--noEmit']],['browser',['/opt/teetime/node/bin/node',root+'/node_modules/@playwright/test/cli.js','test']]];
const stages=[];let passed=true;
for(const [id,args] of commands){const r=cp.spawnSync(args[0],args.slice(1),{cwd:root,env,encoding:'utf8',timeout:120000,maxBuffer:1048576});stages.push({id,exitCode:r.status,diagnostic:r.status===0?null:(r.stderr||r.stdout||'failed').slice(-6000)});if(r.status!==0){passed=false;break;}}
const after=snapshot(),unchanged=names.every(n=>after[n]===expected[n]);
console.log(JSON.stringify({kind:'framework-verifier',passed:passed&&unchanged,stages,sourceUnchanged:unchanged,sourceHashes:after,accountProvided:false,modelInvocations:0,applicationDemo:false}));
process.exitCode=passed&&unchanged?0:1;
'''

def save(name,value):
    with (ROOT/name).open('x',encoding='ascii') as stream:
        json.dump(value,stream,indent=2);stream.flush();os.fsync(stream.fileno())

def call(parts):
    result=subprocess.run(CMD+parts,env=ENV,stdin=subprocess.DEVNULL,capture_output=True,timeout=20,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode or len(result.stdout)+len(result.stderr)>1048576:raise ValueError('closed Docker operation failed')
    return result.stdout

def owned_container(identifier):
    info=json.loads(call(['inspect',identifier]))[0]
    if info['Image']!=IMAGE or info['Config']['Labels'].get('bdc.teetime.owner')!=OWNER:raise ValueError('container custody differs')
    return info

def validate_volume(info,name):
    if (info['Name']!=name or info['Driver']!='local' or info['Scope']!='local'
        or info.get('Options') not in (None,{})
        or info.get('Labels')!={'bdc.teetime.owner':OWNER}
        or info['Mountpoint']!='/var/lib/docker/volumes/'+name+'/_data'):
        raise ValueError('plain owned local volume required')

def accept_writer_output(payload,result):
    files=result.get('files',{})
    if result.get('passed') is not True or set(files)!=FIXED_NAMES or set(payload['files'])!=FIXED_NAMES:
        raise ValueError('complete fixed writer inventory required')
    hashes={};generated=[]
    for name in sorted(FIXED_NAMES):
        entry=files[name]
        if set(entry)!={'bytes','sha256','base64'}:raise ValueError('closed writer file record required')
        data=base64.b64decode(entry['base64'],validate=True)
        if len(data)!=entry['bytes'] or hashlib.sha256(data).hexdigest()!=entry['sha256']:
            raise ValueError('writer bytes and hashes differ')
        if entry!=payload['files'][name]:
            if name not in {'tsconfig.json','next-env.d.ts'}:raise ValueError('non-generated source changed')
            generated.append(name)
        hashes[name]=entry['sha256']
    return hashes,generated

def bound_verifier(hashes):
    if set(hashes)!=FIXED_NAMES or any(re.fullmatch('[a-f0-9]{64}',value) is None for value in hashes.values()):
        raise ValueError('accepted writer hashes required')
    return VERIFIER.replace('EXPECTED_HASHES_TO_FREEZE',json.dumps(hashes,sort_keys=True))

def validate_mounts(mounts,volume,mountpoint,readonly,tmpfs):
    selected=[item for item in mounts if item['Type']=='volume']
    if len(selected)!=1 or selected[0]['Name']!=volume or selected[0]['Source']!=mountpoint or selected[0]['Destination']!='/workspace' or selected[0]['RW'] is readonly:
        raise ValueError('exact owned volume mount required')
    seen=set()
    for item in mounts:
        if item['Type']=='volume':continue
        destination=item['Destination']
        if item['Type']!='tmpfs' or destination not in tmpfs or destination in seen:
            raise ValueError('unexpected or repeated non-volume mount')
        seen.add(destination)

def run_phase(role,script,volume,*,input_bytes=None,readonly=False):
    volume_info=json.loads(call(['volume','inspect',volume]))[0];validate_volume(volume_info,volume)
    if call(['ps','-a','--filter','volume='+volume,'--format','{{.ID}}']).strip():
        raise ValueError('volume already has container references')
    mount='type=volume,source='+volume+',target=/workspace'+(',readonly' if readonly else '')
    args=['create','--pull','never','--name',OWNER+'-'+role,'--label','bdc.teetime.owner='+OWNER,
        '--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
        '--pids-limit','256','--memory','3g','--memory-swap','3g','--cpus','2','--user','1001:1001',
        '--shm-size','256m','--mount',mount,'--workdir','/workspace','--entrypoint','/opt/teetime/node/bin/node']
    if readonly:
        args+=['--security-opt','seccomp='+str(PROFILE),'--tmpfs','/workspace/app/.next:uid=1001,gid=1001,size=1024m',
               '--tmpfs','/tmp:uid=1001,gid=1001,size=512m','--tmpfs','/results:uid=1001,gid=1001,size=256m']
    if input_bytes is not None:args+=['-i']
    identifier=call(args+[IMAGE,'-e',script]).decode().strip()
    if re.fullmatch('[a-f0-9]{64}',identifier) is None:raise ValueError('owned container id required')
    receipt={'role':role,'container':identifier,'passed':False,'cleanupVerified':False,'attachReaped':True}
    child=None
    try:
        info=owned_container(identifier);host=info['HostConfig'];mounts=info['Mounts']
        if (host['NetworkMode']!='none' or not host['ReadonlyRootfs'] or host['Privileged']
            or host['CapDrop']!=['ALL'] or host.get('CapAdd') or host.get('Binds') or host.get('PortBindings')
            or host.get('Devices') or host.get('DeviceRequests')
            or host['Memory']!=3221225472 or host['MemorySwap']!=3221225472 or host['NanoCpus']!=2000000000
            or host['PidsLimit']!=256 or host['IpcMode']!='private' or host['ShmSize']!=268435456
            or info['Config']['User']!='1001:1001'
            or info['Config']['Entrypoint']!=['/opt/teetime/node/bin/node']
            or info['Config']['Cmd']!=['-e',script] or info['Config']['OpenStdin']!=(input_bytes is not None)):
            raise ValueError('fixed framework isolation differs')
        security=host.get('SecurityOpt',[])
        expected_tmpfs={'/workspace/app/.next':'uid=1001,gid=1001,size=1024m','/tmp':'uid=1001,gid=1001,size=512m','/results':'uid=1001,gid=1001,size=256m'} if readonly else {}
        if (host.get('Tmpfs') or {})!=expected_tmpfs:raise ValueError('fixed writable tmpfs differs')
        validate_mounts(mounts,volume,volume_info['Mountpoint'],readonly,expected_tmpfs)
        if len(security)!=(2 if readonly else 1) or security.count('no-new-privileges:true')!=1:
            raise ValueError('fixed security option set differs')
        if readonly:
            selected_profile=json.loads(next(value[8:] for value in security if value.startswith('seccomp=')))
            if selected_profile!=json.loads(PROFILE.read_bytes()):raise ValueError('qualified browser profile differs')
        save(role+'-launch.json',{'source':SOURCE,'image':IMAGE,'container':identifier,'readonlySource':readonly})
        out_path=ROOT/(role+'.stdout.log');err_path=ROOT/(role+'.stderr.log')
        input_path=ROOT/(role+'.stdin.json')
        if input_bytes is not None:
            with input_path.open('xb') as source:source.write(input_bytes)
        # A regular input file avoids an unbounded pipe write before the deadline.
        started=time.monotonic();last=0
        with out_path.open('xb') as out,err_path.open('xb') as err, (input_path.open('rb') if input_bytes is not None else open(os.devnull,'rb')) as source:
            child=subprocess.Popen(CMD+['start','--attach',*(['--interactive'] if input_bytes is not None else []),identifier],
                env=ENV,stdin=source,
                stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
            receipt['attachReaped']=False
            while child.poll() is None:
                elapsed=int(time.monotonic()-started)
                if elapsed>300 or out_path.stat().st_size+err_path.stat().st_size>1048576:
                    child.kill();child.wait(timeout=5);raise ValueError('bounded framework phase exceeded')
                if elapsed//30>last:
                    last=elapsed//30;print(json.dumps({'kind':'framework-progress','role':role,'elapsedSeconds':elapsed}),flush=True)
                time.sleep(.25)
            child.wait(timeout=5);receipt['attachReaped']=True
        state=owned_container(identifier)['State']
        receipt['clientExitCode']=child.returncode
        receipt['containerState']={key:state[key] for key in ['Status','Running','ExitCode','OOMKilled']}
        if out_path.stat().st_size+err_path.stat().st_size>1048576:raise ValueError('final phase output exceeds bound')
        raw=out_path.read_bytes()
        try:receipt['result']=json.loads(raw)
        except ValueError:receipt['result']={'passed':False,'failure':'closed-phase-output-unavailable'}
        receipt['passed']=(child.returncode==0 and state['Status']=='exited' and state['ExitCode']==0
            and state['Running'] is False and state['OOMKilled'] is False and receipt['result'].get('passed') is True)
        if child.returncode and err_path.stat().st_size:
            receipt['diagnostic']=err_path.read_bytes()[-8192:].decode('utf-8',errors='replace')
    except Exception as error:
        receipt['passed']=False;receipt['failureType']=type(error).__name__
    finally:
        if child is not None:
            try:
                if child.poll() is None:child.kill()
                child.wait(timeout=5);receipt['attachReaped']=True
            except Exception:receipt['attachReaped']=False
        try:
            owned_container(identifier);call(['rm','--force',identifier])
            receipt['cleanupVerified']=not call(['ps','-a','--filter','id='+identifier,'--format','{{.ID}}']).strip()
        except Exception:receipt['cleanupVerified']=False
        receipt['passed']=receipt['passed'] and receipt['cleanupVerified'] and receipt['attachReaped'];save(role+'-result.json',receipt)
    return receipt

def main():
    if os.name!='nt' or re.fullmatch('[a-f0-9]{40}',SOURCE) is None:raise ValueError('frozen Windows source required')
    payload_path=Path.home()/(OWNER+'.input.json')
    raw=payload_path.read_bytes()
    if len(raw)>131072 or payload_path.is_symlink() or payload_path.resolve()!=payload_path or hashlib.sha256(raw).hexdigest()!=PAYLOAD_HASH:
        raise ValueError('frozen fixture payload differs')
    if PROFILE.is_symlink() or PROFILE.resolve()!=PROFILE or hashlib.sha256(PROFILE.read_bytes()).hexdigest()!=PROFILE_HASH:
        raise ValueError('frozen qualified profile differs')
    if call(['ps','-a','--filter','label=bdc.teetime.owner='+OWNER,'--format','{{.ID}}']).strip():raise ValueError('owned resources already exist')
    if call(['volume','ls','--filter','label=bdc.teetime.owner='+OWNER,'--format','{{.Name}}']).strip():raise ValueError('owned volume already exists')
    volume=OWNER+'-data'
    if volume in call(['volume','ls','--format','{{.Name}}']).decode().splitlines():raise ValueError('exact volume name already exists')
    ROOT.mkdir();save('launch.json',{'source':SOURCE,'payloadSha256':PAYLOAD_HASH,'image':IMAGE,'profileSha256':PROFILE_HASH,'accountProvided':False,'modelInvocations':0})
    call(['volume','create','--label','bdc.teetime.owner='+OWNER,volume])
    result={'kind':'synthetic-framework-qualification','source':SOURCE,'passed':False,'modelInvocations':0,'accountProvided':False,'applicationDemo':False,'cleanupVerified':False}
    try:
        validate_volume(json.loads(call(['volume','inspect',volume]))[0],volume)
        writer=run_phase('writer',WRITER,volume,input_bytes=raw);result['writer']=writer
        if writer['passed']:
            hashes,generated=accept_writer_output(json.loads(raw),writer['result'])
            result['acceptedSourceHashes']=hashes;result['generatedChanges']=generated
            result['verifier']=run_phase('verifier',bound_verifier(hashes),volume,readonly=True)
            result['passed']=result['verifier']['passed']
    except Exception as error:
        result['failureType']=type(error).__name__
    finally:
        try:
            owned=json.loads(call(['volume','inspect',volume]))[0]
            validate_volume(owned,volume)
            if call(['ps','-a','--filter','volume='+volume,'--format','{{.ID}}']).strip():raise ValueError('volume container remains')
            call(['volume','rm',volume])
            result['cleanupVerified']=not call(['volume','ls','--filter','label=bdc.teetime.owner='+OWNER,'--format','{{.Name}}']).strip()
        except Exception:result['cleanupVerified']=False
        result['passed']=result['passed'] and result['cleanupVerified'];save('result.json',result)
    # Full generated files stay in the owned receipt; emit only bounded phase summaries.
    summary={**result}
    if 'writer' in summary:
        summary['writer']={**summary['writer'],'result':{key:value for key,value in summary['writer'].get('result',{}).items() if key!='files'}}
    print(json.dumps(summary),flush=True)
    return 0 if result['passed'] else 1

if __name__=='__main__':raise SystemExit(main())
