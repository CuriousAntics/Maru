import type { Pool } from 'pg';
import { builtInCommandNames } from './commands.js';
import { digest } from './web-security.js';
import { getStaffAccess } from './staff-access.js';
export type CustomCommand = {
  guild_id: string; name: string; description: string; response: string; enabled: boolean; deleted: boolean; inline_enabled: boolean;
  revision: number; discord_id: string | null; sync_status: 'pending'|'running'|'synced'|'error'; sync_note: string;
  sync_started_at: Date | string | null;
};
export const customName = (name: string) => /^[a-z0-9_-]{1,32}$/.test(name) && !builtInCommandNames.has(name);
export class CustomCommandError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export async function saveCustomCommand(pool: Pick<Pool,'connect'>, i: {
  guildId: string; actorId: string; token: string; name: string; revision: number; description: string; response: string;
  enabled: boolean; inlineEnabled?: boolean; remove: boolean; reason: string; readRoles: (id: string) => Promise<string[] | null>;
}) {
  const description = i.description.trim(), response = i.response.trim(), reason = i.reason.trim();
  if (!customName(i.name) || !Number.isInteger(i.revision) || i.revision < 0 || i.revision >= 2147483647 ||
      !description || description.length > 100 || !response || response.length > 2000 || !reason || reason.length > 500 ||
      typeof i.enabled !== 'boolean' || i.inlineEnabled !== undefined && typeof i.inlineEnabled !== 'boolean' || typeof i.remove !== 'boolean') throw new CustomCommandError('INVALID_INPUT');
  const db = await pool.connect(); let discard = false;
  try {
    await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='5s'");
    if (!(await db.query('SELECT 1 FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[i.guildId])).rowCount) throw new CustomCommandError('NOT_CONFIGURED');
    if (!(await db.query('SELECT 1 FROM dashboard_sessions WHERE guild_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>NOW()',
      [i.guildId,i.actorId,digest(i.token)])).rowCount) throw new CustomCommandError('SESSION_EXPIRED');
    const roles = await i.readRoles(i.actorId);
    if (!roles || await getStaffAccess(db,i.guildId,i.actorId,roles) !== 'admin') throw new CustomCommandError('ADMIN_REQUIRED');
    const before = (await db.query<CustomCommand>('SELECT * FROM custom_commands WHERE guild_id=$1 AND name=$2 FOR UPDATE',[i.guildId,i.name])).rows[0];
    if ((before?.revision ?? 0) !== i.revision) throw new CustomCommandError('STALE_SETTINGS');
    if (i.remove && !before) throw new CustomCommandError('NOT_FOUND');
    // Settings cannot change underneath an external registration/removal already claimed by the worker.
    if (before?.sync_status === 'running') throw new CustomCommandError('BUSY');
    if ((!before || before.deleted) && !i.remove && Number((await db.query<{ count: string }>(
      'SELECT count(*) FROM custom_commands WHERE guild_id=$1 AND NOT deleted',[i.guildId])).rows[0]!.count) >= 80) throw new CustomCommandError('LIMIT');
    const enabled = !i.remove && i.enabled;
    const inlineEnabled = i.inlineEnabled ?? before?.inline_enabled ?? false;
    await db.query(`INSERT INTO custom_commands (guild_id,name,description,response,enabled,deleted,revision,updated_by,inline_enabled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (guild_id,name) DO UPDATE SET
      description=$3,response=$4,enabled=$5,deleted=$6,revision=$7,updated_by=$8,updated_at=NOW(),
      inline_enabled=$9,sync_status='pending',sync_note='Waiting to synchronize',sync_started_at=NULL`,
      [i.guildId,i.name,description,response,enabled,i.remove,i.revision+1,i.actorId,inlineEnabled]);
    // Response content belongs in settings, not duplicated into audit or moderation logs.
    await db.query("INSERT INTO audit_events(guild_id,actor_id,event_type,details) VALUES ($1,$2,'CUSTOM_COMMAND_CHANGED',$3::jsonb)",
      [i.guildId,i.actorId,JSON.stringify({ name:i.name,revision:i.revision+1,enabled,inline_enabled:inlineEnabled,removed:i.remove,reason })]);
    await db.query('COMMIT');
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { discard = true; }
    if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') throw new CustomCommandError('BUSY');
    throw error;
  } finally { db.release(discard ? new Error('Custom command connection unavailable') : undefined); }
}
