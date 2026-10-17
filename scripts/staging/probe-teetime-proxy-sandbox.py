# Appended to the inspected credential-free worker probe by the owned launcher.
import subprocess
from pathlib import Path

binary='/app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
env={'HOME':'/home/appuser','CODEX_HOME':'/home/appuser/.codex','PATH':'/usr/local/bin:/usr/bin:/bin'}
assert subprocess.check_output([binary,'--version'],env=env,text=True).strip()=='codex-cli 0.153.3'
home=Path('/home/appuser/.codex')
assert not home.exists()
home.mkdir(mode=0o700)
(home/'config.toml').write_text('''approval_policy = "never"
[permissions.tee-time]
extends = ":workspace"
[permissions.tee-time.filesystem]
":root" = "deny"
":minimal" = "read"
"/app" = "read"
":slash_tmp" = "deny"
":tmpdir" = "deny"
[permissions.tee-time.network]
enabled = false
''')
# Numeric proxy address avoids confusing DNS failure with sandbox connection denial.
address=socket.gethostbyname('teetime-proxy')
curl=['curl','--noproxy','','--proxy','http://'+address+':3128',
      '--proxy-header','User-Agent:',
      '--max-time','5','--silent','--show-error','--head','https://chatgpt.com/']
control=subprocess.run(curl,env=env,capture_output=True,timeout=8)
assert control.returncode==0 and b'HTTP/' in control.stdout, 'proxy control failed: '+str(control.returncode)+': '+control.stderr.decode()
sandbox=[binary,'sandbox','-P','tee-time','-C','/workspace',
         'sh','-c','printf "sandbox-command-started\\n"; exec "$@"','probe']
for name,command in [('child',curl),('nested',['sh','-c','exec "$@"','nested',*curl])]:
    outcome=subprocess.run([*sandbox,*command],env=env,cwd='/workspace',capture_output=True,timeout=10)
    assert b'sandbox-command-started\n' in outcome.stdout, 'sandbox did not start'
    assert outcome.returncode==7, 'unexpected network denial code'
    assert any(v in outcome.stderr.lower() for v in [b'failed to connect',b'could not connect',b"couldn't connect"]), 'unexpected denial diagnostic'
    result[name+'ProxyDenied']=True
result['unsandboxedProxyControl']=True
result['pinnedCliVersion']='0.153.3'
