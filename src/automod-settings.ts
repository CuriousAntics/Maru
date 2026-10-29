import { readLinkSettings } from './link-settings.js';
import type { LinkSettings } from './link-settings.js';
import type { Pool } from 'pg';
import { logChannelId } from './server-settings.js';
import { digest } from './web-security.js';
import { getStaffAccess } from './staff-access.js';
import { parseBlockedWords } from './blocked-words.js';
export type AutoModResources = {
  roles: { id: string; name: string }[]; channels: { id: string; name: string }[];
  canDelete: boolean; canTimeout: boolean;
};
export type AutoModSettings = Partial<LinkSettings> & {
  invite_enabled?: boolean; invite_timeout_seconds?: number; invite_allowed_guild_ids?: string[]; invite_enforced_role_ids?: string[]; invite_enforced_channel_ids?: string[];
  repeat_enabled?: boolean; repeat_text?: boolean; repeat_images?: boolean; repeat_limit?: number; repeat_window_seconds?: number; repeat_timeout_seconds?: number; repeat_enforced_role_ids?: string[]; repeat_enforced_channel_ids?: string[];
  spam_enabled?: boolean; spam_limit?: number; spam_window_seconds?: number; spam_timeout_seconds?: number; spam_enforced_role_ids?: string[]; spam_enforced_channel_ids?: string[];
  guild_id: string; blocked_enabled: boolean; blocked_words: string[]; timeout_seconds: number;
  exempt_role_ids: string[]; ignored_channel_ids: string[]; enforced_role_ids: string[]; enforced_channel_ids: string[]; revision: number;
};
export class AutoModError extends Error { constructor(public readonly code: string) { super(code); } }
export const autoModLock = 731209;
export async function readAutoModSettings(pool: Pick<Pool,'query'>,guildId: string,resources?: AutoModResources): Promise<AutoModSettings> {
  const links=await readLinkSettings(pool,guildId);
  const row = (await pool.query<AutoModSettings>('SELECT * FROM automod_settings WHERE guild_id=$1',[guildId])).rows[0];
  if (row) return { ...links,invite_enabled: false,invite_timeout_seconds: 600,invite_allowed_guild_ids: [],invite_enforced_role_ids: [],invite_enforced_channel_ids: [],repeat_enabled: false,repeat_text: true,repeat_images: true,repeat_limit: 3,repeat_window_seconds: 30,repeat_timeout_seconds: 600,repeat_enforced_role_ids: [],repeat_enforced_channel_ids: [],spam_enabled: false,spam_limit: 5,spam_window_seconds: 5,spam_timeout_seconds: 600,spam_enforced_role_ids: [],spam_enforced_channel_ids: [],...row };
  const mapped = (await pool.query<{ role_id: string }>('SELECT role_id FROM staff_roles WHERE guild_id=$1',[guildId])).rows.map((role) => role.role_id);
  return { ...links,invite_enabled: false,invite_timeout_seconds: 600,invite_allowed_guild_ids: [],invite_enforced_role_ids: [],invite_enforced_channel_ids: [],repeat_enabled: false,repeat_text: true,repeat_images: true,repeat_limit: 3,repeat_window_seconds: 30,repeat_timeout_seconds: 600,repeat_enforced_role_ids: [],repeat_enforced_channel_ids: [],spam_enabled: false,spam_limit: 5,spam_window_seconds: 5,spam_timeout_seconds: 600,spam_enforced_role_ids: [],spam_enforced_channel_ids: [],guild_id: guildId,blocked_enabled: false,blocked_words: [],timeout_seconds: 600,exempt_role_ids: [...new Set([...mapped,
    ...(resources?.roles.filter((role) => ['owner','community manager'].includes(role.name.toLowerCase())).map((role) => role.id) ?? [])])].sort(),
    ignored_channel_ids: [],enforced_role_ids: [],enforced_channel_ids: [],revision: 0 };
}
export function autoModExempt(settings: AutoModSettings,roles: string[],channelId: string,parentId: string | null,rule: 'blocked_words'|'rapid_messages'|'repeated_messages'|'discord_invites'|'link_cooldown'|'scam_links'='blocked_words'): boolean {
  const roleMatch = (ids: string[]) => ids.some((id) => roles.includes(id));
  const channelMatch = (ids: string[]) => ids.includes(channelId) || !!parentId && ids.includes(parentId);
  return (roleMatch(settings.exempt_role_ids) && !roleMatch(rule==='link_cooldown'?settings.link_enforced_role_ids ?? []:rule==='scam_links'?settings.scam_enforced_role_ids ?? []:rule==='discord_invites'?settings.invite_enforced_role_ids ?? []:rule==='repeated_messages'?settings.repeat_enforced_role_ids ?? []:rule==='rapid_messages'?settings.spam_enforced_role_ids ?? []:settings.enforced_role_ids)) ||
    (channelMatch(settings.ignored_channel_ids) && !channelMatch(rule==='link_cooldown'?settings.link_enforced_channel_ids ?? []:rule==='scam_links'?settings.scam_enforced_channel_ids ?? []:rule==='discord_invites'?settings.invite_enforced_channel_ids ?? []:rule==='repeated_messages'?settings.repeat_enforced_channel_ids ?? []:rule==='rapid_messages'?settings.spam_enforced_channel_ids ?? []:settings.enforced_channel_ids));
}
export async function saveAutoModSettings(pool: Pick<Pool,'connect'>,input: {
  inviteEnabled?: boolean; inviteTimeoutSeconds?: number; inviteAllowedGuilds?: string[]; inviteEnforcedRoles?: string[]; inviteEnforcedChannels?: string[];
  repeatEnabled?: boolean; repeatText?: boolean; repeatImages?: boolean; repeatLimit?: number; repeatWindowSeconds?: number; repeatTimeoutSeconds?: number; repeatEnforcedRoles?: string[]; repeatEnforcedChannels?: string[];
  spamEnabled?: boolean; spamLimit?: number; spamWindowSeconds?: number; spamTimeoutSeconds?: number; spamEnforcedRoles?: string[]; spamEnforcedChannels?: string[];
  guildId: string; actorId: string; token: string; revision: number; enabled: boolean; words: string; timeoutSeconds: number;
  exemptRoles: string[]; ignoredChannels: string[]; enforcedRoles: string[]; enforcedChannels: string[]; reason: string;
  readRoles: (id: string) => Promise<string[] | null>; readResources: () => Promise<AutoModResources>;
}): Promise<void> {
  if (!Number.isInteger(input.revision) || input.revision<0 || input.revision>2147483647 || typeof input.enabled!=='boolean') throw new AutoModError('INVALID_INPUT');
  const reason = input.reason.trim(); if (!reason || reason.length>500) throw new AutoModError('INVALID_REASON');
  let words: string[]; try { words=parseBlockedWords(input.words); } catch { throw new AutoModError('INVALID_WORDS'); }
  if (input.enabled && !words.length) throw new AutoModError('INVALID_WORDS');
  if (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds<1 || input.timeoutSeconds>2419200) throw new AutoModError('INVALID_DURATION');
  if (input.spamEnabled!==undefined && typeof input.spamEnabled!=='boolean' ||
    [[input.spamLimit,2,50],[input.spamWindowSeconds,1,60],[input.spamTimeoutSeconds,1,2419200]].some(([value,min,max]) => value!==undefined && (!Number.isInteger(value) || value<min! || value>max!))) throw new AutoModError('INVALID_SPAM');
  if ([input.repeatEnabled,input.repeatText,input.repeatImages].some((v) => v!==undefined && typeof v!=='boolean') ||
    [[input.repeatLimit,2,50],[input.repeatWindowSeconds,1,300],[input.repeatTimeoutSeconds,1,2419200]].some(([v,min,max]) => v!==undefined && (!Number.isInteger(v) || v<min! || v>max!))) throw new AutoModError('INVALID_REPEAT');
  if(input.inviteEnabled!==undefined && typeof input.inviteEnabled!=='boolean' || input.inviteTimeoutSeconds!==undefined && (!Number.isInteger(input.inviteTimeoutSeconds) || input.inviteTimeoutSeconds<1 || input.inviteTimeoutSeconds>2419200)) throw new AutoModError('INVALID_INVITES');
  const arrays=[input.inviteAllowedGuilds ?? [],input.inviteEnforcedRoles ?? [],input.inviteEnforcedChannels ?? [],input.repeatEnforcedRoles ?? [],input.repeatEnforcedChannels ?? [],input.spamEnforcedRoles ?? [],input.spamEnforcedChannels ?? [],input.exemptRoles,input.ignoredChannels,input.enforcedRoles,input.enforcedChannels];
  if (arrays.some((ids) => ids.length>100 || new Set(ids).size!==ids.length || ids.some((id) => !/^\d{17,20}$/.test(id))) ||
      input.enforcedRoles.some((id) => !input.exemptRoles.includes(id)) || input.enforcedChannels.some((id) => !input.ignoredChannels.includes(id))) throw new AutoModError('INVALID_SELECTION');
  if ((input.spamEnforcedRoles ?? []).some((id) => !input.exemptRoles.includes(id)) || (input.spamEnforcedChannels ?? []).some((id) => !input.ignoredChannels.includes(id))) throw new AutoModError('INVALID_SELECTION');
  if ((input.repeatEnforcedRoles ?? []).some((id) => !input.exemptRoles.includes(id)) || (input.repeatEnforcedChannels ?? []).some((id) => !input.ignoredChannels.includes(id))) throw new AutoModError('INVALID_SELECTION');
  if ((input.inviteEnforcedRoles ?? []).some((id) => !input.exemptRoles.includes(id)) || (input.inviteEnforcedChannels ?? []).some((id) => !input.ignoredChannels.includes(id))) throw new AutoModError('INVALID_SELECTION');
  const client=await pool.connect(); let locked=false,transaction=false,discard=false;
  try {
    locked=(await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),731209) AS locked',[input.guildId])).rows[0]?.locked===true;
    if (!locked) throw new AutoModError('BUSY');
    await client.query('BEGIN'); transaction=true;
    await client.query("SET LOCAL lock_timeout='5s'");
    const guild=await client.query<{ settings: Record<string,unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[input.guildId]);
    if (!guild.rowCount) throw new AutoModError('NOT_CONFIGURED');
    if (!(await client.query('SELECT user_id FROM dashboard_sessions WHERE guild_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>NOW()',[input.guildId,input.actorId,digest(input.token)])).rowCount) throw new AutoModError('SESSION_EXPIRED');
    const roles=await input.readRoles(input.actorId);
    if (!roles || await getStaffAccess(client,input.guildId,input.actorId,roles)!=='admin') throw new AutoModError('ADMIN_REQUIRED');
    const resources=await input.readResources(); const before=await readAutoModSettings(client,input.guildId,resources);
    if (before.revision!==input.revision) throw new AutoModError('STALE_SETTINGS');
    const inviteEnabled=input.inviteEnabled ?? before.invite_enabled ?? false;
    const repeatEnabled=input.repeatEnabled ?? before.repeat_enabled ?? false;
    if (repeatEnabled && !(input.repeatText ?? before.repeat_text ?? true) && !(input.repeatImages ?? before.repeat_images ?? true)) throw new AutoModError('INVALID_REPEAT');
    const spamEnabled=input.spamEnabled ?? before.spam_enabled ?? false;
    if ((input.enabled || spamEnabled || repeatEnabled || inviteEnabled) && !logChannelId(guild.rows[0]!.settings)) throw new AutoModError('LOG_REQUIRED');
    if ((input.enabled || spamEnabled || repeatEnabled || inviteEnabled) && (!resources.canDelete || !resources.canTimeout)) throw new AutoModError('BOT_PERMISSIONS');
    const disablingOnly=(before.blocked_enabled || before.spam_enabled || before.repeat_enabled || before.invite_enabled) && !input.enabled && !spamEnabled && !repeatEnabled && !inviteEnabled &&
      (input.inviteTimeoutSeconds ?? before.invite_timeout_seconds)===before.invite_timeout_seconds && JSON.stringify(input.inviteAllowedGuilds ?? before.invite_allowed_guild_ids)===JSON.stringify(before.invite_allowed_guild_ids) && JSON.stringify(input.inviteEnforcedRoles ?? before.invite_enforced_role_ids)===JSON.stringify(before.invite_enforced_role_ids) && JSON.stringify(input.inviteEnforcedChannels ?? before.invite_enforced_channel_ids)===JSON.stringify(before.invite_enforced_channel_ids) &&
      (input.repeatText ?? before.repeat_text)===before.repeat_text && (input.repeatImages ?? before.repeat_images)===before.repeat_images && (input.repeatLimit ?? before.repeat_limit)===before.repeat_limit && (input.repeatWindowSeconds ?? before.repeat_window_seconds)===before.repeat_window_seconds && (input.repeatTimeoutSeconds ?? before.repeat_timeout_seconds)===before.repeat_timeout_seconds &&
      JSON.stringify(input.repeatEnforcedRoles ?? before.repeat_enforced_role_ids)===JSON.stringify(before.repeat_enforced_role_ids) && JSON.stringify(input.repeatEnforcedChannels ?? before.repeat_enforced_channel_ids)===JSON.stringify(before.repeat_enforced_channel_ids) &&
      (input.spamLimit ?? before.spam_limit)===before.spam_limit && (input.spamWindowSeconds ?? before.spam_window_seconds)===before.spam_window_seconds && (input.spamTimeoutSeconds ?? before.spam_timeout_seconds)===before.spam_timeout_seconds &&
      JSON.stringify(input.spamEnforcedRoles ?? before.spam_enforced_role_ids)===JSON.stringify(before.spam_enforced_role_ids) && JSON.stringify(input.spamEnforcedChannels ?? before.spam_enforced_channel_ids)===JSON.stringify(before.spam_enforced_channel_ids) && JSON.stringify(words)===JSON.stringify(before.blocked_words) && input.timeoutSeconds===before.timeout_seconds &&
      [[input.exemptRoles,before.exempt_role_ids],[input.ignoredChannels,before.ignored_channel_ids],[input.enforcedRoles,before.enforced_role_ids],[input.enforcedChannels,before.enforced_channel_ids]]
        .every(([left,right]) => JSON.stringify([...left!].sort())===JSON.stringify([...right!].sort()));
    if (!disablingOnly && ([...input.exemptRoles,...input.enforcedRoles,...(input.inviteEnforcedRoles ?? before.invite_enforced_role_ids ?? []),...(input.spamEnforcedRoles ?? before.spam_enforced_role_ids ?? []),...(input.repeatEnforcedRoles ?? before.repeat_enforced_role_ids ?? [])].some((id) => !resources.roles.some((role) => role.id===id)) ||
        [...input.ignoredChannels,...input.enforcedChannels,...(input.inviteEnforcedChannels ?? before.invite_enforced_channel_ids ?? []),...(input.spamEnforcedChannels ?? before.spam_enforced_channel_ids ?? []),...(input.repeatEnforcedChannels ?? before.repeat_enforced_channel_ids ?? [])].some((id) => !resources.channels.some((channel) => channel.id===id)))) throw new AutoModError('INVALID_SELECTION');
    const after: AutoModSettings={ invite_enabled: inviteEnabled,invite_timeout_seconds: input.inviteTimeoutSeconds ?? before.invite_timeout_seconds ?? 600,invite_allowed_guild_ids: [...(input.inviteAllowedGuilds ?? before.invite_allowed_guild_ids ?? [])].sort(),invite_enforced_role_ids: [...(input.inviteEnforcedRoles ?? before.invite_enforced_role_ids ?? [])].sort(),invite_enforced_channel_ids: [...(input.inviteEnforcedChannels ?? before.invite_enforced_channel_ids ?? [])].sort(),repeat_enabled: repeatEnabled,repeat_text: input.repeatText ?? before.repeat_text ?? true,repeat_images: input.repeatImages ?? before.repeat_images ?? true,repeat_limit: input.repeatLimit ?? before.repeat_limit ?? 3,repeat_window_seconds: input.repeatWindowSeconds ?? before.repeat_window_seconds ?? 30,repeat_timeout_seconds: input.repeatTimeoutSeconds ?? before.repeat_timeout_seconds ?? 600,repeat_enforced_role_ids: [...(input.repeatEnforcedRoles ?? before.repeat_enforced_role_ids ?? [])].sort(),repeat_enforced_channel_ids: [...(input.repeatEnforcedChannels ?? before.repeat_enforced_channel_ids ?? [])].sort(),spam_enabled: spamEnabled,spam_limit: input.spamLimit ?? before.spam_limit ?? 5,spam_window_seconds: input.spamWindowSeconds ?? before.spam_window_seconds ?? 5,spam_timeout_seconds: input.spamTimeoutSeconds ?? before.spam_timeout_seconds ?? 600,
      spam_enforced_role_ids: [...(input.spamEnforcedRoles ?? before.spam_enforced_role_ids ?? [])].sort(),spam_enforced_channel_ids: [...(input.spamEnforcedChannels ?? before.spam_enforced_channel_ids ?? [])].sort(),guild_id: input.guildId,blocked_enabled: input.enabled,blocked_words: words,timeout_seconds: input.timeoutSeconds,
      exempt_role_ids: [...input.exemptRoles].sort(),ignored_channel_ids: [...input.ignoredChannels].sort(),enforced_role_ids: [...input.enforcedRoles].sort(),enforced_channel_ids: [...input.enforcedChannels].sort(),revision: before.revision };
    if ((after.spam_enforced_role_ids ?? []).some((id) => !after.exempt_role_ids.includes(id)) || (after.spam_enforced_channel_ids ?? []).some((id) => !after.ignored_channel_ids.includes(id))) throw new AutoModError('INVALID_SELECTION');
    if ((after.repeat_enforced_role_ids ?? []).some((id) => !after.exempt_role_ids.includes(id)) || (after.repeat_enforced_channel_ids ?? []).some((id) => !after.ignored_channel_ids.includes(id))) throw new AutoModError('INVALID_SELECTION');
    if ((after.invite_enforced_role_ids ?? []).some((id) => !after.exempt_role_ids.includes(id)) || (after.invite_enforced_channel_ids ?? []).some((id) => !after.ignored_channel_ids.includes(id))) throw new AutoModError('INVALID_SELECTION');
    if (JSON.stringify(before, Object.keys(after).sort())===JSON.stringify(after,Object.keys(after).sort())) { await client.query('COMMIT'); transaction=false; return; }
    after.revision++;
    await client.query(`INSERT INTO automod_settings (guild_id,blocked_enabled,blocked_words,timeout_seconds,exempt_role_ids,ignored_channel_ids,enforced_role_ids,enforced_channel_ids,revision,updated_by,spam_enabled,spam_limit,spam_window_seconds,spam_timeout_seconds,spam_enforced_role_ids,spam_enforced_channel_ids,repeat_enabled,repeat_text,repeat_images,repeat_limit,repeat_window_seconds,repeat_timeout_seconds,repeat_enforced_role_ids,repeat_enforced_channel_ids,invite_enabled,invite_timeout_seconds,invite_allowed_guild_ids,invite_enforced_role_ids,invite_enforced_channel_ids)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) ON CONFLICT (guild_id) DO UPDATE SET blocked_enabled=$2,blocked_words=$3,timeout_seconds=$4,
      exempt_role_ids=$5,ignored_channel_ids=$6,enforced_role_ids=$7,enforced_channel_ids=$8,revision=$9,updated_by=$10,updated_at=NOW(),spam_enabled=$11,spam_limit=$12,spam_window_seconds=$13,spam_timeout_seconds=$14,spam_enforced_role_ids=$15,spam_enforced_channel_ids=$16,repeat_enabled=$17,repeat_text=$18,repeat_images=$19,repeat_limit=$20,repeat_window_seconds=$21,repeat_timeout_seconds=$22,repeat_enforced_role_ids=$23,repeat_enforced_channel_ids=$24,invite_enabled=$25,invite_timeout_seconds=$26,invite_allowed_guild_ids=$27,invite_enforced_role_ids=$28,invite_enforced_channel_ids=$29`,
      [input.guildId,after.blocked_enabled,after.blocked_words,after.timeout_seconds,after.exempt_role_ids,after.ignored_channel_ids,after.enforced_role_ids,after.enforced_channel_ids,after.revision,input.actorId,after.spam_enabled,after.spam_limit,after.spam_window_seconds,after.spam_timeout_seconds,after.spam_enforced_role_ids,after.spam_enforced_channel_ids,after.repeat_enabled,after.repeat_text,after.repeat_images,after.repeat_limit,after.repeat_window_seconds,after.repeat_timeout_seconds,after.repeat_enforced_role_ids,after.repeat_enforced_channel_ids,after.invite_enabled,after.invite_timeout_seconds,after.invite_allowed_guild_ids,after.invite_enforced_role_ids,after.invite_enforced_channel_ids]);
    await client.query(`UPDATE automod_link_settings SET
      link_enforced_role_ids=ARRAY(SELECT id FROM unnest(link_enforced_role_ids) id WHERE id=ANY($2::text[])),
      scam_enforced_role_ids=ARRAY(SELECT id FROM unnest(scam_enforced_role_ids) id WHERE id=ANY($2::text[])),
      link_enforced_channel_ids=ARRAY(SELECT id FROM unnest(link_enforced_channel_ids) id WHERE id=ANY($3::text[])),
      scam_enforced_channel_ids=ARRAY(SELECT id FROM unnest(scam_enforced_channel_ids) id WHERE id=ANY($3::text[])) WHERE guild_id=$1`,[input.guildId,after.exempt_role_ids,after.ignored_channel_ids]);
    await client.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'AUTOMOD_SETTINGS_CHANGED',$3::jsonb)",[input.guildId,input.actorId,JSON.stringify({ before,after,reason })]);
    await client.query('COMMIT'); transaction=false;
  } catch(error) { if(transaction) { try { await client.query('ROLLBACK'); } catch { discard=true; } } throw error; }
  finally { if(locked) { try { await client.query('SELECT pg_advisory_unlock(hashtext($1),731209)',[input.guildId]); } catch { discard=true; } } client.release(discard?new Error('AutoMod settings connection unavailable.'):undefined); }
}
