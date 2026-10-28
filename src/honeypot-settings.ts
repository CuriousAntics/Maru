import type { Pool } from 'pg';
import { digest } from './web-security.js';
import { getStaffAccess } from './staff-access.js';
import { logChannelId } from './server-settings.js';
export type HoneypotSettings={ guild_id: string; enabled: boolean; channel_ids: string[]; exempt_role_ids: string[]; warning_confirmed: boolean; revision: number };
export type HoneypotResources={ channels: { id: string; name: string; usable: boolean }[]; roles: { id: string; name: string }[]; canBan: boolean };
export class HoneypotError extends Error { constructor(public readonly code: string) { super(code); } }
export async function readHoneypotSettings(db: Pick<Pool,'query'>,guildId: string): Promise<HoneypotSettings> {
  const row=(await db.query<HoneypotSettings>('SELECT * FROM honeypot_settings WHERE guild_id=$1',[guildId])).rows[0];
  return row ?? { guild_id: guildId,enabled: false,channel_ids: [],exempt_role_ids: [],warning_confirmed: false,revision: 0 };
}
export async function saveHoneypotSettings(pool: Pick<Pool,'connect'>,input: {
  guildId: string; actorId: string; token: string; revision: number; enabled: boolean;
  channels: string[]; exemptRoles: string[]; warningConfirmed: boolean; reason: string;
  readRoles: (id: string) => Promise<string[] | null>; readResources: () => Promise<HoneypotResources>;
}): Promise<void> {
  const reason=input.reason.trim();
  if(!reason || reason.length>500) throw new HoneypotError('INVALID_REASON');
  if(!Number.isInteger(input.revision) || input.revision<0 || input.revision>=2147483647 || typeof input.enabled!=='boolean' || typeof input.warningConfirmed!=='boolean' ||
    [[input.channels,20],[input.exemptRoles,100]].some(([ids,max]) => { const values=ids as string[]; return values.length>(max as number) || new Set(values).size!==values.length || values.some((id) => !/^\d{17,20}$/.test(id)); })) throw new HoneypotError('INVALID_SELECTION');
  const client=await pool.connect(); let transaction=false,discard=false;
  try {
    await client.query('BEGIN'); transaction=true;
    await client.query("SET LOCAL lock_timeout='5s'");
    const guild=(await client.query<{ settings: Record<string,unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[input.guildId])).rows[0];
    if(!guild) throw new HoneypotError('NOT_CONFIGURED');
    if(!(await client.query('SELECT 1 FROM dashboard_sessions WHERE guild_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>NOW()',[input.guildId,input.actorId,digest(input.token)])).rowCount) throw new HoneypotError('SESSION_EXPIRED');
    const roles=await input.readRoles(input.actorId);
    if(!roles || await getStaffAccess(client,input.guildId,input.actorId,roles)!=='admin') throw new HoneypotError('ADMIN_REQUIRED');
    const before=await readHoneypotSettings(client,input.guildId);
    if(before.revision!==input.revision) throw new HoneypotError('STALE_SETTINGS');
    const resources=await input.readResources();
    if(input.enabled && (!input.channels.length || !input.warningConfirmed)) throw new HoneypotError('WARNING_REQUIRED');
    if(input.enabled && (!resources.canBan || !logChannelId(guild.settings) || input.channels.includes(logChannelId(guild.settings)!))) throw new HoneypotError('PERMISSIONS_OR_LOG');
    // Always allow switching Off even after a channel or role has been deleted.
    if(input.enabled && (input.channels.some((id) => !resources.channels.some((c) => c.id===id && c.usable)) || input.exemptRoles.some((id) => !resources.roles.some((r) => r.id===id)))) throw new HoneypotError('INVALID_SELECTION');
    const after={ guild_id: input.guildId,enabled: input.enabled,channel_ids: [...input.channels].sort(),exempt_role_ids: [...input.exemptRoles].sort(),warning_confirmed: input.warningConfirmed,revision: before.revision };
    if(JSON.stringify(before,Object.keys(after).sort())!==JSON.stringify(after,Object.keys(after).sort())) {
      after.revision++;
      await client.query(`INSERT INTO honeypot_settings (guild_id,enabled,channel_ids,exempt_role_ids,warning_confirmed,revision,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (guild_id) DO UPDATE SET enabled=$2,channel_ids=$3,exempt_role_ids=$4,warning_confirmed=$5,revision=$6,updated_by=$7,updated_at=NOW()`,
        [input.guildId,after.enabled,after.channel_ids,after.exempt_role_ids,after.warning_confirmed,after.revision,input.actorId]);
      await client.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'HONEYPOT_SETTINGS_CHANGED',$3::jsonb)",[input.guildId,input.actorId,JSON.stringify({ before,after,reason,delete_message_seconds: 86400 })]);
    }
    await client.query('COMMIT'); transaction=false;
  } catch(error) { if(transaction) { try { await client.query('ROLLBACK'); } catch { discard=true; } } throw error; }
  finally { client.release(discard?new Error('Honeypot settings connection unavailable.'):undefined); }
}
