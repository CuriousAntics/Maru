import type { Pool } from 'pg';
import { digest } from './web-security.js';
import { getStaffAccess } from './staff-access.js';

export type ChatClearResources = { channels: { id: string; name: string; usable: boolean }[] };
export type ChatClearSettings = {
  guild_id: string; enabled: boolean; channel_id: string | null; interval_hours: number;
  next_run_at: Date | string | null; revision: number;
};
export class ChatClearError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export async function readChatClearSettings(db: Pick<Pool, 'query'>, guildId: string): Promise<ChatClearSettings> {
  return (await db.query<ChatClearSettings>('SELECT * FROM chat_clear_settings WHERE guild_id=$1', [guildId])).rows[0]
    ?? { guild_id: guildId, enabled: false, channel_id: null, interval_hours: 6, next_run_at: null, revision: 0 };
}
export async function saveChatClearSettings(pool: Pick<Pool, 'connect'>, input: {
  guildId: string; actorId: string; token: string; revision: number; enabled: boolean;
  channelId: string | null; intervalHours: number; reason: string;
  readRoles: (id: string) => Promise<string[] | null>; readResources: () => Promise<ChatClearResources>;
}) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 500 || typeof input.enabled !== 'boolean' ||
      !Number.isInteger(input.intervalHours) || input.intervalHours < 1 || input.intervalHours > 720 ||
      !Number.isInteger(input.revision) || input.revision < 0 || input.revision >= 2147483647 ||
      input.channelId !== null && !/^\d{17,20}$/.test(input.channelId)) throw new ChatClearError('INVALID_INPUT');
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    // Serialize first saves; existing schedules use a separate row lock shared with the worker.
    if (!(await db.query('SELECT 1 FROM guild_settings WHERE guild_id=$1 FOR UPDATE', [input.guildId])).rowCount)
      throw new ChatClearError('NOT_CONFIGURED');
    if (!(await db.query('SELECT 1 FROM dashboard_sessions WHERE guild_id=$1 AND user_id=$2 AND token_hash=$3 AND expires_at>NOW()',
      [input.guildId, input.actorId, digest(input.token)])).rowCount) throw new ChatClearError('SESSION_EXPIRED');
    const roles = await input.readRoles(input.actorId);
    if (!roles || await getStaffAccess(db, input.guildId, input.actorId, roles) !== 'admin') throw new ChatClearError('ADMIN_REQUIRED');
    await db.query('SELECT 1 FROM chat_clear_settings WHERE guild_id=$1 FOR UPDATE', [input.guildId]);
    const before = await readChatClearSettings(db, input.guildId);
    if (before.revision !== input.revision) throw new ChatClearError('STALE_SETTINGS');
    if (input.enabled) {
      const resources = await input.readResources();
      if (!resources.channels.some(c => c.id === input.channelId && c.usable)) throw new ChatClearError('CHANNEL_UNAVAILABLE');
    }
    const changed = before.enabled !== input.enabled || before.channel_id !== input.channelId || before.interval_hours !== input.intervalHours;
    if (changed) {
      // A genuine schedule change starts a fresh interval; saving unchanged settings never postpones it.
      const result = await db.query<ChatClearSettings>(`INSERT INTO chat_clear_settings
        (guild_id,enabled,channel_id,interval_hours,next_run_at,revision,updated_by)
        VALUES ($1,$2,$3,$4,CASE WHEN $2 THEN NOW()+$4::integer*INTERVAL '1 hour' ELSE NULL END,$5,$6)
        ON CONFLICT (guild_id) DO UPDATE SET enabled=$2,channel_id=$3,interval_hours=$4,
        next_run_at=CASE WHEN $2 THEN NOW()+$4::integer*INTERVAL '1 hour' ELSE NULL END,revision=$5,updated_by=$6,updated_at=NOW() RETURNING *`,
        [input.guildId, input.enabled, input.channelId, input.intervalHours, before.revision + 1, input.actorId]);
      await db.query(`UPDATE chat_clear_runs SET status='cancelled',note='Schedule changed or disabled',finished_at=NOW()
        WHERE guild_id=$1 AND status='running'`, [input.guildId]);
      await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'CHAT_CLEAR_SETTINGS_CHANGED',$3::jsonb)",
        [input.guildId, input.actorId, JSON.stringify({ before, after: result.rows[0], reason, preserve_pins: true })]);
    }
    await db.query('COMMIT');
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { discard = true; }
    if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') throw new ChatClearError('BUSY');
    throw error;
  } finally { db.release(discard ? new Error('Chat clear connection unavailable') : undefined); }
}
