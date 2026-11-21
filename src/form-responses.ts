import type { Pool } from 'pg';
import type { Answer, Entry, FormIdentity, Question } from './forms.js';
import { uuid } from './forms.js';
import { escapeHtml as e } from './web-security.js';
export type ReadFormIdentity = (userId:string)=>Promise<FormIdentity|null>;
const validIdentity = (v:FormIdentity|null):v is FormIdentity => !!v && typeof v.username==='string' && !!v.username.trim() && v.username.length<=100 && typeof v.displayName==='string' && !!v.displayName.trim() && v.displayName.length<=100;
// Resolve old ID-only responses in bounded batches; lookup failures never hide answers.
// A submission-time identity is immutable. Legacy lookup names are explicitly labelled current.
export async function enrichFormIdentities(pool:Pick<Pool,'query'>,guildId:string,entries:Entry[],read?:ReadFormIdentity) {
  if(!read)return;
  const users=[...new Set(entries.filter(r=>!r.username && (!r.name_lookup_after||new Date(r.name_lookup_after).getTime()<=Date.now())).map(r=>r.user_id))].slice(0,10);
  await Promise.allSettled(users.map(async userId=>{
    let identity:FormIdentity|null=null;
    try{const result=await read(userId);if(validIdentity(result))identity=result;}catch{/* Discord can be unavailable or the account deleted. */}
    if(identity) {
      await pool.query("UPDATE form_entries SET username=$3,display_name=$4,identity_source='lookup' WHERE guild_id=$1 AND user_id=$2 AND username IS NULL AND state<>'draft'",[guildId,userId,identity.username,identity.displayName]);
      for(const entry of entries)if(entry.user_id===userId&&!entry.username){entry.username=identity.username;entry.display_name=identity.displayName;entry.identity_source='lookup';}
    } else await pool.query("UPDATE form_entries SET name_lookup_after=NOW()+INTERVAL '15 minutes' WHERE guild_id=$1 AND user_id=$2 AND username IS NULL AND state<>'draft'",[guildId,userId]);
  }));
}
export function formUser(entry:Pick<Entry,'user_id'|'username'|'display_name'|'identity_source'>):string {
  return `<div>${e(entry.display_name||entry.username||'Name unavailable')}</div>${entry.username?`<div>@${e(entry.username)}</div>`:''}<div class="small mono">ID: ${e(entry.user_id)}</div>${entry.identity_source==='lookup'?'<div class="small">Name retrieved after submission</div>':''}`;
}
export type AnswerColumn = {key:string;label:string;type:Question['type'];occurrence:number};
function keyed<T extends Pick<Question,'label'|'type'>>(items:T[]) {
  const seen=new Map<string,number>();
  return items.map(item=>{const base=JSON.stringify([item.label,item.type]),occurrence=(seen.get(base)??0)+1;seen.set(base,occurrence);return {item,key:JSON.stringify([item.label,item.type,occurrence]),occurrence};});
}
// Labels/types, rather than array positions, keep older/reordered answers under the right headings.
// Repeated identical labels are numbered in their original order; renames get separate columns.
export function answerColumns(current:Question[],schemas:Question[][]):AnswerColumn[] {
  const columns=new Map<string,AnswerColumn>();
  for(const questions of [current,...schemas])for(const {item,key,occurrence} of keyed(questions))if(!columns.has(key))columns.set(key,{key,label:item.label,type:item.type,occurrence});
  return [...columns.values()];
}
export function answerCell(answer?:Answer):string {
  if(!answer)return '<span class="muted">—</span>';
  if(answer.fileId&&uuid(answer.fileId))return `<a href="/forms/files/${answer.fileId}">Download ${e(answer.filename||'file')}</a>`;
  const value=Array.isArray(answer.value)?answer.value.join('\n'):answer.value;
  if(!value)return '<span class="muted">No answer</span>';
  return value.length>160?`<details><summary>${e(value.slice(0,120))}…</summary><div class="case-reason">${e(value)}</div></details>`:`<div class="case-reason">${e(value)}</div>`;
}
export function answersTable(entries:Entry[],columns:AnswerColumn[]):string {
  return `<div class="table-wrap answers-table" tabindex="0" aria-label="Form answers — scroll horizontally for more questions"><table><thead><tr><th>Submitted by</th><th>Submitted / review</th><th>Status / decision DM</th>${columns.map(c=>`<th>${e(c.label)}${c.occurrence>1?' ('+c.occurrence+')':''}<div class="small">${e(c.type)}</div></th>`).join('')}</tr></thead><tbody>${entries.map(r=>{
    const values=new Map(keyed(r.answers).map(a=>[a.key,a.item]));
    return `<tr><td>${formUser(r)}</td><td><a href="/forms/responses/${e(r.id)}">Open response</a><div class="small">${e(new Date(r.submitted_at).toISOString().replace('T',' ').slice(0,19))} UTC</div><div class="small mono">${e(r.id)}</div></td><td>${e(r.state)}<div class="small">DM: ${e(r.dm_status)}</div></td>${columns.map(c=>`<td>${answerCell(values.get(c.key))}</td>`).join('')}</tr>`;
  }).join('')||`<tr><td colspan="${columns.length+3}">No responses match this filter.</td></tr>`}</tbody></table></div>`;
}
