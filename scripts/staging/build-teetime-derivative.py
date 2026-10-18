"""Build a recorded staging derivative from exact Git source; no credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import uuid

if not __debug__: raise SystemExit('Assertions required')
parser=argparse.ArgumentParser()
parser.add_argument('--docker',required=True)
parser.add_argument('--repo',type=Path,required=True)
parser.add_argument('--base-image',required=True)
parser.add_argument('--base-sha',required=True)
parser.add_argument('--target-sha',required=True)
args=parser.parse_args()
for sha in [args.base_sha,args.target_sha]:
    if not re.fullmatch('[a-f0-9]{40}',sha): raise SystemExit('Exact commit required')
if not re.fullmatch('sha256:[a-f0-9]{64}',args.base_image): raise SystemExit('Exact image required')
def d(*parts): return subprocess.check_output([args.docker,*parts],timeout=30)
def git(*parts): return subprocess.check_output(['git','-C',str(args.repo),*parts],timeout=30)
assert git('rev-parse',args.target_sha).decode().strip()==args.target_sha
git('merge-base','--is-ancestor',args.base_sha,args.target_sha)
base=json.loads(d('image','inspect',args.base_image))[0]
assert base['Id']==args.base_image
assert 'ARCHON_BUILD_SHA='+args.base_sha in base['Config']['Env']
rows=git('diff','--raw','--no-renames',args.base_sha,args.target_sha).decode().splitlines()
files=[];excluded=[]
for row in rows:
    fields,path=row.split('\t')
    mode=fields.split()
    assert mode[0] in [':000000',':100644'] and mode[1]=='100644' and mode[-1] in ['A','M']
    if path=='.github/workflows/offline-qualification.yml': excluded.append(path);continue
    assert re.fullmatch(r'(packages/providers/src/codex|scripts/staging)/[a-zA-Z0-9_.-]+',path)
    files.append(path)
assert files
root=Path.home()/('teetime-derivative-'+args.target_sha[:12]+'-'+uuid.uuid4().hex[:6]);root.mkdir()
hashes={}
for path in files:
    content=git('show',args.target_sha+':'+path)
    target=root/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
    hashes[path]=hashlib.sha256(content).hexdigest()
base_tag='teetime-owned-base:'+uuid.uuid4().hex
d('image','tag',args.base_image,base_tag)
assert json.loads(d('image','inspect',base_tag))[0]['Id']==args.base_image
recipe='FROM '+base_tag+'\n'+''.join('COPY '+p+' /app/'+p+'\n' for p in files)+'ENV ARCHON_BUILD_SHA='+args.target_sha+'\n'
(root/'Dockerfile').write_text(recipe,encoding='ascii')
tag='archon-teetime-canary:'+args.target_sha[:12]
try:
    with (root/'build.log').open('w') as log:
        subprocess.run([args.docker,'build','--pull=false','--network','none','-t',tag,str(root)],stdout=log,stderr=subprocess.STDOUT,timeout=300,check=True)
    assert json.loads(d('image','inspect',base_tag))[0]['Id']==args.base_image
finally:
    assert json.loads(d('image','inspect',base_tag))[0]['Id']==args.base_image
    d('image','rm',base_tag)
image=json.loads(d('image','inspect',tag))[0]
assert image['RootFS']['Layers'][:len(base['RootFS']['Layers'])]==base['RootFS']['Layers']
for key in ['Entrypoint','Cmd','User','WorkingDir','Healthcheck']:
    assert image['Config'].get(key)==base['Config'].get(key)
assert set(image['Config']['Env'])==(set(base['Config']['Env'])-{'ARCHON_BUILD_SHA='+args.base_sha})|{'ARCHON_BUILD_SHA='+args.target_sha}
measured=d('run','--rm','--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges:true','--user','1001:1001','--no-healthcheck',
    '--entrypoint','/usr/bin/sha256sum',image['Id'],*['/app/'+p for p in files]).decode()
actual={line.split()[1].removeprefix('/app/'):line.split()[0] for line in measured.splitlines()}
assert actual==hashes
receipt={'kind':'staging derivative, not full CI image','baseImageId':args.base_image,
    'baseSha':args.base_sha,'targetSha':args.target_sha,'imageId':image['Id'],
    'fileHashes':hashes,'excludedNonRuntimePaths':excluded,'recipeSha256':hashlib.sha256(recipe.encode()).hexdigest()}
(root/'receipt.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps({'receiptDirectory':str(root),'imageId':image['Id'],'targetSha':args.target_sha}))
