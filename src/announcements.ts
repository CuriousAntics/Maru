import {randomUUID} from 'node:crypto';
import type {APIEmbed} from 'discord.js';
import type {Pool,PoolClient} from 'pg';
import {digest} from './web-security.js';
import {getStaffAccess} from './staff-access.js';
import {nextPostTime} from './post-schedule.js';
import type {PostSchedule} from './post-schedule.js';
export type PostPayload={content:string;embeds:APIEmbed[];files:string[];retained:{id:string;filename:string}[];roles:string[];everyone:boolean;here:boolean};
export type Announcement={id:string;title:string;channel_id:string;payload:PostPayload;schedule:PostSchedule|null;state:'draft'|'active'|'paused'|'completed'|'deleted';revision:number;next_at:Date|null;updated_by:string;target_link?:string|null};
export type AnnouncementRun={id:string;post_id:string;revision:number;actor_id:string;channel_id:string;payload:PostPayload;kind:'send'|'edit';target_id:string|null;expected_hash:string|null;due_at:Date;status:string;message_id:string|null};
export type AnnouncementFile={id:string;filename:string;data:Buffer};
export type PostMessage={id:string;channelId:string;content:string;embeds:APIEmbed[];attachments:{id:string;filename:string}[];hash:string};
export type PostResources={channels:{id:string;name:string;usable:boolean;canMention:boolean;canUpload:boolean;canEmbed:boolean}[];roles:{id:string;name:string;mentionable:boolean}[]};
export type PostDependencies={resources:(channel?:string)=>Promise<PostResources>;readRoles:(id:string)=>Promise<string[]|null>;read:(channel:string,message:string)=>Promise<PostMessage>;send:(run:AnnouncementRun,files:AnnouncementFile[])=>Promise<string>;edit:(run:AnnouncementRun,files:AnnouncementFile[])=>Promise<string>};
export type PostStaff={guildId:string;actorId:string;token:string;readRoles:(id:string)=>Promise<string[]|null>};
export class AnnouncementError extends Error{constructor(public readonly code:string){super(code);}}
export const postId=(v:string)=>typeof v==='string'&&/^\d{17,20}$/.test(v);
export const postUuid=(v:string)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export function messageLink(link:string,guild:string){const m=/^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/.exec(link);if(!m||m[1]!==guild)throw new AnnouncementError('MESSAGE_LINK');return {channel:m[2]!,message:m[3]!};}
export function postContent(p:PostPayload){return [p.everyone?'@everyone':'',p.here?'@here':'',...p.roles.map(id=>`<@&${id}>`),p.content.replace(/@everyone/g,p.everyone?'@everyone':'@\u200beveryone').replace(/@here/g,p.here?'@here':'@\u200bhere')].filter(Boolean).join(' ');}
function webUrl(v:string){try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}
export function validatePost(p:PostPayload){
  if(!p||typeof p.content!=='string'||!Array.isArray(p.embeds)||p.embeds.length>10||!Array.isArray(p.files)||p.files.length>10||p.files.some(v=>!postUuid(v))||new Set(p.files).size!==p.files.length||!Array.isArray(p.retained)||p.retained.length+p.files.length>10||p.retained.some(v=>!postId(v.id)||typeof v.filename!=='string')||new Set(p.retained.map(v=>v.id)).size!==p.retained.length||!Array.isArray(p.roles)||p.roles.length>100||p.roles.some(v=>!postId(v))||new Set(p.roles).size!==p.roles.length||typeof p.everyone!=='boolean'||typeof p.here!=='boolean'||postContent(p).length>2000||!postContent(p).trim()&&!p.embeds.length&&!p.files.length&&!p.retained.length)throw new AnnouncementError('CONTENT');
  let total=0;for(const embed of p.embeds){
    if(!embed||typeof embed!=='object'||!embed.title&&!embed.description&&!embed.image&&!embed.thumbnail&&!embed.fields?.length&&!embed.author?.name)throw new AnnouncementError('CONTENT');
    for(const [value,max] of [[embed.title,256],[embed.description,4096],[embed.footer?.text,2048],[embed.author?.name,256]] as const){if(value!==undefined&&(typeof value!=='string'||value.length>max))throw new AnnouncementError('CONTENT');total+=(value??'').length;}
    if(embed.color!==undefined&&(!Number.isInteger(embed.color)||embed.color<0||embed.color>16777215)||embed.fields&&embed.fields.length>25)throw new AnnouncementError('CONTENT');
    for(const f of embed.fields??[]){if(typeof f.name!=='string'||!f.name||f.name.length>256||typeof f.value!=='string'||!f.value||f.value.length>1024)throw new AnnouncementError('CONTENT');total+=f.name.length+f.value.length;}
    for(const value of [embed.url,embed.image?.url,embed.thumbnail?.url,embed.author?.url,embed.author?.icon_url,embed.footer?.icon_url])if(value!==undefined&&!webUrl(value)&&!/^attachment:\/\/[^/]+$/.test(value))throw new AnnouncementError('CONTENT');
  }if(total>6000)throw new AnnouncementError('CONTENT');
}
export async function postTx<T>(pool:Pick<Pool,'connect'>,run:(db:PoolClient)=>Promise<T>){const db=await pool.connect();let discard=false;try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");const result=await run(db);await db.query('COMMIT');return result;}catch(e){try{await db.query('ROLLBACK');}catch{discard=true;}if(e&&typeof e==='object'&&'code'in e&&e.code==='55P03')throw new AnnouncementError('BUSY');throw e;}finally{db.release(discard?new Error('Announcement connection unavailable'):undefined);}}
export async function postLock(db:PoolClient,guild:string){if(!(await db.query('SELECT 1 FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[guild])).rowCount)throw new AnnouncementError('NOT_FOUND');}
export async function postAudit(db:PoolClient,guild:string,actor:string,event:string,details:object){await db.query('INSERT INTO audit_events(guild_id,actor_id,event_type,details) VALUES($1,$2,$3,$4::jsonb)',[guild,actor,event,JSON.stringify(details)]);}
async function authorize(db:PoolClient,i:PostStaff){if(!(await db.query('SELECT 1 FROM dashboard_sessions WHERE guild_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>NOW()',[i.guildId,i.actorId,digest(i.token)])).rowCount)throw new AnnouncementError('SESSION_EXPIRED');const roles=await i.readRoles(i.actorId);if(!roles||await getStaffAccess(db,i.guildId,i.actorId,roles)!=='admin')throw new AnnouncementError('STAFF_REQUIRED');}
export function checkPostChannel(resources:PostResources,channel:string,payload:PostPayload){const c=resources.channels.find(c=>c.id===channel&&c.usable);if(!c||payload.embeds.length&&!c.canEmbed||payload.files.length&&!c.canUpload||payload.roles.some(id=>!resources.roles.some(r=>r.id===id&&(r.mentionable||c.canMention)))||(payload.everyone||payload.here)&&!c.canMention)throw new AnnouncementError('CHANNEL');}
export async function saveAnnouncement(pool:Pick<Pool,'connect'>,i:PostStaff&{id:string;revision:number;requestId:string;action:'draft'|'send'|'schedule'|'edit'|'pause'|'delete';title:string;channel:string;payload:PostPayload;schedule:PostSchedule|null;files:AnnouncementFile[];target?:string;expected?:string;deps:PostDependencies}){
  if(!postUuid(i.id)||!postUuid(i.requestId)||!Number.isInteger(i.revision)||i.revision<0||i.revision>=2147483647||!['draft','send','schedule','edit','pause','delete'].includes(i.action))throw new AnnouncementError('INPUT');
  return postTx(pool,async db=>{
    await postLock(db,i.guildId);await authorize(db,i);
    const replay=(await db.query<{post_id:string}>('SELECT post_id FROM announcement_runs WHERE guild_id=$1 AND id=$2',[i.guildId,i.requestId])).rows[0];if(replay){if(replay.post_id!==i.id)throw new AnnouncementError('STALE');return;}
    const old=(await db.query<Announcement>('SELECT * FROM announcements WHERE guild_id=$1 AND id=$2',[i.guildId,i.id])).rows[0];if((old?.revision??0)!==i.revision||old?.state==='deleted')throw new AnnouncementError('STALE');
    if((await db.query("SELECT 1 FROM announcement_runs WHERE guild_id=$1 AND post_id=$2 AND status='sending'",[i.guildId,i.id])).rowCount)throw new AnnouncementError('BUSY');
    if(i.action==='pause'||i.action==='delete'){
      if(!old)throw new AnnouncementError('NOT_FOUND');await db.query('UPDATE announcements SET state=$3,next_at=NULL,revision=revision+1,updated_by=$4,updated_at=NOW() WHERE guild_id=$1 AND id=$2',[i.guildId,i.id,i.action==='delete'?'deleted':'paused',i.actorId]);
      await db.query("UPDATE announcement_runs SET status='cancelled' WHERE guild_id=$1 AND post_id=$2 AND status='pending'",[i.guildId,i.id]);
      if(i.action==='delete')await db.query('DELETE FROM announcement_files WHERE guild_id=$1 AND post_id=$2',[i.guildId,i.id]);
      await postAudit(db,i.guildId,i.actorId,'ANNOUNCEMENT_CHANGED',{post_id:i.id,action:i.action,revision:i.revision+1});return;
    }
    validatePost(i.payload);if(!i.title.trim()||i.title.length>100||!postId(i.channel)||i.files.length>10||i.files.some(f=>!postUuid(f.id)||!f.filename||f.filename.length>255||!Buffer.isBuffer(f.data)||f.data.length>10485760)||i.files.reduce((n,f)=>n+f.data.length,0)>20971520||new Set(i.files.map(f=>f.id)).size!==i.files.length||i.files.some(f=>!i.payload.files.includes(f.id)))throw new AnnouncementError('INPUT');
    checkPostChannel(await i.deps.resources(i.channel),i.channel,i.payload);
    const existing=(await db.query<{id:string;size:number}>('SELECT id,octet_length(data) AS size FROM announcement_files WHERE guild_id=$1 AND post_id=$2',[i.guildId,i.id])).rows;
    const selected=existing.filter(f=>i.payload.files.includes(f.id));if(i.payload.files.some(id=>!selected.some(f=>f.id===id)&&!i.files.some(f=>f.id===id))||selected.reduce((n,f)=>n+f.size,0)+i.files.reduce((n,f)=>n+f.data.length,0)>20971520)throw new AnnouncementError('FILES');
    let target:string|null=null;
    if(i.action==='edit'){const link=messageLink(i.target??'',i.guildId);if(link.channel!==i.channel)throw new AnnouncementError('MESSAGE_LINK');const m=await i.deps.read(link.channel,link.message);if(m.hash!==i.expected)throw new AnnouncementError('MESSAGE_CHANGED');if(i.payload.retained.some(a=>!m.attachments.some(b=>a.id===b.id)))throw new AnnouncementError('FILES');target=link.message;}
    else if(i.payload.retained.length)throw new AnnouncementError('FILES');
    const next=i.action==='schedule'&&i.schedule?nextPostTime(i.schedule,Date.now()):null;if(i.action==='schedule'&&next===null)throw new AnnouncementError('SCHEDULE');
    await db.query(`INSERT INTO announcements(guild_id,id,title,channel_id,payload,schedule,next_at,state,revision,updated_by,target_link) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11)
      ON CONFLICT(guild_id,id) DO UPDATE SET title=$3,channel_id=$4,payload=$5::jsonb,schedule=$6::jsonb,next_at=$7,state=$8,revision=$9,updated_by=$10,target_link=$11,updated_at=NOW()`,[i.guildId,i.id,i.title.trim(),i.channel,JSON.stringify(i.payload),JSON.stringify(i.schedule),next===null?null:new Date(next),i.action==='schedule'?'active':'draft',i.revision+1,i.actorId,i.target??null]);
    for(const file of i.files)await db.query('INSERT INTO announcement_files(guild_id,id,post_id,filename,data) VALUES($1,$2,$3,$4,$5)',[i.guildId,file.id,i.id,file.filename,file.data]);
    await db.query("UPDATE announcement_runs SET status='cancelled' WHERE guild_id=$1 AND post_id=$2 AND status='pending'",[i.guildId,i.id]);
    if(i.action==='send'||i.action==='edit')await db.query('INSERT INTO announcement_runs(guild_id,id,post_id,revision,actor_id,channel_id,due_at,payload,kind,target_id,expected_hash) VALUES($1,$2,$3,$4,$5,$6,NOW(),$7::jsonb,$8,$9,$10)',[i.guildId,i.requestId,i.id,i.revision+1,i.actorId,i.channel,JSON.stringify(i.payload),target?'edit':'send',target,i.expected??null]);
    await postAudit(db,i.guildId,i.actorId,'ANNOUNCEMENT_CHANGED',{post_id:i.id,action:i.action,revision:i.revision+1,channel_id:i.channel,next_at:next===null?null:new Date(next).toISOString()});
  });
}
export async function deliverAnnouncements(pool:Pick<Pool,'connect'|'query'>,guild:string,deps:PostDependencies,now=Date.now()){
  await pool.query("UPDATE announcement_runs SET status='unknown' WHERE guild_id=$1 AND status='sending' AND started_at<NOW()-INTERVAL '2 minutes'",[guild]);
  const run=await postTx(pool,async db=>{
    await postLock(db,guild);
    const post=(await db.query<Announcement>("SELECT * FROM announcements WHERE guild_id=$1 AND state='active' AND next_at<=$2 ORDER BY next_at,id LIMIT 1 FOR UPDATE",[guild,new Date(now)])).rows[0];
    if(post){const due=post.next_at!,next=post.schedule?nextPostTime(post.schedule,now):null;
      await db.query("UPDATE announcements SET next_at=$3,state=$4 WHERE guild_id=$1 AND id=$2",[guild,post.id,next===null?null:new Date(next),next===null?'completed':'active']);
      // A long outage skips missed occurrences; it never bursts an accumulated backlog.
      if(now-new Date(due).getTime()<=900000)await db.query("INSERT INTO announcement_runs(guild_id,id,post_id,revision,actor_id,channel_id,due_at,payload,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'send') ON CONFLICT DO NOTHING",[guild,randomUUID(),post.id,post.revision,post.updated_by,post.channel_id,due,JSON.stringify(post.payload)]);
      else await postAudit(db,guild,post.updated_by,'ANNOUNCEMENT_MISSED',{post_id:post.id,due_at:due});
    }
    const job=(await db.query<AnnouncementRun>(`UPDATE announcement_runs SET status='sending',started_at=NOW() WHERE guild_id=$1 AND id=(SELECT id FROM announcement_runs WHERE guild_id=$1 AND status='pending' AND due_at<=$2 ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT 1) AND status='pending' RETURNING *`,[guild,new Date(now)])).rows[0];
    if(job)await postAudit(db,guild,job.actor_id,'ANNOUNCEMENT_DISPATCH',{post_id:job.post_id,run_id:job.id,kind:job.kind});return job;
  });if(!run)return;
  let status='cancelled',message:string|null=null;
  try{const roles=await deps.readRoles(run.actor_id),post=(await pool.query<Announcement>('SELECT * FROM announcements WHERE guild_id=$1 AND id=$2',[guild,run.post_id])).rows[0];
    if(post&&post.state!=='deleted'&&post.revision===run.revision&&roles&&await getStaffAccess(pool,guild,run.actor_id,roles)==='admin'){
      checkPostChannel(await deps.resources(run.channel_id),run.channel_id,run.payload);
      if(run.kind==='edit'&&(await deps.read(run.channel_id,run.target_id!)).hash!==run.expected_hash)throw new AnnouncementError('MESSAGE_CHANGED');
      const files=(await pool.query<AnnouncementFile>('SELECT id,filename,data FROM announcement_files WHERE guild_id=$1 AND post_id=$2 AND id=ANY($3::uuid[])',[guild,run.post_id,run.payload.files])).rows;
      if(files.length!==run.payload.files.length)throw new AnnouncementError('FILES');
      status='unknown';message=await(run.kind==='edit'?deps.edit(run,files):deps.send(run,files));if(!postId(message))throw new Error('INVALID_MESSAGE');status='sent';
    }
  }catch(e){const code=e&&typeof e==='object'&&'code'in e?String(e.code):'';status=['10003','10008','50001','50013','50035','CHANNEL','MESSAGE_CHANGED','FILES','NOT_OWN_MESSAGE'].includes(code)?'failed':'unknown';}
  await postTx(pool,async db=>{const changed=await db.query("UPDATE announcement_runs SET status=$3,message_id=$4 WHERE guild_id=$1 AND id=$2 AND status='sending'",[guild,run.id,status,message]);if(changed.rowCount)await postAudit(db,guild,run.actor_id,'ANNOUNCEMENT_RESULT',{post_id:run.post_id,run_id:run.id,status,message_id:message});});
}
export function startAnnouncementWorker(pool:Pick<Pool,'connect'|'query'>,guild:string,deps:PostDependencies,ready:()=>boolean){let work:Promise<unknown>|undefined,stopping=false;const timer=setInterval(()=>{if(stopping||work||!ready())return;work=deliverAnnouncements(pool,guild,deps).catch(()=>console.error('Announcement work is waiting for Discord or the database.')).finally(()=>{work=undefined;});},5000);timer.unref();return {stop:async()=>{stopping=true;clearInterval(timer);await work;}};}
