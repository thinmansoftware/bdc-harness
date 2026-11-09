#!/usr/bin/env bash
# Read-only selection; live execution is post-merge/XO acceptance only.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
python3 - "$@" <<'PY'
import argparse, json, os, pathlib, sqlite3, subprocess, sys, tempfile, uuid
sys.stdout.reconfigure(newline="\n")

parser=argparse.ArgumentParser(description="Replay backlog evidence without publishing")
parser.add_argument("--sample",type=int,default=10)
parser.add_argument("--dry-run",action="store_true")
parser.add_argument("--db",help="Existing local Archon SQLite event store (live replay only)")
args=parser.parse_args()
if args.sample < 1: parser.error("--sample must be positive")
repo="thinmansoftware/bdc-harness"
def run(*cmd, cwd=None):
    # Bash resolves both native executables and the fixture's executable gh shim.
    return subprocess.check_output(["bash","-c",'exec "$@"',"_",*cmd],cwd=cwd,text=True)
prs=json.loads(run("gh","pr","list","--repo",repo,"--base","dev","--state","open","--limit","10000","--json","number,updatedAt,statusCheckRollup,headRefOid"))
bad={"FAILURE","ERROR","TIMED_OUT","CANCELLED"}
eligible=[p for p in prs if not p.get("statusCheckRollup") or any((c.get("conclusion") or c.get("state") or "").upper() in bad for c in p["statusCheckRollup"])]
sample=sorted(eligible,key=lambda p:p["updatedAt"],reverse=True)[:args.sample]
if len(sample)!=args.sample:
    sys.exit("REPLAY_SAMPLE_UNAVAILABLE: requested %d, eligible %d" % (args.sample,len(sample)))
if args.dry_run:
    for pr in sample: print(pr["number"])
    sys.exit(0)  # No CLI invocation, database open, worktree or event-store write.

if os.environ.get("DATABASE_URL"):
    parser.error("live replay requires the serving SQLite event store; DATABASE_URL selects PostgreSQL")
# Match getArchonHome() and connection.ts, with an explicit read-only override.
docker=os.environ.get("WORKSPACE_PATH")=="/workspace" or (os.environ.get("HOME")=="/root" and bool(os.environ.get("WORKSPACE_PATH"))) or os.environ.get("ARCHON_DOCKER")=="true"
archon_home=os.environ.get("ARCHON_HOME") or ("/.archon" if docker else str(pathlib.Path.home()/".archon"))
if archon_home=="undefined": parser.error("ARCHON_HOME is the literal undefined")
dbpath=pathlib.Path(args.db or pathlib.Path(archon_home)/"archon.db").expanduser().resolve()
db=sqlite3.connect(dbpath.as_uri()+"?mode=ro",uri=True)
counts=dict(false_pass=0,na_on_code=0,passed=0,repaired=0,blocked=0,failed=0)
print("PR | Tests | Outcome")
for pr in sample:
    n=pr["number"]
    before=json.loads(run("gh","pr","view",str(n),"--repo",repo,"--json","headRefOid"))["headRefOid"]
    token="evidence-replay-"+uuid.uuid4().hex
    # The existing CLI waits synchronously for workflow completion. Preserve its
    # output and then correlate ONE run by the unique user-message token.
    proc=subprocess.run(["bun","run","cli","workflow","run","bdc-evidence-replay","PR_NUMBER=%d replay_token=%s"%(n,token)],text=True,capture_output=True)
    rows=db.execute("SELECT id,status,working_path FROM remote_agent_workflow_runs WHERE workflow_name=? AND instr(user_message,?)>0",("bdc-evidence-replay",token)).fetchall()
    if len(rows)!=1: sys.exit("REPLAY_RUN_CORRELATION_FAILED: PR %d"%n)
    rid,state,working_path=rows[0]
    events=db.execute("SELECT event_type,step_name,data FROM remote_agent_workflow_events WHERE workflow_run_id=? ORDER BY created_at",(rid,)).fetchall()
    outputs=[json.loads(data).get("node_output","") for typ,name,data in events if name=="replay-report" and typ=="node_completed"]
    paths=[line.split("=",1)[1] for out in outputs for line in out.splitlines() if line.startswith("REPLAY_REPORT_PATH=")]
    if len(paths)!=1: sys.exit("REPLAY_REPORT_MISSING: PR %d run %s status %s"%(n,rid,state))
    report_path=pathlib.Path(paths[0]); e=report_path.parent
    report=json.loads(report_path.read_text())
    if report["pr"]!=n: sys.exit("REPLAY_REPORT_PR_MISMATCH")
    status=report["status"]
    if report["wo_class"] in {"CODE","MIXED"} and ("N/A" in report["tests_line"] or not report["tests_line"]): counts["na_on_code"]+=1
    if status=="passed":
        with tempfile.TemporaryDirectory(prefix="bdc-replay-verify-") as tmp:
            # Own detached worktree only; apply observed local repair, never publish it.
            wt=str(pathlib.Path(tmp)/"verify")
            subprocess.check_call(["git","worktree","add","--detach",wt,before],stdout=subprocess.DEVNULL)
            try:
                patch=e/"replay-repair.patch"
                if patch.stat().st_size:
                    subprocess.check_call(["git","-C",wt,"apply",str(patch)])
                driver=pathlib.Path(tmp)/"verify.sh"
                driver.write_text('set -uo pipefail\n. "$1/stop-tests.core.sh"\n. "$3/scripts/lane/dprep.sh"\ndprep_ensure_js_deps >&2 || true\nexport RST_TIMEOUT_SECONDS="$(cat "$1/stop-tests.timeout")"\nrst_execute_saved "$1" "$2"\n')
                # Stage mappings from the original replay are deliberately not reused:
                # each stage must be available in this fresh verification environment.
                env=dict(os.environ); env.pop("RST_STAGE_WORKTREES",None)
                verify=subprocess.check_output(["bash",str(driver),str(e),report["wo_class"],str(pathlib.Path.cwd())],cwd=wt,env=env,text=True)
                if "TESTS_STATUS=passed\n" not in verify: counts["false_pass"]+=1
            finally:
                subprocess.check_call(["git","worktree","remove","--force",wt])
        outcome="repaired" if report["repair_result"]=="repaired" else "passed"
    elif status=="blocked": outcome="blocked"
    else: outcome="failed"
    counts[outcome]+=1
    after=json.loads(run("gh","pr","view",str(n),"--repo",repo,"--json","headRefOid"))["headRefOid"]
    if before!=after: sys.exit("REPLAY_HEAD_MOVED: PR %d %s -> %s"%(n,before,after))
    lines=" | ".join(report["stage_lines"]) or report["tests_line"]
    print("%d | %s | %s"%(n,lines,outcome+(":"+report["blocked_reason"] if outcome=="blocked" else "")))
print("REPLAY: "+" ".join("%s=%d"%(key,value) for key,value in counts.items()))
sys.exit(0 if counts["false_pass"]==0 and counts["na_on_code"]==0 else 1)
PY
