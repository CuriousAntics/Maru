import type { Pool } from 'pg';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { getStaffAccess } from './staff-access.js';
import { digest, validToken } from './web-security.js';
import { logChannelId, SettingsError } from './server-settings.js';
import type { LogChannel } from './server-settings.js';

export type TestLogResult = {
  status: 'sent' | 'rejected' | 'unconfirmed' | 'pending' | 'cooldown';
  channelId: string; messageId?: string; auditRecorded: boolean;
};
export type SendTestMessage = (
  channelId: string, body: RESTPostAPIChannelMessageJSONBody
) => Promise<{ id: string; channel_id: string }>;

export function testLogMessage(actorId: string, requestId: string): RESTPostAPIChannelMessageJSONBody {
  return {
    allowed_mentions: { parse: [] }, nonce: digest(requestId).slice(0, 25), enforce_nonce: true,
    embeds: [{ title: 'Maru log delivery test', color: 0xe6ad73,
      description: 'This is a test message. No moderation action was performed.',
      fields: [{ name: 'Requested by', value: actorId }, { name: 'Reference', value: requestId }],
      timestamp: new Date().toISOString() }],
  };
}

// Claim once in PostgreSQL before contacting Discord. Never retry a claimed request.
export async function sendTestLog(pool: Pick<Pool, 'query' | 'connect'>, input: {
  guildId: string; actorId: string; sessionToken: string; requestId: string; expectedChannelId: string;
  readMemberRoles: (userId: string) => Promise<string[] | null>;
  readLogChannels: () => Promise<LogChannel[]>;
  sendMessage: SendTestMessage;
}): Promise<TestLogResult> {
  if (![input.guildId, input.actorId, input.expectedChannelId].every((id) => /^\d{17,20}$/.test(id)) ||
      !validToken(input.requestId)) throw new SettingsError('INVALID_TEST_REQUEST');
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const guild = await client.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM guild_settings WHERE guild_id = $1 FOR UPDATE', [input.guildId]);
    if (!guild.rows[0]) throw new SettingsError('SERVER_NOT_CONFIGURED');
    const session = await client.query(
      `SELECT user_id FROM dashboard_sessions WHERE token_hash = $1 AND guild_id = $2
       AND user_id = $3 AND expires_at > NOW()`, [digest(input.sessionToken), input.guildId, input.actorId]);
    if (!session.rowCount) throw new SettingsError('SESSION_EXPIRED');
    const roles = await input.readMemberRoles(input.actorId);
    if (!roles || await getStaffAccess(client, input.guildId, input.actorId, roles) !== 'admin') {
      throw new SettingsError('ADMIN_REQUIRED');
    }
    const existing = await client.query<{ event_type: string; details: Record<string, unknown> }>(
      `SELECT event_type, details FROM audit_events WHERE guild_id = $1 AND details->>'request_id' = $2
       AND event_type IN ('TEST_LOG_REQUESTED', 'TEST_LOG_SENT', 'TEST_LOG_REJECTED', 'TEST_LOG_UNCONFIRMED')
       ORDER BY event_id DESC LIMIT 1`, [input.guildId, input.requestId]);
    if (existing.rows[0]) {
      const event = existing.rows[0];
      await client.query('COMMIT'); transaction = false;
      return { status: event.event_type === 'TEST_LOG_SENT' ? 'sent' : event.event_type === 'TEST_LOG_REJECTED'
        ? 'rejected' : event.event_type === 'TEST_LOG_UNCONFIRMED' ? 'unconfirmed' : 'pending',
        channelId: String(event.details.channel_id), auditRecorded: event.event_type !== 'TEST_LOG_REQUESTED',
        messageId: typeof event.details.message_id === 'string' ? event.details.message_id : undefined };
    }
    const channelId = logChannelId(guild.rows[0].settings);
    if (!channelId) throw new SettingsError('LOG_CHANNEL_REQUIRED');
    if (channelId !== input.expectedChannelId) throw new SettingsError('SETTINGS_CHANGED');
    const channels = await input.readLogChannels();
    if (!channels.some((channel) => channel.id === channelId && channel.usable)) {
      throw new SettingsError('CHANNEL_UNAVAILABLE');
    }
    const recent = await client.query(
      `SELECT event_id FROM audit_events WHERE guild_id = $1 AND event_type = 'TEST_LOG_REQUESTED'
       AND created_at > NOW() - INTERVAL '30 seconds' LIMIT 1`, [input.guildId]);
    if (recent.rowCount) {
      await client.query('COMMIT'); transaction = false;
      return { status: 'cooldown', channelId, auditRecorded: false };
    }
    await client.query(
      `INSERT INTO audit_events (guild_id, actor_id, event_type, details)
       VALUES ($1, $2, 'TEST_LOG_REQUESTED', $3::jsonb)`,
      [input.guildId, input.actorId, JSON.stringify({ request_id: input.requestId, channel_id: channelId,
        reason: 'Staff requested a log delivery test.' })]);
    await client.query('COMMIT'); transaction = false;
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { /* Keep original failure. */ } }
    throw error;
  } finally { client.release(); }

  let status: 'sent' | 'rejected' | 'unconfirmed' = 'unconfirmed';
  let messageId: string | undefined;
  try {
    const result = await input.sendMessage(input.expectedChannelId, testLogMessage(input.actorId, input.requestId));
    if (!/^\d{17,20}$/.test(result.id) || result.channel_id !== input.expectedChannelId) {
      throw new Error('INVALID_DELIVERY_RESPONSE');
    }
    status = 'sent'; messageId = result.id;
  } catch (error: unknown) {
    // A lost response may follow a successful send. Only explicit client errors are definite failures.
    if (error && typeof error === 'object' && 'status' in error &&
        [400, 401, 403, 404].includes(Number(error.status))) status = 'rejected';
  }
  const reason = status === 'sent' ? 'Discord confirmed the test message.' : status === 'rejected'
    ? 'Discord rejected the test message. Check channel access and bot permissions.'
    : 'Delivery was not confirmed. Check the channel before requesting another test.';
  try {
    await pool.query(
      `INSERT INTO audit_events (guild_id, actor_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)`,
      [input.guildId, input.actorId, `TEST_LOG_${status.toUpperCase()}`,
        JSON.stringify({ request_id: input.requestId, channel_id: input.expectedChannelId, message_id: messageId, reason })]);
    return { status, channelId: input.expectedChannelId, messageId, auditRecorded: true };
  } catch {
    // The committed request remains durable even if recording its outcome fails.
    console.error('Test log outcome could not be recorded. Check the channel and the requested audit event.');
    return { status, channelId: input.expectedChannelId, messageId, auditRecorded: false };
  }
}
