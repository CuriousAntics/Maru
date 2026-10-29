import type { Pool } from 'pg';
import { digest } from './web-security.js';
import { getStaffAccess } from './staff-access.js';
import { readCommunitySettings } from './community-settings.js';
import { logChannelId } from './server-settings.js';
import { RaidError, readRaidSettings, raidAuthorize, raidIdValid, raidWindow } from './raid-settings.js';
import type { RaidDependencies, RaidMember } from './raid-settings.js';
export type RaidRun={ guild_id: string; run_id: string; actor_id: string; session_hash: string; settings_revision: number; starts_at: Date; ends_at: Date; exclude_community: boolean;
 delete_seconds: number; reason: string; status: string; cursor_id: string; scanned: number; note: string; expires_at: Date; confirmed_at: Date | null; execution_until: Date | null };
export type RaidTarget={ user_id: string; display_name: string; joined_at: Date; eligible: boolean; exclusion: string; selected: boolean; status: string; note: string; case_number: number | null };
export type RaidInviteRow={ code: string; channel_id: string | null; selected: boolean; status: string; note: string };
export async function raidExclusion(db: Pick<Pool,'query'>,run: RaidRun,member: RaidMember,botId: string) {
 if(member.id===run.actor_id || member.id===botId || member.owner || member.administrator) return 'Protected: actor, bot, owner or Administrator';
 if(member.bot) return 'Bot account';
 const globalRoles=(await db.query<{ exempt_role_ids: string[] }>('SELECT exempt_role_ids FROM automod_settings WHERE guild_id=$1',[run.guild_id])).rows[0]?.exempt_role_ids ?? [];
 if(member.staffPermissions || member.roles.some((id) => globalRoles.includes(id)) || await getStaffAccess(db,run.guild_id,member.id,member.roles)!=='none') return 'Staff permissions, configured staff role, or globally protected role';
 if(!member.actorAbove || !member.botAbove) return 'Staff or Maru role hierarchy';
 if(run.exclude_community) {
 const community=(await readCommunitySettings(db,run.guild_id)).community_role_id;
 if(community && member.roles.includes(community) || (await db.query('SELECT 1 FROM community_members WHERE guild_id=$1 AND user_id=$2 AND earned_at IS NOT NULL',[run.guild_id,member.id])).rowCount) return 'Community role or permanently earned Community (including returning members)';
 }
 return '';
}
export async function createRaidPreview(pool: Pick<Pool,'connect'>,input: { guildId: string; actorId: string; token: string; runId: string; revision: number;
 mode: string; minutes?: string; start?: string; end?: string; excludeCommunity: boolean; deleteSeconds: number; reason: string },deps: RaidDependencies) {
 if(!raidIdValid(input.runId) || !input.reason.trim() || input.reason.trim().length>500 || typeof input.excludeCommunity!=='boolean' || !Number.isInteger(input.deleteSeconds) || input.deleteSeconds<0 || input.deleteSeconds>604800) throw new RaidError('INVALID_INPUT');
 const window=raidWindow(input),db=await pool.connect(); let tx=false,discard=false;
 try {
 await db.query('BEGIN'); tx=true; await db.query("SET LOCAL lock_timeout='5s'"); await raidAuthorize(db,input.guildId,input.actorId,digest(input.token),deps);
 const s=await readRaidSettings(db,input.guildId); if(!s.enabled || !deps.membersReady) throw new RaidError('DISABLED'); if(s.revision!==input.revision) throw new RaidError('STALE_SETTINGS');
 const prior=(await db.query<RaidRun>('SELECT * FROM raid_runs WHERE guild_id=$1 AND run_id=$2',[input.guildId,input.runId])).rows[0];
 if(prior) { if(prior.actor_id!==input.actorId) throw new RaidError('ACCESS_DENIED'); await db.query('COMMIT'); tx=false; return; }
 const active=(await db.query("SELECT 1 FROM raid_runs WHERE guild_id=$1 AND status IN ('building','executing')",[input.guildId])).rowCount; if(active) throw new RaidError('BUSY');
 const guild=(await db.query<{ settings: Record<string,unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1',[input.guildId])).rows[0]!;
 if(!logChannelId(guild.settings)) throw new RaidError('LOG_REQUIRED');
 await db.query(`INSERT INTO raid_runs (guild_id,run_id,actor_id,session_hash,settings_revision,starts_at,ends_at,exclude_community,delete_seconds,reason)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[input.guildId,input.runId,input.actorId,digest(input.token),s.revision,window.start,window.end,input.excludeCommunity,input.deleteSeconds,input.reason.trim()]);
 for(const code of s.invite_codes) await db.query('INSERT INTO raid_invites (guild_id,run_id,code) VALUES ($1,$2,$3)',[input.guildId,input.runId,code]);
 await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'RAID_PREVIEW_REQUESTED',$3::jsonb)",[input.guildId,input.actorId,JSON.stringify({ run_id: input.runId,starts_at: window.start,ends_at: window.end,exclude_community: input.excludeCommunity,delete_seconds: input.deleteSeconds,reason: input.reason.trim() })]);
 await db.query('COMMIT'); tx=false;
 } catch(e) { if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } } throw e; }
 finally { db.release(discard?new Error('Raid preview connection unavailable'):undefined); }
}
export async function confirmRaid(pool: Pick<Pool,'connect'>,input: { guildId: string; actorId: string; token: string; runId: string; targets: string[]; invites: string[]; confirmation: string },deps: RaidDependencies) {
 if(!raidIdValid(input.runId) || input.targets.length>500 || input.invites.length>20 || new Set(input.targets).size!==input.targets.length || new Set(input.invites).size!==input.invites.length || input.targets.some((id) => !/^\d{17,20}$/.test(id)) || input.invites.some((c) => !/^[A-Za-z0-9_-]{1,100}$/.test(c))) throw new RaidError('INVALID_INPUT');
 const db=await pool.connect(); let tx=false,discard=false;
 try {
 await db.query('BEGIN'); tx=true; await db.query("SET LOCAL lock_timeout='5s'"); await raidAuthorize(db,input.guildId,input.actorId,digest(input.token),deps);
 const run=(await db.query<RaidRun>('SELECT * FROM raid_runs WHERE guild_id=$1 AND run_id=$2 FOR UPDATE',[input.guildId,input.runId])).rows[0];
 if(!run || run.actor_id!==input.actorId) throw new RaidError('ACCESS_DENIED');
 if(run.confirmed_at) { await db.query('COMMIT'); tx=false; return; }
 if(run.status!=='ready' || new Date(run.expires_at).getTime()<=Date.now()) throw new RaidError('PREVIEW_EXPIRED');
 if((await db.query("SELECT 1 FROM raid_runs WHERE guild_id=$1 AND run_id<>$2 AND status IN ('building','executing')",[input.guildId,input.runId])).rowCount) throw new RaidError('BUSY');
 const s=await readRaidSettings(db,input.guildId); if(!s.enabled || s.revision!==run.settings_revision || !deps.membersReady) throw new RaidError('STALE_SETTINGS');
 const targets=(await db.query<RaidTarget>('SELECT * FROM raid_targets WHERE guild_id=$1 AND run_id=$2',[input.guildId,input.runId])).rows;
 const invites=(await db.query<RaidInviteRow>('SELECT * FROM raid_invites WHERE guild_id=$1 AND run_id=$2',[input.guildId,input.runId])).rows;
 if(!input.targets.length && !input.invites.length || input.targets.some((id) => !targets.some((t) => t.user_id===id && t.eligible)) || input.invites.some((c) => !invites.some((i) => i.code===c && i.status==='pending'))) throw new RaidError('INVALID_SELECTION');
 if(input.confirmation!==`BAN ${input.targets.length} REVOKE ${input.invites.length}`) throw new RaidError('CONFIRM_REQUIRED');
 // Only frozen preview rows can be selected. Future joins and newly configured invites cannot enter this run.
 await db.query('UPDATE raid_targets SET selected=(user_id=ANY($3::text[])),note=CASE WHEN user_id=ANY($3::text[]) THEN \'Awaiting execution\' ELSE \'Not selected\' END WHERE guild_id=$1 AND run_id=$2',[input.guildId,input.runId,input.targets]);
 await db.query('UPDATE raid_invites SET selected=(code=ANY($3::text[])) WHERE guild_id=$1 AND run_id=$2',[input.guildId,input.runId,input.invites]);
 await db.query("UPDATE raid_runs SET status='executing',confirmed_at=NOW(),execution_until=NOW()+INTERVAL '30 minutes',session_hash=$3,note='Confirmed; selected invites run before bans' WHERE guild_id=$1 AND run_id=$2",[input.guildId,input.runId,digest(input.token)]);
 await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'RAID_CONFIRMED',$3::jsonb)",[input.guildId,input.actorId,JSON.stringify({ run_id: input.runId,target_ids: input.targets,invite_codes: input.invites,delete_seconds: run.delete_seconds,reason: run.reason })]);
 await db.query('COMMIT'); tx=false;
 } catch(e) { if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } } throw e; }
 finally { db.release(discard?new Error('Raid confirmation connection unavailable'):undefined); }
}
export async function stopRaid(pool: Pick<Pool,'connect'>,input: { guildId: string; actorId: string; token: string; runId: string },deps: RaidDependencies) {
 if(!raidIdValid(input.runId)) throw new RaidError('INVALID_INPUT');
 const db=await pool.connect(); let tx=false,discard=false;
 try {
 await db.query('BEGIN'); tx=true; await db.query("SET LOCAL lock_timeout='5s'"); const actor=await raidAuthorize(db,input.guildId,input.actorId,digest(input.token),deps,false,false);
 const run=(await db.query<RaidRun>('SELECT * FROM raid_runs WHERE guild_id=$1 AND run_id=$2',[input.guildId,input.runId])).rows[0];
 if(!run || run.actor_id!==input.actorId && await getStaffAccess(db,input.guildId,input.actorId,actor.roles)!=='admin') throw new RaidError('ACCESS_DENIED');
 const changed=await db.query("UPDATE raid_runs SET status='stopped',note='Stopped by staff; already dispatched actions cannot be undone' WHERE guild_id=$1 AND run_id=$2 AND status IN ('building','ready','executing') RETURNING run_id",[input.guildId,input.runId]);
 if(changed.rowCount) await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'RAID_STOPPED',$3::jsonb)",[input.guildId,input.actorId,JSON.stringify({ run_id: input.runId,reason: 'Staff stopped remaining raid response actions' })]);
 await db.query('COMMIT'); tx=false;
 } catch(e) { if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } } throw e; } finally { db.release(discard?new Error('Raid stop connection unavailable'):undefined); }
}
