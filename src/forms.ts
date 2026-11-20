import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { digest } from './web-security.js';
import { getStaffAccess } from './staff-access.js';
export type Question = { label: string; type: 'short'|'paragraph'|'choice'|'checkboxes'|'file'; required: boolean; options: string[] };
export type Form = { id: string; title: string; description: string; questions: Question[]; enabled: boolean; revision: number };
export type Answer = { label: string; type: Question['type']; value: string | string[]; fileId?: string; filename?: string };
export type Entry = { id: string; form_id: string; user_id: string; snapshot: Form; answers: Answer[]; step: number; state: 'draft'|'pending'|'approved'|'rejected'; revision: number; submitted_at: Date; reviewed_by: string|null; reviewed_at: Date|null; decision_message: string; dm_status: string };
export type UploadedFile = { id: string; filename: string; data: Buffer };
export type StaffContext = { guildId: string; actorId: string; token: string; readRoles: (id: string) => Promise<string[] | null> };
export class FormError extends Error { constructor(public readonly code: string) { super(code); } }
export const uuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
export const snowflake = (id: string) => /^\d{17,20}$/.test(id);
export function validateForm(f: Omit<Form,'id'|'revision'>) {
  if (typeof f.title !== 'string' || !f.title.trim() || f.title.trim().length > 45 || typeof f.description !== 'string' || f.description.length > 1000 || typeof f.enabled !== 'boolean' || !Array.isArray(f.questions) || f.questions.length < 1 || f.questions.length > 25) throw new FormError('INVALID_INPUT');
  for (const q of f.questions) {
    if (!q || typeof q.label !== 'string' || !q.label.trim() || q.label.length > 100 || !['short','paragraph','choice','checkboxes','file'].includes(q.type) || typeof q.required !== 'boolean' || !Array.isArray(q.options) || q.options.some(o => typeof o !== 'string' || !o.trim() || o.length > 100)) throw new FormError('INVALID_INPUT');
    const choice = q.type === 'choice' || q.type === 'checkboxes';
    if (choice ? q.options.length < 2 || q.options.length > 10 || new Set(q.options).size !== q.options.length : q.options.length !== 0) throw new FormError('INVALID_INPUT');
  }
}
async function transaction<T>(pool: Pick<Pool,'connect'>, run: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect(); let discard = false;
  try { await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='5s'"); const result = await run(db); await db.query('COMMIT'); return result; }
  catch (error) { try { await db.query('ROLLBACK'); } catch { discard = true; } if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') throw new FormError('BUSY'); throw error; }
  finally { db.release(discard ? new Error('Forms connection unavailable') : undefined); }
}
async function lockGuild(db: PoolClient, guild: string) {
  if (!(await db.query('SELECT 1 FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[guild])).rowCount) throw new FormError('NOT_FOUND');
}
export async function requireFormStaff(db: Pick<Pool,'query'>, i: StaffContext, admin = false) {
  if (!(await db.query('SELECT 1 FROM dashboard_sessions WHERE guild_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>NOW()',[i.guildId,i.actorId,digest(i.token)])).rowCount) throw new FormError('SESSION_EXPIRED');
  const roles = await i.readRoles(i.actorId), access = roles ? await getStaffAccess(db,i.guildId,i.actorId,roles) : 'none';
  if (access === 'none' || admin && access !== 'admin') throw new FormError('STAFF_REQUIRED');
}
async function audit(db: PoolClient, guild: string, actor: string, event: string, details: object) {
  await db.query('INSERT INTO audit_events(guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)',[guild,actor,event,JSON.stringify(details)]);
}
export async function saveForm(pool: Pick<Pool,'connect'>, i: StaffContext & { id: string; revision: number; form: Omit<Form,'id'|'revision'> }) {
  validateForm(i.form);
  if (!uuid(i.id) || !Number.isInteger(i.revision) || i.revision < 0 || i.revision >= 2147483647) throw new FormError('INVALID_INPUT');
  await transaction(pool,async db => {
    await lockGuild(db,i.guildId); await requireFormStaff(db,i,true);
    const old = (await db.query<Form>('SELECT * FROM forms WHERE guild_id=$1 AND id=$2',[i.guildId,i.id])).rows[0];
    if ((old?.revision ?? 0) !== i.revision) throw new FormError('STALE');
    if (!old && Number((await db.query<{count:string}>('SELECT count(*) FROM forms WHERE guild_id=$1',[i.guildId])).rows[0]!.count) >= 50) throw new FormError('LIMIT');
    await db.query(`INSERT INTO forms(guild_id,id,title,description,questions,enabled,revision,updated_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
      ON CONFLICT(guild_id,id) DO UPDATE SET title=$3,description=$4,questions=$5::jsonb,enabled=$6,revision=$7,updated_by=$8,updated_at=NOW()`,
      [i.guildId,i.id,i.form.title.trim(),i.form.description.trim(),JSON.stringify(i.form.questions),i.form.enabled,i.revision+1,i.actorId]);
    await audit(db,i.guildId,i.actorId,'FORM_SAVED',{form_id:i.id,revision:i.revision+1,enabled:i.form.enabled});
  });
}
export async function queueFormPost(pool: Pick<Pool,'connect'>, i: StaffContext & { id: string; formId: string; revision: number; channelId: string; readChannels: () => Promise<{id:string;usable:boolean}[]> }) {
  if (!uuid(i.id) || !uuid(i.formId) || !snowflake(i.channelId)) throw new FormError('INVALID_INPUT');
  await transaction(pool,async db => {
    await lockGuild(db,i.guildId); await requireFormStaff(db,i,true);
    // Replaying the same dashboard POST never queues another publication.
    if ((await db.query('SELECT 1 FROM form_publications WHERE guild_id=$1 AND id=$2',[i.guildId,i.id])).rowCount) return;
    const f = (await db.query<Form>('SELECT * FROM forms WHERE guild_id=$1 AND id=$2',[i.guildId,i.formId])).rows[0];
    if (!f?.enabled || f.revision !== i.revision) throw new FormError('STALE');
    if (!(await i.readChannels()).some(c=>c.id===i.channelId && c.usable)) throw new FormError('CHANNEL');
    await db.query('INSERT INTO form_publications(guild_id,id,form_id,form_revision,channel_id,actor_id) VALUES ($1,$2,$3,$4,$5,$6)',[i.guildId,i.id,i.formId,i.revision,i.channelId,i.actorId]);
    await audit(db,i.guildId,i.actorId,'FORM_POST_QUEUED',{form_id:i.formId,channel_id:i.channelId});
  });
}
export async function startForm(pool: Pick<Pool,'connect'>, guild: string, formId: string, user: string): Promise<Entry> {
  if (!uuid(formId) || !snowflake(user)) throw new FormError('INVALID_INPUT');
  return transaction(pool,async db => {
    await lockGuild(db,guild);
    const f = (await db.query<Form>('SELECT * FROM forms WHERE guild_id=$1 AND id=$2 AND enabled',[guild,formId])).rows[0];
    if (!f) throw new FormError('CLOSED');
    const current = (await db.query<Entry & {alive:boolean}>(`SELECT *,expires_at>NOW() AS alive FROM form_entries WHERE guild_id=$1 AND form_id=$2 AND user_id=$3 AND state='draft'`,[guild,formId,user])).rows[0];
    if (current?.alive && current.snapshot.revision === f.revision) return current;
    if (current) await db.query('DELETE FROM form_entries WHERE guild_id=$1 AND id=$2',[guild,current.id]);
    if ((await db.query("SELECT 1 FROM form_entries WHERE guild_id=$1 AND user_id=$2 AND submitted_at>NOW()-INTERVAL '1 minute'",[guild,user])).rowCount) throw new FormError('COOLDOWN');
    const result = await db.query<Entry>('INSERT INTO form_entries(guild_id,id,form_id,user_id,snapshot) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *',[guild,randomUUID(),formId,user,JSON.stringify(f)]);
    return result.rows[0]!;
  });
}
export async function loadDraft(pool: Pick<Pool,'query'>, guild: string, id: string, user: string): Promise<Entry> {
  if (!uuid(id)) throw new FormError('INVALID_INPUT');
  const e = (await pool.query<Entry>(`SELECT e.* FROM form_entries e JOIN forms f ON f.guild_id=e.guild_id AND f.id=e.form_id
    WHERE e.guild_id=$1 AND e.id=$2 AND e.user_id=$3 AND e.state='draft' AND e.expires_at>NOW() AND f.enabled
    AND f.revision=(e.snapshot->>'revision')::integer`,[guild,id,user])).rows[0];
  if (!e) throw new FormError('EXPIRED'); return e;
}
export function validateAnswers(questions: Question[], answers: Answer[], files: UploadedFile[]) {
  if (answers.length !== questions.length || files.length > questions.length || new Set(files.map(f=>f.id)).size !== files.length) throw new FormError('INVALID_ANSWERS');
  const used = new Set<string>();
  for (const [n,q] of questions.entries()) {
    const a = answers[n]!;
    if (!a || a.type !== q.type || a.label !== q.label) throw new FormError('INVALID_ANSWERS');
    if (q.type === 'short' || q.type === 'paragraph') {
      if (typeof a.value !== 'string' || a.value.length > (q.type === 'short'?300:4000) || q.required && !a.value.trim() || a.fileId) throw new FormError('INVALID_ANSWERS');
    } else if (q.type === 'choice' || q.type === 'checkboxes') {
      if (!Array.isArray(a.value) || q.required && !a.value.length || q.type === 'choice' && a.value.length > 1 || new Set(a.value).size !== a.value.length || a.value.some(v=>!q.options.includes(v)) || a.fileId) throw new FormError('INVALID_ANSWERS');
    } else {
      const file = files.find(f=>f.id===a.fileId);
      if (a.value !== '' || q.required && !file || a.fileId && (!file || !uuid(a.fileId) || file.filename !== a.filename)) throw new FormError('INVALID_ANSWERS');
      if (file) { if (used.has(file.id) || !file.filename || file.filename.length>255 || !Buffer.isBuffer(file.data) || file.data.length>10*1024*1024) throw new FormError('FILE_SIZE'); used.add(file.id); }
    }
  }
  if (used.size !== files.length || files.reduce((n,f)=>n+f.data.length,0)>20*1024*1024) throw new FormError('FILE_SIZE');
}
export async function submitFormStep(pool: Pick<Pool,'connect'>, i: {guildId:string;id:string;userId:string;step:number;interactionId:string;answers:Answer[];files:UploadedFile[]}): Promise<Entry> {
  if (!uuid(i.id) || !snowflake(i.interactionId) || !Number.isInteger(i.step)) throw new FormError('INVALID_INPUT');
  return transaction(pool,async db => {
    await lockGuild(db,i.guildId);
    const repeated = (await db.query<{entry_id:string}>('SELECT entry_id FROM form_steps WHERE guild_id=$1 AND interaction_id=$2',[i.guildId,i.interactionId])).rows[0];
    if (repeated) {
      const e = (await db.query<Entry>('SELECT * FROM form_entries WHERE guild_id=$1 AND id=$2 AND user_id=$3',[i.guildId,repeated.entry_id,i.userId])).rows[0];
      if (!e || e.id !== i.id) throw new FormError('EXPIRED'); return e;
    }
    const e = await loadDraft(db,i.guildId,i.id,i.userId);
    if (e.step !== i.step) throw new FormError('STALE');
    const questions = e.snapshot.questions.slice(i.step*5,(i.step+1)*5);
    if (!questions.length) throw new FormError('EXPIRED');
    validateAnswers(questions,i.answers,i.files);
    const total = Number((await db.query<{size:string}>('SELECT COALESCE(sum(octet_length(data)),0) AS size FROM form_files WHERE guild_id=$1 AND entry_id=$2',[i.guildId,i.id])).rows[0]!.size);
    if (total+i.files.reduce((n,f)=>n+f.data.length,0)>20*1024*1024) throw new FormError('FILE_SIZE');
    for (const f of i.files) await db.query('INSERT INTO form_files(guild_id,id,entry_id,filename,data) VALUES ($1,$2,$3,$4,$5)',[i.guildId,f.id,i.id,f.filename,f.data]);
    await db.query('INSERT INTO form_steps(guild_id,interaction_id,entry_id,step) VALUES ($1,$2,$3,$4)',[i.guildId,i.interactionId,i.id,i.step]);
    const done = (i.step+1)*5>=e.snapshot.questions.length;
    if (done && (await db.query("SELECT 1 FROM form_entries WHERE guild_id=$1 AND user_id=$2 AND submitted_at>NOW()-INTERVAL '1 minute'",[i.guildId,i.userId])).rowCount) throw new FormError('COOLDOWN');
    const result = await db.query<Entry>(`UPDATE form_entries SET answers=$3::jsonb,step=step+1,state=$4,submitted_at=CASE WHEN $4='pending' THEN NOW() ELSE NULL END
      WHERE guild_id=$1 AND id=$2 RETURNING *`,[i.guildId,i.id,JSON.stringify([...e.answers,...i.answers]),done?'pending':'draft']);
    if (done) await audit(db,i.guildId,i.userId,'FORM_SUBMITTED',{form_id:e.form_id,entry_id:e.id});
    return result.rows[0]!;
  });
}
export async function reviewForm(pool: Pick<Pool,'connect'>, i: StaffContext & {id:string;revision:number;decision:'approved'|'rejected';message:string}) {
  if (!uuid(i.id) || !['approved','rejected'].includes(i.decision) || typeof i.message!=='string' || i.message.length>1000) throw new FormError('INVALID_INPUT');
  await transaction(pool,async db => {
    await lockGuild(db,i.guildId); await requireFormStaff(db,i);
    const e = (await db.query<Entry>('SELECT * FROM form_entries WHERE guild_id=$1 AND id=$2',[i.guildId,i.id])).rows[0];
    if (!e || e.state==='draft') throw new FormError('NOT_FOUND');
    if (e.state!=='pending' || e.revision!==i.revision) throw new FormError('STALE');
    await db.query(`UPDATE form_entries SET state=$3,revision=revision+1,reviewed_by=$4,reviewed_at=NOW(),decision_message=$5,dm_status='pending' WHERE guild_id=$1 AND id=$2`,[i.guildId,i.id,i.decision,i.actorId,i.message.trim()]);
    await audit(db,i.guildId,i.actorId,'FORM_REVIEWED',{form_id:e.form_id,entry_id:e.id,decision:i.decision});
  });
}
