import { expect,test } from 'bun:test';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for(const scenario of ['success','failing-report','missing-report','malformed-report','admission-after-insert','admission-readback',
  'completion-write','completion-readback','retention-fail','cancel-reject','cancel-hang','cancel-repeat-reject','check-writer-hang'])
test(`minimal controller full mocked branch: ${scenario}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'teetime-orchestration-'));
  try {
    const env:Record<string,string>={BUN_ENV:'test',ARCHON_TELEMETRY_DISABLED:'1',DO_NOT_TRACK:'1'};
    for(const key of ['SYSTEMROOT','WINDIR','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key]!;
    const child=Bun.spawn([process.execPath,'--no-env-file',join(import.meta.dirname,'teetime-minimal-controller.fixture.ts'),scenario,root],
      {stdin:'ignore',stdout:'pipe',stderr:'pipe',env});
    const timeout=setTimeout(()=>child.kill(),10000);
    let out:string,err:string,exit:number;
    try {[out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);}
    finally {clearTimeout(timeout);}
    const audit=JSON.parse(await readFile(join(root,'audit.json'),'utf8'));
    // Bun currently warns about an existing duplicate yaml dependency key.
    // This fixture verifies lifecycle behavior, not package-manifest cleanup.
    expect(err).not.toContain('error:');expect(audit.unchanged).toBe(true);expect(audit.run.status).toBe('paused');
    expect(audit.records,audit.failure?.message).toHaveLength(5);expect(audit.claimRetained).toBe(true);
    const row=audit.records[4];expect(row.nodeId).toBe('diagnose-transport');expect(row.attemptNumber).toBe(1);expect(row.supersedesAttemptId).toBeNull();
    if(scenario==='success'||scenario==='cancel-repeat-reject'){
      expect(exit).toBe(0);expect(row.outcomeClass).toBe('success');expect(audit.lockRetained).toBe(false);
      expect(out).toContain('"type":"RESULT"');
      expect(audit.events.indexOf('cancel')).toBeLessThan(audit.events.indexOf('complete:execution_completed'));
      expect(audit.events.indexOf('complete:execution_completed')).toBeLessThan(audit.events.indexOf('emitted-result'));
    }else{
      expect(exit).toBe(1);expect(audit.lockRetained).toBe(true);
      if(scenario==='failing-report')expect(row.reasonCode).toBe('required_stage_failed');
      else if(['admission-readback','completion-write','completion-readback'].includes(scenario))
        expect(audit.failure.name).toBe('MinimalPersistenceUnresolved');
      else expect(row.reasonCode).toBe('required_stage_indeterminate');
      if(scenario!=='failing-report')expect(out).not.toContain('"type":"RESULT"');
    }
    if(scenario.startsWith('admission-'))expect(audit.events).not.toContain('launch');
    if(scenario==='cancel-repeat-reject')expect(audit.events.filter((event:string)=>event==='cancel')).toHaveLength(1);
    if(scenario==='check-writer-hang')expect(String(audit.failure.message),String(audit.failure.stack)).toBe('minimal check cleanup uncertain');
    const launched=audit.events.indexOf('launch');
    if(launched>=0){expect(audit.events.indexOf('insert')).toBeLessThan(launched);
      expect(audit.events.slice(0,launched)).toContain('list:5');}
    if(audit.events.includes('frame'))expect(audit.events.indexOf('emitted-ready')).toBeLessThan(audit.events.indexOf('frame'));
  }finally{await rm(root,{recursive:true});}
},15000);
