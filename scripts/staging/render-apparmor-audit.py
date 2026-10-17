"""Render a separately named Moby profile with audited (still denied) mounts."""
import hashlib
from pathlib import Path
import re
import sys

name = sys.argv[1]
if not re.fullmatch(r"teetime-probe-(audit|mount)-[0-9]+-[0-9]+", name):
    raise SystemExit("invalid owned audit profile name")
source = Path(__file__).with_name("moby-apparmor-template.go").read_bytes()
if hashlib.sha256(source).hexdigest() != "7da15d81aa5c507f5002b844fdc49a969904681447a2cc29222bd6cbe797163b":
    raise SystemExit("pinned AppArmor source mismatch")
template = source.decode().split('const baseTemplate = `', 1)[1].split('`', 1)[0]
template = template.replace('{{if .Abi}}abi <{{.Abi}}>,\n{{- end}}', 'abi <abi/3.0>,')
template = template.replace('{{range $value := .Imports}}\n{{$value}}\n{{- end}}', '#include <tunables/global>')
template = template.replace('{{- range $value := .InnerImports}}\n  {{$value}}\n{{- end}}{{if .InnerImports}}\n{{end}}', '  #include <abstractions/base>\n')
template = template.replace('{{.Name}}', '"' + name + '"')
template = template.replace('{{.PeerName}}', '"' + name + '"')
template = template.replace('{{.DaemonProfile}}', 'unconfined')
if '{{' in template or template.count('  deny mount,') != 1:
    raise SystemExit("unexpected pinned template structure")
rule = ('  audit mount options=(rw,silent,rslave) -> /,'
        if name.startswith('teetime-probe-mount-') else '  audit deny mount,')
audited = template.replace('  deny mount,', rule)
assert audited.replace(rule, '  deny mount,') == template
sys.stdout.write(audited)
