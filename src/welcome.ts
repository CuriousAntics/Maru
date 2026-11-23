import type { Pool, PoolClient } from 'pg';
import { digest } from './web-security.js';
import { getStaffAccess } from './staff-access.js';
export const defaultWelcome = 'Welcome to {server_name} {member}! Introduce yourself and check out {channel} for more information.';
export type WelcomeSettings = {enabled:boolean;channel_id:string|null;info_channel_id:string|null;template:string;revision:number};
export type WelcomeResources = {eventsReady:boolean;serverName:string;channels:{id:string;name:string;postable:boolean;linkable:boolean}[]};
export type WelcomeJoin = {guildId:string;userId:string;joinedAt:string;observedAt:number};
export type WelcomeJob = {guild_id:string;user_id:string;joined_at:Date|string;revision:number;channel_id:string;info_channel_id:string;template:string;status:string;message_id:string|null;created_at:Date;started_at:Date|null};
export type WelcomeDependencies = {
  resources:()=>Promise<WelcomeResources>;
  member:(id:string)=>Promise<{joinedAt:string;bot:boolean}|null>;
  send:(job:WelcomeJob,content:string)=>Promise<string>;
};
export class WelcomeError extends Error {constructor(public readonly code:string){super(code);}}
const id=(v:string)=>typeof v==='string'&&/^\d{17,20}$/.test(v);
export function validateWelcomeTemplate(template:string) {
  if(typeof template!=='string'||!template.trim()||template.length>1000||/[{}]/.test(template.replace(/\{(?:server_name|member|channel)\}/g,'')))throw new WelcomeError('TEMPLATE');
}
export function renderWelcome(template:string,serverName:string,userId:string,channelId:string) {
  validateWelcomeTemplate(template);
  if(!id(userId)||!id(channelId))throw new WelcomeError('INVALID_INPUT');
  // Guild names are literal text, never additional template syntax or Markdown mentions.
  const server=serverName.replace(/([\\`*_~|>\[\](){}<>])/g,'\\$1').replace(/@/g,'@\u200b');
  const values:Record<string,string>={server_name:server,member:`<@${userId}>`,channel:`<#${channelId}>`};
  const content=template.replace(/\{(server_name|member|channel)\}/g,(_,key:string)=>values[key]!);
  if(content.length>2000)throw new WelcomeError('TEMPLATE');return content;
}
async function tx<T>(pool:Pick<Pool,'connect'>,run:(db:PoolClient)=>Promise<T>):Promise<T> {
  const db=await pool.connect();let discard=false;
  try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");const result=await run(db);await db.query('COMMIT');return result;}
  catch(e){try{await db.query('ROLLBACK');}catch{discard=true;}if(e&&typeof e==='object'&&'code'in e&&e.code==='55P03')throw new WelcomeError('BUSY');throw e;}
  finally{db.release(discard?new Error('Welcome connection unavailable'):undefined);}
}
async function lock(db:PoolClient,guildId:string){if(!(await db.query('SELECT 1 FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[guildId])).rowCount)throw new WelcomeError('NOT_CONFIGURED');}
async function audit(db:PoolClient,guildId:string,actorId:string,event:string,details:object){await db.query('INSERT INTO audit_events(guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)',[guildId,actorId,event,JSON.stringify(details)]);}
export async function readWelcomeSettings(db:Pick<Pool,'query'>,guildId:string):Promise<WelcomeSettings>{
  return (await db.query<WelcomeSettings>('SELECT * FROM welcome_settings WHERE guild_id=$1',[guildId])).rows[0]??{enabled:false,channel_id:null,info_channel_id:null,template:defaultWelcome,revision:0};
}
export async function saveWelcomeSettings(pool:Pick<Pool,'connect'>,i:{guildId:string;actorId:string;token:string;revision:number;enabled:boolean;channelId:string|null;infoChannelId:string|null;template:string;readRoles:(id:string)=>Promise<string[]|null>;resources:()=>Promise<WelcomeResources>}) {
  validateWelcomeTemplate(i.template);
  if(typeof i.enabled!=='boolean'||!Number.isInteger(i.revision)||i.revision<0||i.revision>=2147483647||[i.channelId,i.infoChannelId].some(v=>v!==null&&!id(v)))throw new WelcomeError('INVALID_INPUT');
  await tx(pool,async db=>{
    await lock(db,i.guildId);
    if(!(await db.query('SELECT 1 FROM dashboard_sessions WHERE guild_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>NOW()',[i.guildId,i.actorId,digest(i.token)])).rowCount)throw new WelcomeError('SESSION_EXPIRED');
    const roles=await i.readRoles(i.actorId);if(!roles||await getStaffAccess(db,i.guildId,i.actorId,roles)!=='admin')throw new WelcomeError('ADMIN_REQUIRED');
    const before=await readWelcomeSettings(db,i.guildId);if(before.revision!==i.revision)throw new WelcomeError('STALE');
    if(i.enabled){
      const r=await i.resources();if(!r.eventsReady)throw new WelcomeError('EVENTS_DISABLED');
      if(!r.channels.some(c=>c.id===i.channelId&&c.postable)||!r.channels.some(c=>c.id===i.infoChannelId&&c.linkable))throw new WelcomeError('CHANNEL');
      renderWelcome(i.template,r.serverName,i.actorId,i.infoChannelId!);
    }
    if(before.enabled===i.enabled&&before.channel_id===i.channelId&&before.info_channel_id===i.infoChannelId&&before.template===i.template)return;
    await db.query(`INSERT INTO welcome_settings(guild_id,enabled,channel_id,info_channel_id,template,revision,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(guild_id) DO UPDATE SET enabled=$2,channel_id=$3,info_channel_id=$4,template=$5,revision=$6,updated_by=$7,updated_at=NOW()`,[i.guildId,i.enabled,i.channelId,i.infoChannelId,i.template,i.revision+1,i.actorId]);
    await db.query("UPDATE welcome_jobs SET status='cancelled',finished_at=NOW() WHERE guild_id=$1 AND status='pending'",[i.guildId]);
    await audit(db,i.guildId,i.actorId,'WELCOME_SETTINGS_CHANGED',{enabled:i.enabled,channel_id:i.channelId,info_channel_id:i.infoChannelId,revision:i.revision+1});
  });
}
export function parseWelcomeJoin(packet:unknown,guildId:string,now=Date.now()):WelcomeJoin|null {
  if(!packet||typeof packet!=='object')return null;const p=packet as {t?:string;d?:any},d=p.d;
  if(p.t!=='GUILD_MEMBER_ADD'||!d||d.guild_id!==guildId||!id(d.user?.id??'')||d.user.bot||typeof d.joined_at!=='string')return null;
  const joined=Date.parse(d.joined_at);if(!Number.isFinite(joined)||now-joined>120000||joined-now>30000)return null;
  return {guildId,userId:d.user.id,joinedAt:new Date(joined).toISOString(),observedAt:now};
}
export async function enqueueWelcome(pool:Pick<Pool,'connect'>,join:WelcomeJoin) {
  await tx(pool,async db=>{
    await lock(db,join.guildId);
    await db.query(`INSERT INTO welcome_jobs(guild_id,user_id,joined_at,revision,channel_id,info_channel_id,template)
      SELECT guild_id,$2,$3,revision,channel_id,info_channel_id,template FROM welcome_settings
      WHERE guild_id=$1 AND enabled AND updated_at<=$4 AND $3::timestamptz>NOW()-INTERVAL '10 minutes'
      ON CONFLICT DO NOTHING`,[join.guildId,join.userId,join.joinedAt,new Date(join.observedAt)]);
  });
}
export async function deliverWelcome(pool:Pick<Pool,'query'|'connect'>,guildId:string,deps:WelcomeDependencies) {
  await pool.query("UPDATE welcome_jobs SET status='unknown',finished_at=NOW() WHERE guild_id=$1 AND status='sending' AND started_at<NOW()-INTERVAL '2 minutes'",[guildId]);
  const job=await tx(pool,async db=>{
    await lock(db,guildId);
    await db.query(`UPDATE welcome_jobs j SET status='cancelled',finished_at=NOW() WHERE j.guild_id=$1 AND j.status='pending' AND
      (j.joined_at<NOW()-INTERVAL '10 minutes' OR NOT EXISTS(SELECT 1 FROM welcome_settings s WHERE s.guild_id=j.guild_id AND s.enabled AND s.revision=j.revision))`,[guildId]);
    const j=(await db.query<WelcomeJob>(`UPDATE welcome_jobs SET status='sending',started_at=NOW() WHERE guild_id=$1 AND (user_id,joined_at)=(
      SELECT user_id,joined_at FROM welcome_jobs WHERE guild_id=$1 AND status='pending' ORDER BY created_at,user_id FOR UPDATE SKIP LOCKED LIMIT 1) AND status='pending' RETURNING *`,[guildId])).rows[0];
    if(j)await audit(db,guildId,j.user_id,'WELCOME_SEND_REQUESTED',{user_id:j.user_id,joined_at:j.joined_at,channel_id:j.channel_id,revision:j.revision});return j;
  });
  if(!job)return;
  let status='cancelled',messageId:string|null=null;
  try {
    const member=await deps.member(job.user_id),r=await deps.resources(),settings=await readWelcomeSettings(pool,guildId);
    if(member&&!member.bot&&new Date(member.joinedAt).getTime()===new Date(job.joined_at).getTime()&&r.eventsReady&&settings.enabled&&settings.revision===job.revision&&
      r.channels.some(c=>c.id===job.channel_id&&c.postable)&&r.channels.some(c=>c.id===job.info_channel_id&&c.linkable)){
      // Any uncertain request may have posted: persist an unknown outcome, never blindly resend.
      status='unknown';messageId=await deps.send(job,renderWelcome(job.template,r.serverName,job.user_id,job.info_channel_id));
      if(!id(messageId))throw new Error('INVALID_MESSAGE');status='sent';
    }
  }catch(e){const code=e&&typeof e==='object'&&'code'in e?Number(e.code):0;status=[10003,10007,50001,50013,50035].includes(code)?'failed':'unknown';}
  await tx(pool,async db=>{
    const changed=await db.query("UPDATE welcome_jobs SET status=$4,message_id=$5,finished_at=NOW() WHERE guild_id=$1 AND user_id=$2 AND joined_at=$3 AND status='sending'",[guildId,job.user_id,job.joined_at,status,messageId]);
    if(changed.rowCount)await audit(db,guildId,job.user_id,'WELCOME_SEND_RESULT',{user_id:job.user_id,joined_at:job.joined_at,channel_id:job.channel_id,status,message_id:messageId});
  });
}
export function startWelcomeWorker(pool:Pick<Pool,'query'|'connect'>,guildId:string,deps:WelcomeDependencies,ready:()=>boolean) {
  let stopping=false,work:Promise<unknown>|undefined;const queue=new Map<string,WelcomeJoin>();
  const tick=async()=>{
    for(const [key,join] of queue){if(Date.now()-join.observedAt>600000){queue.delete(key);continue;}await enqueueWelcome(pool,join);queue.delete(key);}
    await deliverWelcome(pool,guildId,deps);
  };
  const timer=setInterval(()=>{if(stopping||work||!ready())return;work=tick().catch(()=>console.error('Welcome work is waiting for Discord or the database.')).finally(()=>{work=undefined;});},2000);timer.unref();
  return {accept:(packet:unknown)=>{if(stopping||!ready())return;const join=parseWelcomeJoin(packet,guildId);if(join){const key=join.userId+':'+join.joinedAt;if(queue.size<1000||queue.has(key))queue.set(key,join);else console.error('Welcome intake is full; a join was not queued.');}},stop:async()=>{stopping=true;clearInterval(timer);await work;for(const [key,join] of queue){await enqueueWelcome(pool,join);queue.delete(key);}}};
}
