import type { Pool } from 'pg';
import { escapeMarkdown } from 'discord.js';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { getStaffAccess } from './staff-access.js';
import { digest } from './web-security.js';
import { logChannelId } from './server-settings.js';
import type { LogChannel } from './server-settings.js';

export class WarningError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unconfirmed' | 'not_configured' | 'skipped';
export type WarningCase = {
  origin?: 'manual' | 'automod' | 'raid';
  guild_id: string; case_number: number; request_id: string; action: 'warning' | 'timeout' | 'untimeout' | 'ban' | 'unban' | 'softban';
  actor_id: string; target_user_id: string; reason: string; guild_name: string;
  log_channel_id: string | null; dm_status: DeliveryStatus; log_status: DeliveryStatus;
  dm_message_id: string | null; log_message_id: string | null; created_at: Date;
  original_reason: string; state: 'active' | 'void'; revision: number; updated_at: Date;
  last_changed_by: string | null; void_reason: string | null;
  action_status: 'not_applicable' | 'pending' | 'applying' | 'applied' | 'rejected' | 'unconfirmed';
  duration_seconds: number | null; requested_until: Date | null; previous_until: Date | null;
  action_attempted_at: Date | null; action_completed_at: Date | null; action_error: string | null;
  notification_claimed_at: Date | null; delete_message_seconds: number | null;
};
export type WarningContext = {
  actorRoleIds: string[]; targetRoleIds: string[];
  targetIsBot: boolean; targetIsOwner: boolean; actorAboveTarget: boolean; guildName: string;
};
export type WarningDependencies = {
  readActorRoles: (actorId: string) => Promise<string[] | null>;
  readContext: (actorId: string, targetId: string) => Promise<WarningContext>;
  readLogChannels: () => Promise<LogChannel[]>;
  sendDM: (targetId: string, body: RESTPostAPIChannelMessageJSONBody) => Promise<{ id: string }>;
  sendLog: (channelId: string, body: RESTPostAPIChannelMessageJSONBody) => Promise<{ id: string }>;
};
type Database = Pick<Pool, 'connect' | 'query'>;
const isId = (id: string) => /^\d{17,20}$/.test(id);

export async function createWarning(pool: Database, input: {
  guildId: string; actorId: string; targetId: string; requestId: string; reason: string;
}, deps: Pick<WarningDependencies, 'readActorRoles' | 'readContext'>): Promise<{ record: WarningCase; created: boolean }> {
  if (![input.guildId, input.actorId, input.targetId, input.requestId].every(isId)) throw new WarningError('INVALID_ID');
  if (input.actorId === input.targetId) throw new WarningError('SELF_TARGET');
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new WarningError('INVALID_REASON');
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // Shared with staff grant and settings writes; case allocation is serialized per server.
    const guild = await client.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM guild_settings WHERE guild_id = $1 FOR UPDATE', [input.guildId]);
    if (!guild.rows[0]) throw new WarningError('SERVER_NOT_CONFIGURED');
    const actorRoles = await deps.readActorRoles(input.actorId);
    if (!actorRoles || await getStaffAccess(client, input.guildId, input.actorId, actorRoles) === 'none') {
      throw new WarningError('STAFF_REQUIRED');
    }
    const prior = await client.query<WarningCase>(
      'SELECT * FROM moderation_cases WHERE guild_id = $1 AND request_id = $2', [input.guildId, input.requestId]);
    if (prior.rows[0]) {
      if (prior.rows[0].action !== 'warning' || prior.rows[0].actor_id !== input.actorId || prior.rows[0].target_user_id !== input.targetId || prior.rows[0].original_reason !== reason) {
        throw new WarningError('REQUEST_MISMATCH');
      }
      await client.query('COMMIT'); transaction = false;
      return { record: prior.rows[0], created: false };
    }
    const context = await deps.readContext(input.actorId, input.targetId);
    const actorAccess = await getStaffAccess(client, input.guildId, input.actorId, context.actorRoleIds);
    if (actorAccess === 'none') throw new WarningError('STAFF_REQUIRED');
    if (context.targetIsBot) throw new WarningError('BOT_TARGET');
    if (context.targetIsOwner) throw new WarningError('OWNER_TARGET');
    if (!context.actorAboveTarget) throw new WarningError('ROLE_HIERARCHY');
    const targetAccess = await getStaffAccess(client, input.guildId, input.targetId, context.targetRoleIds);
    if (targetAccess === 'admin' || (targetAccess === 'moderator' && actorAccess !== 'admin')) {
      throw new WarningError('STAFF_TARGET');
    }
    const counter = await client.query<{ last_case_number: number }>(
      `INSERT INTO guild_case_counters (guild_id, last_case_number) VALUES ($1, 1)
       ON CONFLICT (guild_id) DO UPDATE SET last_case_number = guild_case_counters.last_case_number + 1
       RETURNING last_case_number`, [input.guildId]);
    const channelId = logChannelId(guild.rows[0].settings);
    const result = await client.query<WarningCase>(
      `INSERT INTO moderation_cases (guild_id, case_number, request_id, action, actor_id, target_user_id,
         reason, guild_name, log_channel_id, log_status, original_reason)
       VALUES ($1,$2,$3,'warning',$4,$5,$6,$7,$8,$9,$6) RETURNING *`,
      [input.guildId, counter.rows[0]!.last_case_number, input.requestId, input.actorId, input.targetId,
        reason, context.guildName.slice(0, 100), channelId, channelId ? 'pending' : 'not_configured']);
    const record = result.rows[0]!;
    await client.query(
      `INSERT INTO audit_events (guild_id, actor_id, event_type, details) VALUES ($1,$2,'WARNING_CREATED',$3::jsonb)`,
      [input.guildId, input.actorId, JSON.stringify({ case_number: record.case_number,
        target_user_id: input.targetId, reason, request_id: input.requestId, channel_id: channelId })]);
    await client.query('COMMIT'); transaction = false;
    return { record, created: true };
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { /* Keep original failure. */ } }
    throw error;
  } finally { client.release(); }
}

export async function getWarningCase(pool: Pick<Pool, 'query'>, input: {
  guildId: string; actorId: string; caseNumber: number;
}, readActorRoles: WarningDependencies['readActorRoles']): Promise<WarningCase | undefined> {
  if (![input.guildId, input.actorId].every(isId) || !Number.isInteger(input.caseNumber) ||
      input.caseNumber < 1 || input.caseNumber > 2147483647) throw new WarningError('INVALID_CASE');
  const roles = await readActorRoles(input.actorId);
  if (!roles || await getStaffAccess(pool, input.guildId, input.actorId, roles) === 'none') {
    throw new WarningError('STAFF_REQUIRED');
  }
  const result = await pool.query<WarningCase>(
    'SELECT * FROM moderation_cases WHERE guild_id = $1 AND case_number = $2', [input.guildId, input.caseNumber]);
  return result.rows[0];
}

export function warningMessage(record: WarningCase, kind: 'dm' | 'log'): RESTPostAPIChannelMessageJSONBody {
  const reason = escapeMarkdown(record.reason);
  return {
    allowed_mentions: { parse: [] }, enforce_nonce: true,
    nonce: digest(`warning:${kind}:${record.guild_id}:${record.case_number}`).slice(0, 25),
    embeds: [{ color: 0xe6ad73, title: kind === 'dm' ? 'You received a server warning' : `Warning · Case #${record.case_number}`,
      description: kind === 'dm' ? `You received a warning in **${escapeMarkdown(record.guild_name)}**.` : 'A staff member recorded a warning.',
      fields: kind === 'dm' ? [{ name: 'Case', value: String(record.case_number) }, { name: 'Reason', value: reason }]
        : [{ name: 'Member ID', value: record.target_user_id }, { name: 'Staff ID', value: record.actor_id }, { name: 'Reason', value: reason }],
      footer: { text: kind === 'dm' ? 'Contact the server staff if you have questions.' : 'Maru · Moderation log' },
      timestamp: new Date(record.created_at).toISOString() }],
  };
}

// Claim final notifications once; ban DMs were already attempted before the action.
// A restart or duplicate interaction never silently repeats a DM/log.
export async function deliverWarning(pool: Database, record: WarningCase, deps: WarningDependencies,
  messageBuilder: typeof warningMessage = warningMessage): Promise<WarningCase> {
  const claim = await pool.query<WarningCase>(
    `UPDATE moderation_cases SET notification_claimed_at=NOW(), dm_status = CASE WHEN dm_status='pending' THEN 'sending' ELSE dm_status END,
       log_status = CASE WHEN log_status = 'pending' THEN 'sending' ELSE log_status END
     WHERE guild_id = $1 AND case_number = $2 AND (dm_status IN ('pending','skipped') OR (action='ban' AND dm_status IN ('sent','failed','unconfirmed'))) AND notification_claimed_at IS NULL AND state='active'
       AND (action='warning' OR action_status IN ('applied','rejected','unconfirmed')) RETURNING *`,
    [record.guild_id, record.case_number]);
  if (!claim.rows[0]) {
    const current = await pool.query<WarningCase>(
      'SELECT * FROM moderation_cases WHERE guild_id = $1 AND case_number = $2', [record.guild_id, record.case_number]);
    if (!current.rows[0]) throw new WarningError('CASE_NOT_FOUND');
    return current.rows[0];
  }
  record = claim.rows[0];
  async function deliver(kind: 'dm' | 'log'): Promise<void> {
    if ((kind === 'log' && !record.log_channel_id) || (kind === 'dm' && (record.dm_status === 'skipped' || record.action === 'ban' || record.action === 'unban'))) return;
    let status: 'sent' | 'failed' | 'unconfirmed' = 'unconfirmed';
    let messageId: string | null = null;
    try {
      if (kind === 'log') {
        const channels = await deps.readLogChannels();
        if (!channels.some((channel) => channel.id === record.log_channel_id && channel.usable)) {
          status = 'failed';
        } else {
          const sent = await deps.sendLog(record.log_channel_id!, messageBuilder(record, kind));
          if (!isId(sent.id)) throw new Error('INVALID_DELIVERY_RESPONSE');
          messageId = sent.id; status = 'sent';
        }
      } else {
        const sent = await deps.sendDM(record.target_user_id, messageBuilder(record, kind));
        if (!isId(sent.id)) throw new Error('INVALID_DELIVERY_RESPONSE');
        messageId = sent.id; status = 'sent';
      }
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && [400, 401, 403, 404].includes(Number(error.status))) {
        status = 'failed';
      }
    }
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query('BEGIN'); transaction = true;
      // Identifiers are selected exclusively from the fixed delivery kind.
      const statusColumn = kind === 'dm' ? 'dm_status' : 'log_status';
      const messageColumn = kind === 'dm' ? 'dm_message_id' : 'log_message_id';
      await client.query(
        `UPDATE moderation_cases SET ${statusColumn} = $3, ${messageColumn} = $4 WHERE guild_id = $1 AND case_number = $2`,
        [record.guild_id, record.case_number, status, messageId]);
      await client.query(
        `INSERT INTO audit_events (guild_id, actor_id, event_type, details) VALUES ($1,$2,$3,$4::jsonb)`,
        [record.guild_id, record.actor_id, `${record.action === 'warning' ? 'WARNING' : record.action.toUpperCase()}_${kind.toUpperCase()}_${status.toUpperCase()}`,
          JSON.stringify({ case_number: record.case_number, target_user_id: record.target_user_id,
            channel_id: kind === 'log' ? record.log_channel_id : undefined, message_id: messageId,
            reason: status === 'sent' ? 'Discord confirmed message creation.' : status === 'failed'
              ? 'Delivery failed. Check privacy settings or channel permissions.'
              : 'Delivery was not confirmed. Check before attempting another notification.' })]);
      await client.query('COMMIT'); transaction = false;
    } catch {
      if (transaction) { try { await client.query('ROLLBACK'); } catch { /* Status remains uncertain. */ } }
      console.error('Warning delivery result could not be recorded. Review the saved case before retrying.');
    } finally { client.release(); }
  }
  // Separate attempts: a closed DM must never prevent the staff log from being sent.
  // Independent attempts: an outcome-recording failure must not skip the other delivery.
  for (const kind of ['dm', 'log'] as const) {
    try { await deliver(kind); }
    catch { console.error('Warning delivery outcome is unavailable. Review the saved case before retrying.'); }
  }
  const result = await pool.query<WarningCase>(
    'SELECT * FROM moderation_cases WHERE guild_id = $1 AND case_number = $2', [record.guild_id, record.case_number]);
  return result.rows[0]!;
}
