import type { Pool } from 'pg';
import { getStaffAccess } from './staff-access.js';
import { digest } from './web-security.js';
export class RaidError extends Error { constructor(public readonly code: string) { super(code); } }
export type RaidSettings={ guild_id: string; enabled: boolean; invite_codes: string[]; revision: number };
export type RaidActor={ roles: string[]; canBan: boolean; botCanBan: boolean; guildName: string };
export type RaidMember={ id: string; name: string; joinedAt: string; roles: string[]; bot: boolean; owner: boolean; administrator: boolean; staffPermissions?: boolean; actorAbove: boolean; botAbove: boolean };
export type RaidInvite={ code: string; guildId: string; channelId: string };
export type RaidDependencies={ membersReady: boolean; botId: () => string; readActor: (id: string) => Promise<RaidActor>;
 listMembers: (after: string,actor: string) => Promise<RaidMember[]>; readMember: (id: string,actor: string) => Promise<RaidMember | null>;
 readInvite: (code: string) => Promise<RaidInvite | null>; canRevoke: (actor: string,channel: string) => Promise<boolean>;
 revokeInvite: (code: string,run: string,channel: string) => Promise<void>; readBan: (id: string) => Promise<{ reason: string | null } | null>;
 ban: (id: string,seconds: number,marker: string) => Promise<void> };
export const raidIdValid=(id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export function parseRaidInvites(text: string): string[] {
 const values=text.split(/[,\s]+/).filter(Boolean).map((v) => v.replace(/^https:\/\/(?:www\.)?discord\.gg\//i,'').replace(/^https:\/\/(?:www\.)?discord\.com\/invite\//i,'').replace(/\/$/,''));
 if(values.length>20 || values.some((v) => !/^[A-Za-z0-9_-]{1,100}$/.test(v))) throw new RaidError('INVALID_INVITES');
 return [...new Set(values)].sort();
}
export async function readRaidSettings(db: Pick<Pool,'query'>,guild: string): Promise<RaidSettings> {
 return (await db.query<RaidSettings>('SELECT * FROM raid_settings WHERE guild_id=$1',[guild])).rows[0] ?? { guild_id: guild,enabled: false,invite_codes: [],revision: 0 };
}
export async function raidAuthorize(db: Pick<Pool,'query'>,guildId: string,actorId: string,hash: string,deps: RaidDependencies,adminOnly=false,native=true) {
 if(!(await db.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[guildId])).rowCount) throw new RaidError('NOT_CONFIGURED');
 if(!(await db.query('SELECT 1 FROM dashboard_sessions WHERE guild_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>NOW()',[guildId,actorId,hash])).rowCount) throw new RaidError('SESSION_EXPIRED');
 const actor=await deps.readActor(actorId),access=await getStaffAccess(db,guildId,actorId,actor.roles);
 if(access==='none' || adminOnly && access!=='admin') throw new RaidError('ACCESS_DENIED');
 if(native && (!actor.canBan || !actor.botCanBan)) throw new RaidError('BAN_PERMISSION');
 return actor;
}
export async function saveRaidSettings(pool: Pick<Pool,'connect'>,input: { guildId: string; actorId: string; token: string; revision: number; enabled: boolean; codes: string; reason: string },deps: RaidDependencies) {
 const codes=parseRaidInvites(input.codes),reason=input.reason.trim();
 if(!reason || reason.length>500 || !Number.isInteger(input.revision) || input.revision<0 || input.revision>=2147483647 || typeof input.enabled!=='boolean') throw new RaidError('INVALID_INPUT');
 const db=await pool.connect(); let tx=false,discard=false;
 try {
 await db.query('BEGIN'); tx=true; await db.query("SET LOCAL lock_timeout='5s'"); await raidAuthorize(db,input.guildId,input.actorId,digest(input.token),deps,true,false);
 const before=await readRaidSettings(db,input.guildId); if(before.revision!==input.revision) throw new RaidError('STALE_SETTINGS');
 if(input.enabled && !deps.membersReady) throw new RaidError('MEMBERS_DISABLED');
 if(before.enabled!==input.enabled || JSON.stringify(before.invite_codes)!==JSON.stringify(codes)) {
 await db.query(`INSERT INTO raid_settings (guild_id,enabled,invite_codes,revision,updated_by) VALUES ($1,$2,$3,$4,$5)
 ON CONFLICT (guild_id) DO UPDATE SET enabled=$2,invite_codes=$3,revision=$4,updated_by=$5,updated_at=NOW()`,[input.guildId,input.enabled,codes,before.revision+1,input.actorId]);
 await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'RAID_SETTINGS_CHANGED',$3::jsonb)",[input.guildId,input.actorId,JSON.stringify({ before,enabled: input.enabled,invite_codes: codes,reason })]);
 }
 await db.query('COMMIT'); tx=false;
 } catch(e) { if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } } throw e; }
 finally { db.release(discard?new Error('Raid settings connection unavailable'):undefined); }
}
export function raidWindow(input: { mode: string; minutes?: string; start?: string; end?: string },now=new Date()) {
 let start: Date,end: Date;
 if(input.mode==='recent') {
 if(!/^[1-9]\d{0,4}$/.test(input.minutes ?? '') || Number(input.minutes)>10080) throw new RaidError('INVALID_WINDOW');
 end=now; start=new Date(now.getTime()-Number(input.minutes)*60000);
 } else if(input.mode==='exact') {
 // Explicit offset required; the interface labels its examples in UTC.
 if(![input.start,input.end].every((v) => {
 const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?(?:Z|[+-](\d\d):(\d\d))$/.exec(v ?? '');
 if(!m) return false;
 const [year,month,day,hour,minute,second,zoneHour,zoneMinute]=m.slice(1).map((n) => Number(n ?? 0));
 return year!>=1000 && month!>=1 && month!<=12 && day!>=1 && day!<=new Date(Date.UTC(year!,month!,0)).getUTCDate() && hour!<=23 && minute!<=59 && second!<=59 && zoneHour!<=14 && zoneMinute!<=59 && (zoneHour!==14 || zoneMinute===0);
 })) throw new RaidError('INVALID_WINDOW');
 start=new Date(input.start!); end=new Date(input.end!);
 } else throw new RaidError('INVALID_WINDOW');
 if(!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start>end || end.getTime()>now.getTime() || end.getTime()-start.getTime()>604800000) throw new RaidError('INVALID_WINDOW');
 return { start,end };
}
