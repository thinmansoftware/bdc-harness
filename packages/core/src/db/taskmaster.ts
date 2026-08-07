import { randomUUID } from 'crypto';
import { getDatabase } from './connection';

export type PauseState = 'RUNNING' | 'PAUSED' | 'HARD_PAUSE';
export interface TaskmasterAction {
  id?: string; created_at?: string; thread_ref: string; action_type: string;
  proposal_json: string; idempotency_key: string; before_hash?: string | null;
  proof_predicate?: string | null; proof_deadline_at?: string | null; outcome: string;
  graded_at?: string | null; grade?: string | null;
}
export interface TaskmasterControl { id: 1; pause_state: PauseState; pause_scope: string | null; pause_reason: string | null; pause_actor: string | null; epoch: number; updated_at: string }

export async function recordAction(action: TaskmasterAction): Promise<TaskmasterAction> {
  const id = action.id ?? randomUUID(); const created = action.created_at ?? new Date().toISOString();
  const result = await getDatabase().query<TaskmasterAction>(`INSERT INTO tm_journal
    (id,created_at,thread_ref,action_type,proposal_json,idempotency_key,before_hash,proof_predicate,proof_deadline_at,outcome,graded_at,grade)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
    [id,created,action.thread_ref,action.action_type,action.proposal_json,action.idempotency_key,action.before_hash??null,action.proof_predicate??null,action.proof_deadline_at??null,action.outcome,action.graded_at??null,action.grade??null]);
  if (result.rows[0]) return result.rows[0];
  const existing = await getDatabase().query<TaskmasterAction>(
    'SELECT * FROM tm_journal WHERE idempotency_key = $1',
    [action.idempotency_key]
  );
  if (!existing.rows[0]) throw new Error('taskmaster_journal_conflict_row_missing');
  return existing.rows[0];
}
export async function getActionsSince(since: string, threadRef?: string): Promise<TaskmasterAction[]> {
  const result = await getDatabase().query<TaskmasterAction>(`SELECT * FROM tm_journal WHERE created_at >= $1${threadRef?' AND thread_ref = $2':''} ORDER BY created_at`, threadRef?[since,threadRef]:[since]); return result.rows;
}
export async function updateActionOutcome(idempotencyKey:string,outcome:string):Promise<void>{await getDatabase().query('UPDATE tm_journal SET outcome=$1 WHERE idempotency_key=$2',[outcome,idempotencyKey]);}
export async function upsertHealthSample(sample: {provider:string;state:string;sampled_at:string;expires_at:string;evidence:string}): Promise<void> {
  await getDatabase().query(`INSERT INTO tm_health(provider,state,sampled_at,expires_at,evidence) VALUES($1,$2,$3,$4,$5) ON CONFLICT(provider) DO UPDATE SET state=excluded.state,sampled_at=excluded.sampled_at,expires_at=excluded.expires_at,evidence=excluded.evidence`,Object.values(sample));
}
export async function getHealthSample(provider:string) { const r=await getDatabase().query<Record<string,unknown>>('SELECT * FROM tm_health WHERE provider=$1 AND expires_at>$2',[provider,new Date().toISOString()]); return r.rows[0]??null; }
export async function getPauseState(): Promise<TaskmasterControl> { const r=await getDatabase().query<TaskmasterControl>('SELECT * FROM tm_control WHERE id=1'); if(r.rows[0]) return {...r.rows[0],epoch:Number(r.rows[0].epoch)}; const now=new Date().toISOString(); await getDatabase().query("INSERT INTO tm_control(id,pause_state,epoch,updated_at) VALUES(1,'RUNNING',0,$1)",[now]); return {id:1,pause_state:'RUNNING',pause_scope:null,pause_reason:null,pause_actor:null,epoch:0,updated_at:now}; }
export async function setPauseState(state:PauseState, actor:string, reason:string): Promise<TaskmasterControl> { const current=await getPauseState(); if(state==='RUNNING' && actor.toLowerCase()!=='john') throw new Error('taskmaster_resume_requires_john'); const epoch=current.epoch+(state==='RUNNING'?1:0); const now=new Date().toISOString(); await getDatabase().query('UPDATE tm_control SET pause_state=$1,pause_reason=$2,pause_actor=$3,epoch=$4,updated_at=$5 WHERE id=1',[state,reason,actor,epoch,now]); return {...current,pause_state:state,pause_reason:reason,pause_actor:actor,epoch,updated_at:now}; }
export async function recordUsageSample(sample:{provider:string;window_kind:string;source:string;observed_at?:string;value_json:string;confidence:string;is_unknown:boolean}):Promise<void>{await getDatabase().query('INSERT INTO tm_usage_sample(id,provider,window_kind,source,observed_at,value_json,confidence,is_unknown) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),sample.provider,sample.window_kind,sample.source,sample.observed_at??new Date().toISOString(),sample.value_json,sample.confidence,sample.is_unknown?1:0]);}
