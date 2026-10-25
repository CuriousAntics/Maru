import type { Pool } from 'pg';
import { getStaffAccess } from './staff-access.js';
import { digest } from './web-security.js';

export type LogChannel = { id: string; name: string; usable: boolean };
export class SettingsError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function logChannelId(settings: Record<string, unknown>): string | null {
  return typeof settings.moderation_log_channel_id === 'string' ? settings.moderation_log_channel_id : null;
}

export async function saveLogChannel(pool: Pick<Pool, 'connect'>, input: {
  guildId: string; actorId: string; sessionToken: string;
  channelId: string | null; previousChannelId: string | null; reason: string;
  readMemberRoles: (userId: string) => Promise<string[] | null>;
  readLogChannels: () => Promise<LogChannel[]>;
}): Promise<'changed' | 'unchanged'> {
  if (![input.guildId, input.actorId].every((id) => /^\d{17,20}$/.test(id)) ||
      [input.channelId, input.previousChannelId].some((id) => id !== null && !/^\d{17,20}$/.test(id))) {
    throw new SettingsError('INVALID_CHANNEL');
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new SettingsError('INVALID_REASON');
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // Shared with access-grant mutations: revocation cannot race this authorization check.
    const result = await client.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM guild_settings WHERE guild_id = $1 FOR UPDATE', [input.guildId]);
    if (!result.rows[0]) throw new SettingsError('SERVER_NOT_CONFIGURED');
    const session = await client.query(
      `SELECT user_id FROM dashboard_sessions WHERE token_hash = $1 AND guild_id = $2
       AND user_id = $3 AND expires_at > NOW()`, [digest(input.sessionToken), input.guildId, input.actorId]);
    if (!session.rowCount) throw new SettingsError('SESSION_EXPIRED');
    const roles = await input.readMemberRoles(input.actorId);
    if (!roles || await getStaffAccess(client, input.guildId, input.actorId, roles) !== 'admin') {
      throw new SettingsError('ADMIN_REQUIRED');
    }
    const previous = logChannelId(result.rows[0].settings);
    if (previous !== input.previousChannelId) throw new SettingsError('SETTINGS_CHANGED');
    if (input.channelId !== null) {
      const channels = await input.readLogChannels();
      if (!channels.some((channel) => channel.id === input.channelId && channel.usable)) {
        throw new SettingsError('CHANNEL_UNAVAILABLE');
      }
    }
    if (previous === input.channelId) {
      await client.query('COMMIT'); transaction = false;
      return 'unchanged';
    }
    await client.query(
      `UPDATE guild_settings SET settings = settings || jsonb_build_object('moderation_log_channel_id', $2::text),
       updated_at = NOW() WHERE guild_id = $1`, [input.guildId, input.channelId]);
    await client.query(
      `INSERT INTO audit_events (guild_id, actor_id, event_type, details)
       VALUES ($1, $2, 'SERVER_SETTINGS_CHANGED', $3::jsonb)`,
      [input.guildId, input.actorId, JSON.stringify({ setting: 'moderation_log_channel_id',
        previous_channel_id: previous, channel_id: input.channelId, reason })]);
    await client.query('COMMIT'); transaction = false;
    return 'changed';
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { /* Keep original failure. */ } }
    throw error;
  } finally { client.release(); }
}
