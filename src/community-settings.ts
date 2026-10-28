import type { Pool } from 'pg';
import { digest } from './web-security.js';
import { getStaffAccess } from './staff-access.js';
export type CommunitySettings={ guild_id: string; tracking_enabled: boolean; roles_enabled: boolean; nomad_role_id: string | null; community_role_id: string | null;
 excluded_channel_ids: string[]; afk_channel_ids: string[]; message_threshold: number; voice_seconds: number; window_days: number; revision: number; updated_at: Date };
export type CommunityResources={ eventsReady: boolean; roles: { id: string; name: string; usable: boolean }[];
 channels: { id: string; name: string }[]; voiceChannels: { id: string; name: string }[] };
export class CommunityError extends Error { constructor(public readonly code: string) { super(code); } }
export async function readCommunitySettings(db: Pick<Pool,'query'>,guild: string): Promise<CommunitySettings> {
 return (await db.query<CommunitySettings>('SELECT * FROM community_settings WHERE guild_id=$1',[guild])).rows[0] ?? {
 guild_id: guild,tracking_enabled: false,roles_enabled: false,nomad_role_id: null,community_role_id: null,excluded_channel_ids: [],afk_channel_ids: [],message_threshold: 30,voice_seconds: 6000,window_days: 30,revision: 0,updated_at: new Date(0) };
}
export async function authorizeCommunity(db: Pick<Pool,'query'>,input: { guildId: string; actorId: string; token: string; readRoles: (id: string) => Promise<string[] | null> }) {
 if(!(await db.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[input.guildId])).rowCount) throw new CommunityError('NOT_CONFIGURED');
 if(!(await db.query('SELECT 1 FROM dashboard_sessions WHERE guild_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>NOW()',[input.guildId,input.actorId,digest(input.token)])).rowCount) throw new CommunityError('SESSION_EXPIRED');
 const roles=await input.readRoles(input.actorId); if(!roles || await getStaffAccess(db,input.guildId,input.actorId,roles)!=='admin') throw new CommunityError('ADMIN_REQUIRED');
}
export async function saveCommunitySettings(pool: Pick<Pool,'connect'>,input: {
 guildId: string; actorId: string; token: string; revision: number; tracking: boolean; assignRoles: boolean; nomad: string | null; community: string | null;
 excluded: string[]; afk: string[]; messages: number; voiceSeconds: number; days: number; reason: string;
 readRoles: (id: string) => Promise<string[] | null>; readResources: () => Promise<CommunityResources>;
}) {
 if(!input.reason.trim() || input.reason.trim().length>500) throw new CommunityError('INVALID_REASON');
 if(!Number.isInteger(input.revision) || input.revision<0 || input.revision>=2147483647 || typeof input.tracking!=='boolean' || typeof input.assignRoles!=='boolean' ||
 [[input.messages,1,100000],[input.voiceSeconds,1,7776000],[input.days,1,90]].some(([n,min,max]) => !Number.isInteger(n) || n!<min! || n!>max!) ||
 [input.nomad,input.community].some((id) => id!==null && !/^\d{17,20}$/.test(id)) || [input.excluded,input.afk].some((ids) => ids.length>100 || new Set(ids).size!==ids.length || ids.some((id) => !/^\d{17,20}$/.test(id)))) throw new CommunityError('INVALID_INPUT');
 if(input.nomad && input.nomad===input.community || input.assignRoles && (!input.nomad || !input.community)) throw new CommunityError('INVALID_ROLES');
 const db=await pool.connect(); let tx=false,discard=false;
 try {
 await db.query('BEGIN'); tx=true; await db.query("SET LOCAL lock_timeout='5s'"); await authorizeCommunity(db,input);
 const before=await readCommunitySettings(db,input.guildId); if(before.revision!==input.revision) throw new CommunityError('STALE_SETTINGS');
 const res=await input.readResources(); if((input.tracking || input.assignRoles) && !res.eventsReady) throw new CommunityError('EVENTS_DISABLED');
 if(input.assignRoles && (await db.query('SELECT 1 FROM staff_roles WHERE guild_id=$1 AND role_id=ANY($2::text[])',[input.guildId,[input.nomad,input.community]])).rowCount) throw new CommunityError('INVALID_ROLES');
 if(input.assignRoles && [input.nomad,input.community].some((id) => !res.roles.some((r) => r.id===id && r.usable))) throw new CommunityError('INVALID_ROLES');
 if(input.tracking && (input.excluded.some((id) => !res.channels.some((c) => c.id===id)) || input.afk.some((id) => !res.voiceChannels.some((c) => c.id===id)))) throw new CommunityError('INVALID_CHANNELS');
 const after={ tracking_enabled: input.tracking,roles_enabled: input.assignRoles,nomad_role_id: input.nomad,community_role_id: input.community,
 excluded_channel_ids: [...input.excluded].sort(),afk_channel_ids: [...input.afk].sort(),message_threshold: input.messages,voice_seconds: input.voiceSeconds,window_days: input.days };
 const keys=Object.keys(after).sort();
 if(JSON.stringify(before,keys)!==JSON.stringify(after,keys)) {
 await db.query(`INSERT INTO community_settings (guild_id,tracking_enabled,roles_enabled,nomad_role_id,community_role_id,excluded_channel_ids,afk_channel_ids,message_threshold,voice_seconds,window_days,revision,updated_by)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (guild_id) DO UPDATE SET tracking_enabled=$2,roles_enabled=$3,nomad_role_id=$4,community_role_id=$5,
 excluded_channel_ids=$6,afk_channel_ids=$7,message_threshold=$8,voice_seconds=$9,window_days=$10,revision=$11,updated_by=$12,updated_at=NOW()`,
 [input.guildId,after.tracking_enabled,after.roles_enabled,after.nomad_role_id,after.community_role_id,after.excluded_channel_ids,after.afk_channel_ids,after.message_threshold,after.voice_seconds,after.window_days,before.revision+1,input.actorId]);
 await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'COMMUNITY_SETTINGS_CHANGED',$3::jsonb)",[input.guildId,input.actorId,JSON.stringify({ before,after,reason: input.reason.trim() })]);
 // Reevaluate observed members against new thresholds and reapply pending roles when enabled.
 await db.query(`INSERT INTO community_role_jobs (guild_id,user_id) SELECT guild_id,user_id FROM community_members WHERE guild_id=$1
 ON CONFLICT (guild_id,user_id) DO UPDATE SET version=community_role_jobs.version+1,available_at=NOW()`,[input.guildId]);
 }
 await db.query('COMMIT'); tx=false;
 } catch(e) { if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } } throw e; }
 finally { db.release(discard?new Error('Community settings connection unavailable'):undefined); }
}
export async function requestCommunityCapture(pool: Pick<Pool,'connect'>,input: { guildId: string; actorId: string; token: string; revision: number; reason: string;
 readRoles: (id: string) => Promise<string[] | null>; readResources: () => Promise<CommunityResources> }) {
 if(!input.reason.trim() || input.reason.trim().length>500) throw new CommunityError('INVALID_REASON');
 const db=await pool.connect(); let tx=false,discard=false;
 try {
 await db.query('BEGIN'); tx=true; await db.query("SET LOCAL lock_timeout='5s'"); await authorizeCommunity(db,input);
 const s=await readCommunitySettings(db,input.guildId); if(s.revision!==input.revision) throw new CommunityError('STALE_SETTINGS');
 if(!s.community_role_id || !(await input.readResources()).eventsReady) throw new CommunityError('EVENTS_DISABLED');
 const old=(await db.query<{ status: string }>('SELECT status FROM community_capture WHERE guild_id=$1',[input.guildId])).rows[0];
 if(old && ['pending','running'].includes(old.status)) throw new CommunityError('CAPTURE_BUSY');
 await db.query(`INSERT INTO community_capture (guild_id,role_id,requested_by) VALUES ($1,$2,$3) ON CONFLICT (guild_id) DO UPDATE SET role_id=$2,requested_by=$3,status='pending',cursor_id='0',captured=0,updated_at=NOW()`,[input.guildId,s.community_role_id,input.actorId]);
 await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'COMMUNITY_CAPTURE_REQUESTED',$3::jsonb)",[input.guildId,input.actorId,JSON.stringify({ reason: input.reason.trim(),role_id: s.community_role_id })]);
 await db.query('COMMIT'); tx=false;
 } catch(e) { if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } } throw e; } finally { db.release(discard?new Error('Community capture request connection unavailable'):undefined); }
}
