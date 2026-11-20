import type { Pool } from 'pg';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import type { Form, Entry } from './forms.js';
import { getStaffAccess } from './staff-access.js';
export type FormsDelivery = {
  readRoles: (id:string)=>Promise<string[]|null>;
  readChannels: ()=>Promise<{id:string;usable:boolean}[]>;
  post: (channelId:string,body:RESTPostAPIChannelMessageJSONBody)=>Promise<string>;
  dm: (userId:string,body:RESTPostAPIChannelMessageJSONBody)=>Promise<string>;
};
type Post = {id:string;form_id:string;form_revision:number;channel_id:string;actor_id:string};
function outcome(error: unknown): 'failed'|'unknown' {
  const code=error && typeof error==='object' && 'code' in error?Number(error.code):0;
  return [10003,10007,50001,50007,50013,50035].includes(code)?'failed':'unknown';
}
export async function deliverForms(pool: Pick<Pool,'query'>,guild: string,deps: FormsDelivery): Promise<void> {
  // Claim before touching Discord. A crash or uncertain send is visible, never automatically repeated.
  await pool.query("DELETE FROM form_entries WHERE guild_id=$1 AND state='draft' AND expires_at<=NOW()",[guild]);
  await pool.query("UPDATE form_publications SET status='unknown' WHERE guild_id=$1 AND status='sending' AND started_at<NOW()-INTERVAL '2 minutes'",[guild]);
  await pool.query("UPDATE form_entries SET dm_status='unknown' WHERE guild_id=$1 AND dm_status='sending' AND dm_started_at<NOW()-INTERVAL '2 minutes'",[guild]);
  const p=(await pool.query<Post>(`UPDATE form_publications SET status='sending',started_at=NOW() WHERE guild_id=$1 AND id=(
    SELECT id FROM form_publications WHERE guild_id=$1 AND status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) AND status='pending' RETURNING *`,[guild])).rows[0];
  if (p) {
    let status: 'sent'|'failed'|'unknown'='failed',messageId: string|null=null;
    try {
      const f=(await pool.query<Form>('SELECT * FROM forms WHERE guild_id=$1 AND id=$2',[guild,p.form_id])).rows[0];
      const roles=await deps.readRoles(p.actor_id);
      if (f?.enabled && f.revision===p.form_revision && roles && await getStaffAccess(pool,guild,p.actor_id,roles)==='admin' && (await deps.readChannels()).some(c=>c.id===p.channel_id&&c.usable)) {
        messageId=await deps.post(p.channel_id,{embeds:[{title:f.title,description:f.description||'Complete this form privately in Discord.',footer:{text:'Responses are reviewed by Maru staff. Your Discord identity is included.'}}],
          components:[{type:1,components:[{type:2,style:1,label:'Fill out form',custom_id:`forms:start:${f.id}`}]}],allowed_mentions:{parse:[]}});
        status='sent';
      }
    } catch (error) { status=outcome(error); }
    await pool.query("UPDATE form_publications SET status=$3,message_id=$4 WHERE guild_id=$1 AND id=$2 AND status='sending'",[guild,p.id,status,messageId]);
  }
  const e=(await pool.query<Entry>(`UPDATE form_entries SET dm_status='sending',dm_started_at=NOW() WHERE guild_id=$1 AND id=(
    SELECT id FROM form_entries WHERE guild_id=$1 AND dm_status='pending' ORDER BY reviewed_at FOR UPDATE SKIP LOCKED LIMIT 1) AND dm_status='pending' RETURNING *`,[guild])).rows[0];
  if (e) {
    let status: 'sent'|'failed'|'unknown'='unknown';
    try {
      await deps.dm(e.user_id,{content:`Your submission to “${e.snapshot.title}” was ${e.state}.\nReference: ${e.id}${e.decision_message?'\n\n'+e.decision_message:''}`,allowed_mentions:{parse:[]}});
      status='sent';
    } catch (error) { status=outcome(error); }
    await pool.query("UPDATE form_entries SET dm_status=$3 WHERE guild_id=$1 AND id=$2 AND dm_status='sending'",[guild,e.id,status]);
  }
}
export function startFormsWorker(pool: Pick<Pool,'query'>,guild: string,deps: FormsDelivery,ready: ()=>boolean) {
  let stopping=false,work: Promise<unknown>|undefined;
  const timer=setInterval(()=>{
    if (stopping||work||!ready()) return;
    work=deliverForms(pool,guild,deps).catch(()=>console.error('Forms delivery is waiting for saved work.')).finally(()=>{work=undefined;});
  },5000); timer.unref();
  return {stop:async()=>{stopping=true;clearInterval(timer);await work;}};
}
