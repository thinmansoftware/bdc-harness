"""Existing SSH/container credential boundary; only bounded XO model requests."""
import json, shlex, subprocess, sys

REMOTE = r'''
import json,os,sys,urllib.request,urllib.error
x=json.load(sys.stdin);path=x['path'];body=x.get('body')
assert path in ('credits','models/openai/gpt-6.1-terra/endpoints','models/openai/gpt-6.1-sol/endpoints','responses') or path.startswith('generation?id=gen-')
if body is not None:
 assert path=='responses' and body['model'] in ('openai/gpt-6.1-terra','openai/gpt-6.1-sol')
 assert body['provider']['only']==['openai'] and body['provider']['allow_fallbacks'] is False
 assert body['max_output_tokens']<=6000 and len(json.dumps(body).encode())<=100000
 assert [t['name'] for t in body['tools']]==['submit_brief']
req=urllib.request.Request('https://openrouter.ai/api/v1/'+path,data=json.dumps(body).encode() if body else None,headers={'Authorization':'Bearer '+os.environ['OPENROUTER_API_KEY'],'Content-Type':'application/json'})
try:
 with urllib.request.urlopen(req,timeout=150) as r:out={'status':r.status,'body':json.load(r)}
 if path=='credits':out['body']={'remaining_usd':out['body']['data']['total_credits']-out['body']['data']['total_usage']}
 print(json.dumps(out))
except urllib.error.HTTPError as e:print(json.dumps({'status':e.code,'body':{'error':'provider_http_failure'}}))
'''

payload=json.load(sys.stdin)
p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','hetzner-prod',
                  'docker exec -i archon-app-1 python3 -c '+shlex.quote(REMOTE)],
                 input=json.dumps(payload),text=True,capture_output=True,timeout=175,encoding='utf-8')
if p.returncode:
    print(json.dumps({'status':503,'body':{'error':'relay_unavailable'}}))
    sys.exit(0)
print(json.dumps(json.loads(p.stdout)))
