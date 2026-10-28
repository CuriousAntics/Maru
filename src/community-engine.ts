import type { Pool } from 'pg';
import { readCommunitySettings, CommunityError } from './community-settings.js';
import type { CommunitySettings } from './community-settings.js';
export type CommunityInput={ kind: 'message'|'member'; userId: string; at: Date; revision: number; messageId?: string; channelId?: string; parentId?: string | null } |
 { kind: 'voice'; userId: string; channelId: string; start: Date; end: Date; revision: number };
export type CommunityMember={ id: string; roles: string[]; bot: boolean };
export type CommunityDependencies={ botId: () => string; readMember: (id: string) => Promise<CommunityMember | null>;
 roleUsable: (id: string) => Promise<boolean>; addRole: (user: string,role: string) => Promise<void>; removeRole: (user: string,role: string) => Promise<void>;
 listMembers: (after: string) => Promise<CommunityMember[]> };
const validId=(v: string | undefined) => /^\d{17,20}$/.test(v ?? '');
export async function communityTotals(db: Pick<Pool,'query'>,guildId: string,userId: string,s: CommunitySettings,now=new Date()) {
 const left=new Date(now.getTime()-s.window_days*86400000);
 const messages=(await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM community_messages WHERE guild_id=$1 AND user_id=$2 AND occurred_at>$3 AND occurred_at<=$4
 AND NOT(channel_id=ANY($5::text[])) AND (parent_id IS NULL OR NOT(parent_id=ANY($5::text[])))`,[guildId,userId,left,now,s.excluded_channel_ids])).rows[0]!.count;
 const voice=(await db.query<{ seconds: string }>(`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM LEAST(ended_at,$4)-GREATEST(started_at,$3))),0)::text AS seconds
 FROM community_voice WHERE guild_id=$1 AND user_id=$2 AND ended_at>$3 AND started_at<$4 AND NOT(channel_id=ANY($5::text[]))`,[guildId,userId,left,now,s.afk_channel_ids])).rows[0]!.seconds;
 return { messages: Number(messages),voiceSeconds: Number(voice) };
}
export async function rememberCommunity(db: Pick<Pool,'query'>,guildId: string,userId: string,source: string,actor: string) {
 const earned=await db.query(`INSERT INTO community_members (guild_id,user_id,earned_at,earned_source) VALUES ($1,$2,NOW(),$3)
 ON CONFLICT (guild_id,user_id) DO UPDATE SET earned_at=NOW(),earned_source=$3 WHERE community_members.earned_at IS NULL RETURNING user_id`,[guildId,userId,source]);
 if(earned.rowCount) await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'COMMUNITY_EARNED',$3::jsonb)",[guildId,actor,JSON.stringify({ target_user_id: userId,source,reason: 'Permanent Community eligibility recorded' })]);
}
export async function ingestCommunity(pool: Pick<Pool,'connect'>,guildId: string,events: CommunityInput[],botId: string) {
 if(!events.length) return;
 const db=await pool.connect(); let tx=false,discard=false;
 try {
 await db.query('BEGIN'); tx=true; await db.query("SET LOCAL lock_timeout='5s'");
 await db.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[guildId]);
 const s=await readCommunitySettings(db,guildId),touched=new Set<string>(),now=Date.now();
 for(const ev of events) {
 if(!validId(ev.userId) || ev.userId===botId || ev.revision!==s.revision || !s.tracking_enabled && !s.roles_enabled) continue;
 if(ev.kind==='member') { if(!Number.isFinite(ev.at.getTime()) || ev.at.getTime()<s.updated_at.getTime()) continue; touched.add(ev.userId); continue; }
 if(!s.tracking_enabled) continue;
 if(ev.kind==='message') {
 if(!validId(ev.messageId) || !validId(ev.channelId) || !Number.isFinite(ev.at.getTime()) || ev.at.getTime()<s.updated_at.getTime() || ev.at.getTime()<now-120000 || ev.at.getTime()>now+30000 || s.excluded_channel_ids.includes(ev.channelId!) || !!ev.parentId && s.excluded_channel_ids.includes(ev.parentId)) continue;
 const result=await db.query(`INSERT INTO community_messages (guild_id,message_id,user_id,channel_id,parent_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING message_id`,[guildId,ev.messageId,ev.userId,ev.channelId,ev.parentId ?? null,ev.at]);
 if(result.rowCount) touched.add(ev.userId);
 } else if(ev.kind==='voice') {
 if(!validId(ev.channelId) || !Number.isFinite(ev.start.getTime()) || !Number.isFinite(ev.end.getTime()) || ev.end.getTime()>now+30000 || ev.end.getTime()<=ev.start.getTime() || ev.end.getTime()-ev.start.getTime()>30000 || ev.start.getTime()<s.updated_at.getTime() || s.afk_channel_ids.includes(ev.channelId)) continue;
 await db.query('INSERT INTO community_members (guild_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[guildId,ev.userId]);
 const previous=(await db.query<{ voice_until: Date }>('SELECT voice_until FROM community_members WHERE guild_id=$1 AND user_id=$2',[guildId,ev.userId])).rows[0]!.voice_until;
 const prior=new Date(previous).getTime(); const start=new Date(Math.max(ev.start.getTime(),Number.isFinite(prior)?prior:ev.start.getTime()));
 if(start.getTime()>=ev.end.getTime()) continue;
 await db.query('INSERT INTO community_voice (guild_id,user_id,channel_id,started_at,ended_at) VALUES ($1,$2,$3,$4,$5)',[guildId,ev.userId,ev.channelId,start,ev.end]);
 await db.query('UPDATE community_members SET voice_until=$3 WHERE guild_id=$1 AND user_id=$2',[guildId,ev.userId,ev.end]); touched.add(ev.userId);
 }
 }
 for(const user of touched) {
 await db.query('INSERT INTO community_members (guild_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[guildId,user]);
 if(s.tracking_enabled) {
 const totals=await communityTotals(db,guildId,user,s);
 if(totals.messages>=s.message_threshold) await rememberCommunity(db,guildId,user,'messages',botId);
 else if(totals.voiceSeconds>=s.voice_seconds) await rememberCommunity(db,guildId,user,'voice',botId);
 }
 await db.query(`INSERT INTO community_role_jobs (guild_id,user_id) VALUES ($1,$2) ON CONFLICT (guild_id,user_id) DO UPDATE SET version=community_role_jobs.version+1,available_at=NOW(),updated_at=NOW()`,[guildId,user]);
 }
 await db.query("DELETE FROM community_messages WHERE guild_id=$1 AND occurred_at<NOW()-INTERVAL '90 days'",[guildId]);
 await db.query("DELETE FROM community_voice WHERE guild_id=$1 AND ended_at<NOW()-INTERVAL '90 days'",[guildId]);
 await db.query('COMMIT'); tx=false;
 } catch(e) { if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } } throw e; }
 finally { db.release(discard?new Error('Community activity connection unavailable'):undefined); }
}
export async function processCommunityRole(pool: Pick<Pool,'connect'>,guildId: string,deps: CommunityDependencies) {
 const db=await pool.connect(); let tx=false,locked=false,discard=false;
 let job: { user_id: string; version: string } | undefined;
 try {
 job=(await db.query<{ user_id: string; version: string }>(`SELECT j.user_id,j.version FROM community_role_jobs j JOIN community_settings s USING(guild_id)
 WHERE j.guild_id=$1 AND j.version>j.processed_version AND j.available_at<=NOW() AND (s.roles_enabled OR s.tracking_enabled) ORDER BY j.available_at,j.user_id LIMIT 1`,[guildId])).rows[0];
 if(!job) return false;
 locked=(await db.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',[guildId,job.user_id])).rows[0]?.locked===true;
 if(!locked) return false;
 async function step() {
 await db.query('BEGIN'); tx=true; await db.query("SET LOCAL lock_timeout='5s'");
 await db.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[guildId]);
 const s=await readCommunitySettings(db,guildId);
 const member=await deps.readMember(job!.user_id);
 if(!member || member.bot || member.id!==job!.user_id) { await db.query('COMMIT'); tx=false; return { note: 'Member absent or bot; no role changes' }; }
 if(s.community_role_id && member.roles.includes(s.community_role_id) && (s.tracking_enabled || s.roles_enabled)) await rememberCommunity(db,guildId,member.id,'existing_role',deps.botId());
 if(s.tracking_enabled) {
 const total=await communityTotals(db,guildId,member.id,s);
 if(total.messages>=s.message_threshold || total.voiceSeconds>=s.voice_seconds) await rememberCommunity(db,guildId,member.id,total.messages>=s.message_threshold?'messages':'voice',deps.botId());
 }
 const earned=!!(await db.query('SELECT 1 FROM community_members WHERE guild_id=$1 AND user_id=$2 AND earned_at IS NOT NULL',[guildId,member.id])).rowCount;
 let action: 'add'|'remove' | undefined,role: string | undefined;
 if(s.roles_enabled && s.nomad_role_id && s.community_role_id) {
 if(earned && !member.roles.includes(s.community_role_id)) { action='add'; role=s.community_role_id; }
 else if(earned && member.roles.includes(s.community_role_id) && member.roles.includes(s.nomad_role_id)) { action='remove'; role=s.nomad_role_id; }
 else if(!earned && !member.roles.includes(s.nomad_role_id)) { action='add'; role=s.nomad_role_id; }
 }
 if(role && action) {
 if((await db.query('SELECT 1 FROM staff_roles WHERE guild_id=$1 AND role_id=ANY($2::text[])',[guildId,[s.nomad_role_id,s.community_role_id]])).rowCount) throw new CommunityError('ROLE_UNAVAILABLE');
 if(!await deps.roleUsable(role) || !await deps.roleUsable(s.nomad_role_id!) || !await deps.roleUsable(s.community_role_id!)) throw new CommunityError('ROLE_UNAVAILABLE');
 await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'COMMUNITY_ROLE_REQUESTED',$3::jsonb)",[guildId,deps.botId(),JSON.stringify({ target_user_id: member.id,role_id: role,action,settings_revision: s.revision,reason: 'Apply current permanent Community or Nomad assignment' })]);
 }
 await db.query('COMMIT'); tx=false;
 return { action,role,note: s.roles_enabled?'Current roles are synchronized':'Role changes are Off; eligibility retained' };
 }
 // Add Community first; fetch again and confirm it before removing Nomad. Never replace the member's whole role array.
 for(let i=0;i<3;i++) {
 const task=await step(); if(!task.action || !task.role) {
 await db.query('UPDATE community_role_jobs SET processed_version=$3,note=$4,updated_at=NOW() WHERE guild_id=$1 AND user_id=$2',[guildId,job.user_id,job.version,task.note]); return true;
 }
 try { if(task.action==='add') await deps.addRole(job.user_id,task.role); else await deps.removeRole(job.user_id,task.role); }
 catch { /* A lost response is reconciled by fresh role state, never treated as proof of failure or success. */ }
 const after=await deps.readMember(job.user_id);
 const confirmed=!!after && (task.action==='add'?after.roles.includes(task.role):!after.roles.includes(task.role));
 await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'COMMUNITY_ROLE_RESULT',$3::jsonb)",[guildId,deps.botId(),JSON.stringify({ target_user_id: job.user_id,role_id: task.role,action: task.action,confirmed,reason: confirmed?'Role state confirmed after request':'Role state unconfirmed; saved work will recheck current settings before retry' })]);
 if(!confirmed) throw new CommunityError('ROLE_UNCONFIRMED');
 }
 throw new CommunityError('ROLE_CHANGED_DURING_SYNC');
 } catch(e) {
 if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } }
 if(job && !discard) await db.query("UPDATE community_role_jobs SET available_at=NOW()+INTERVAL '30 seconds',note=$3 WHERE guild_id=$1 AND user_id=$2",[guildId,job.user_id,e instanceof CommunityError?e.code:'Discord or database unavailable; saved work will retry']);
 return false;
 } finally {
 if(locked && job) { try { await db.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',[guildId,job.user_id]); } catch { discard=true; } }
 db.release(discard?new Error('Community role lock could not be released safely'):undefined);
 }
}
export async function processCommunityCapture(pool: Pick<Pool,'connect'>,guildId: string,deps: CommunityDependencies) {
 const db=await pool.connect(); let tx=false,locked=false,discard=false;
 try {
 locked=(await db.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),731213) AS locked',[guildId])).rows[0]?.locked===true; if(!locked) return;
 const job=(await db.query<{ role_id: string; cursor_id: string; requested_by: string }>("SELECT * FROM community_capture WHERE guild_id=$1 AND status IN ('pending','running')",[guildId])).rows[0]; if(!job) return;
 const page=await deps.listMembers(job.cursor_id);
 if(page.length>1000 || page.some((m) => !validId(m.id) || BigInt(m.id)<=BigInt(job.cursor_id)) || new Set(page.map((m) => m.id)).size!==page.length) throw new CommunityError('INVALID_MEMBER_PAGE');
 await db.query('BEGIN'); tx=true; await db.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[guildId]);
 if((await readCommunitySettings(db,guildId)).community_role_id!==job.role_id) {
 await db.query("UPDATE community_capture SET status='cancelled',updated_at=NOW() WHERE guild_id=$1",[guildId]);
 } else {
 let captured=0;
 for(const member of page) if(!member.bot && member.roles.includes(job.role_id)) { await rememberCommunity(db,guildId,member.id,'existing_role',deps.botId()); await db.query(`INSERT INTO community_role_jobs (guild_id,user_id) VALUES ($1,$2) ON CONFLICT (guild_id,user_id) DO UPDATE SET version=community_role_jobs.version+1,available_at=NOW()`,[guildId,member.id]); captured++; }
 const cursor=page.reduce((best,m) => BigInt(m.id)>BigInt(best)?m.id:best,job.cursor_id);
 const status=page.length<1000?'complete':'running';
 await db.query('UPDATE community_capture SET status=$2,cursor_id=$3,captured=captured+$4,updated_at=NOW() WHERE guild_id=$1',[guildId,status,cursor,captured]);
 if(status==='complete') await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'COMMUNITY_CAPTURE_COMPLETE',$3::jsonb)",[guildId,job.requested_by,JSON.stringify({ role_id: job.role_id,reason: 'Current Community role holders captured; unearned StatBot activity is not imported' })]);
 }
 await db.query('COMMIT'); tx=false;
 } catch { if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } } console.error('Community role capture is pending after a Discord or database failure.'); }
 finally { if(locked) { try { await db.query('SELECT pg_advisory_unlock(hashtext($1),731213)',[guildId]); } catch { discard=true; } } db.release(discard?new Error('Community capture lock unavailable'):undefined); }
}
