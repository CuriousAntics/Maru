import type { Pool } from 'pg';
import { digest } from './web-security.js';
import { getStaffAccess } from './staff-access.js';
import { logChannelId } from './server-settings.js';
import { parseDomainList } from './message-links.js';
import type { AutoModResources } from './automod-settings.js';
export type LinkSettings={ link_updated_at?: Date; link_enabled: boolean; link_limit: number; link_window_seconds: number; link_timeout_seconds: number;
 link_enforced_role_ids: string[]; link_enforced_channel_ids: string[]; scam_enabled: boolean; scam_timeout_seconds: number;
 scam_enforced_role_ids: string[]; scam_enforced_channel_ids: string[]; scam_blocked_domains: string[]; scam_allowed_domains: string[]; link_revision: number };
export const defaultLinkSettings: LinkSettings={ link_enabled: false,link_limit: 3,link_window_seconds: 30,link_timeout_seconds: 43200,link_enforced_role_ids: [],link_enforced_channel_ids: [],
 scam_enabled: false,scam_timeout_seconds: 600,scam_enforced_role_ids: [],scam_enforced_channel_ids: [],scam_blocked_domains: [],scam_allowed_domains: [],link_revision: 0 };
export class LinkSettingsError extends Error { constructor(public readonly code: string) { super(code); } }
export async function readLinkSettings(db: Pick<Pool,'query'>,guildId: string): Promise<LinkSettings> {
 return { ...defaultLinkSettings,...(await db.query<Partial<LinkSettings>>('SELECT *,updated_at AS link_updated_at FROM automod_link_settings WHERE guild_id=$1',[guildId])).rows[0] };
}
export async function saveLinkSection(pool: Pick<Pool,'connect'>,input: { guildId: string; actorId: string; token: string; section: 'cooldown'|'scam'; revision: number; sharedRevision: number;
 enabled: boolean; limit?: number; window?: number; timeout: number; enforcedRoles: string[]; enforcedChannels: string[]; blocked?: string; allowed?: string; reason: string;
 readRoles: (id: string) => Promise<string[] | null>; readResources: () => Promise<AutoModResources> }) {
 if(!['cooldown','scam'].includes(input.section) || typeof input.enabled!=='boolean' || !input.reason.trim() || input.reason.trim().length>500 || !Number.isInteger(input.revision) || input.revision<0 || input.revision>=2147483647 || !Number.isInteger(input.sharedRevision) || input.sharedRevision<0 || !Number.isInteger(input.timeout) || input.timeout<1 || input.timeout>2419200 ||
 input.section==='cooldown' && (!Number.isInteger(input.limit) || input.limit!<2 || input.limit!>50 || !Number.isInteger(input.window) || input.window!<1 || input.window!>300) ||
 [input.enforcedRoles,input.enforcedChannels].some((ids) => ids.length>100 || new Set(ids).size!==ids.length || ids.some((id) => !/^\d{17,20}$/.test(id)))) throw new LinkSettingsError('INVALID_INPUT');
 let blocked: string[]=[],allowed: string[]=[];
 try { if(input.section==='scam') { blocked=parseDomainList(input.blocked ?? ''); allowed=parseDomainList(input.allowed ?? ''); if(blocked.some((d) => allowed.includes(d))) throw new Error('conflict'); } } catch { throw new LinkSettingsError('INVALID_DOMAINS'); }
 const db=await pool.connect(); let tx=false,locked=false,discard=false;
 try {
 locked=(await db.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),731209) AS locked',[input.guildId])).rows[0]?.locked===true; if(!locked) throw new LinkSettingsError('BUSY');
 await db.query('BEGIN'); tx=true; await db.query("SET LOCAL lock_timeout='5s'");
 const guild=(await db.query<{ settings: Record<string,unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[input.guildId])).rows[0]; if(!guild) throw new LinkSettingsError('NOT_CONFIGURED');
 if(!(await db.query('SELECT 1 FROM dashboard_sessions WHERE guild_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>NOW()',[input.guildId,input.actorId,digest(input.token)])).rowCount) throw new LinkSettingsError('SESSION_EXPIRED');
 const roles=await input.readRoles(input.actorId); if(!roles || await getStaffAccess(db,input.guildId,input.actorId,roles)!=='admin') throw new LinkSettingsError('ADMIN_REQUIRED');
 const shared=(await db.query<{ revision: number; exempt_role_ids: string[]; ignored_channel_ids: string[] }>('SELECT revision,exempt_role_ids,ignored_channel_ids FROM automod_settings WHERE guild_id=$1',[input.guildId])).rows[0] ?? { revision: 0,exempt_role_ids: [],ignored_channel_ids: [] };
 const before=await readLinkSettings(db,input.guildId); if(before.link_revision!==input.revision || shared.revision!==input.sharedRevision) throw new LinkSettingsError('STALE_SETTINGS');
 const res=await input.readResources();
 if(input.enabled && (!res.canDelete || !res.canTimeout || !logChannelId(guild.settings))) throw new LinkSettingsError('PERMISSIONS_OR_LOG');
 if(input.enforcedRoles.some((id) => !shared.exempt_role_ids.includes(id)) || input.enforcedChannels.some((id) => !shared.ignored_channel_ids.includes(id)) || input.enabled && (input.enforcedRoles.some((id) => !res.roles.some((r) => r.id===id)) || input.enforcedChannels.some((id) => !res.channels.some((c) => c.id===id)))) throw new LinkSettingsError('INVALID_SELECTION');
 const after: LinkSettings={ ...before };
 if(input.section==='cooldown') Object.assign(after,{ link_enabled: input.enabled,link_limit: input.limit!,link_window_seconds: input.window!,link_timeout_seconds: input.timeout,link_enforced_role_ids: [...input.enforcedRoles].sort(),link_enforced_channel_ids: [...input.enforcedChannels].sort() });
 else Object.assign(after,{ scam_enabled: input.enabled,scam_timeout_seconds: input.timeout,scam_blocked_domains: blocked,scam_allowed_domains: allowed,scam_enforced_role_ids: [...input.enforcedRoles].sort(),scam_enforced_channel_ids: [...input.enforcedChannels].sort() });
 const keys=Object.keys(defaultLinkSettings).sort();
 if(JSON.stringify(before,keys)!==JSON.stringify(after,keys)) {
 after.link_revision++;
 await db.query(`INSERT INTO automod_link_settings (guild_id,link_enabled,link_limit,link_window_seconds,link_timeout_seconds,link_enforced_role_ids,link_enforced_channel_ids,scam_enabled,scam_timeout_seconds,scam_enforced_role_ids,scam_enforced_channel_ids,scam_blocked_domains,scam_allowed_domains,link_revision,updated_by)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(guild_id) DO UPDATE SET link_enabled=$2,link_limit=$3,link_window_seconds=$4,link_timeout_seconds=$5,link_enforced_role_ids=$6,link_enforced_channel_ids=$7,scam_enabled=$8,scam_timeout_seconds=$9,scam_enforced_role_ids=$10,scam_enforced_channel_ids=$11,scam_blocked_domains=$12,scam_allowed_domains=$13,link_revision=$14,updated_by=$15,updated_at=NOW()`,
 [input.guildId,after.link_enabled,after.link_limit,after.link_window_seconds,after.link_timeout_seconds,after.link_enforced_role_ids,after.link_enforced_channel_ids,after.scam_enabled,after.scam_timeout_seconds,after.scam_enforced_role_ids,after.scam_enforced_channel_ids,after.scam_blocked_domains,after.scam_allowed_domains,after.link_revision,input.actorId]);
 await db.query("INSERT INTO audit_events(guild_id,actor_id,event_type,details) VALUES ($1,$2,'LINK_SETTINGS_CHANGED',$3::jsonb)",[input.guildId,input.actorId,JSON.stringify({ section: input.section,before,after,reason: input.reason.trim() })]);
 }
 await db.query('COMMIT'); tx=false;
 } catch(e) { if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } } throw e; }
 finally { if(locked) { try { await db.query('SELECT pg_advisory_unlock(hashtext($1),731209)',[input.guildId]); } catch { discard=true; } } db.release(discard?new Error('Link settings connection unavailable'):undefined); }
}
