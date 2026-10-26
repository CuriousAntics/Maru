import type { Pool } from 'pg';
import { escapeMarkdown } from 'discord.js';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { getStaffAccess } from './staff-access.js';
import { logChannelId } from './server-settings.js';
import { digest } from './web-security.js';
import { actionLabel, actionResultLabel, durationLabel } from './case-labels.js';
import type { WarningCase, WarningContext, WarningDependencies } from './warnings.js';

export class TimeoutError extends Error {
  constructor(public readonly code: string, public readonly caseNumber?: number) { super(code); }
}
export type TimeoutContext = WarningContext & {
  actorCanModerate: boolean; botCanModerate: boolean; botAboveTarget: boolean;
  targetIsAdministrator: boolean; previousUntil: string | null;
};
export type TimeoutDependencies = WarningDependencies & {
  readTimeoutContext: (actorId: string, targetId: string) => Promise<TimeoutContext>;
  applyTimeout: (targetId: string, until: string | null, caseNumber: number, action: 'timeout' | 'untimeout') =>
    Promise<{ targetId: string; until: string | null }>;
};
const validId = (id: string) => /^\d{17,20}$/.test(id);

export async function runTimeout(pool: Pick<Pool, 'connect'>, input: {
  guildId: string; actorId: string; targetId: string; requestId: string;
  action: 'timeout' | 'untimeout'; durationSeconds?: number; reason: string;
}, deps: TimeoutDependencies): Promise<{ record: WarningCase; created: boolean }> {
  if (![input.guildId, input.actorId, input.targetId, input.requestId].every(validId) ||
      !['timeout', 'untimeout'].includes(input.action)) throw new TimeoutError('INVALID_INPUT');
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new TimeoutError('INVALID_REASON');
  if (input.actorId === input.targetId) throw new TimeoutError('SELF_TARGET');
  if (input.action === 'timeout' && (!Number.isInteger(input.durationSeconds) || input.durationSeconds! < 1 || input.durationSeconds! > 2419200)) {
    throw new TimeoutError('INVALID_DURATION');
  }
  const client = await pool.connect();
  let locked = false;
  let transaction = false;
  let saved: WarningCase | undefined;
  let committed = false;
  let discard = false;
  try {
    // Session lock spans the external call, serializing Maru actions for this member across instances.
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked', [input.guildId, input.targetId]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw new TimeoutError('MEMBER_BUSY');
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const guild = await client.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM guild_settings WHERE guild_id = $1 FOR UPDATE', [input.guildId]);
    if (!guild.rows[0]) throw new TimeoutError('SERVER_NOT_CONFIGURED');
    const roles = await deps.readActorRoles(input.actorId);
    if (!roles || await getStaffAccess(client, input.guildId, input.actorId, roles) === 'none') throw new TimeoutError('STAFF_REQUIRED');
    const prior = await client.query<WarningCase>(
      'SELECT * FROM moderation_cases WHERE guild_id = $1 AND request_id = $2', [input.guildId, input.requestId]);
    if (prior.rows[0]) {
      const record = prior.rows[0];
      if (record.actor_id !== input.actorId || record.target_user_id !== input.targetId || record.action !== input.action ||
          record.original_reason !== reason || record.duration_seconds !== (input.action === 'timeout' ? input.durationSeconds : null)) {
        throw new TimeoutError('REQUEST_MISMATCH');
      }
      await client.query('COMMIT'); transaction = false;
      return { record, created: false };
    }
    const context = await deps.readTimeoutContext(input.actorId, input.targetId);
    const access = await getStaffAccess(client, input.guildId, input.actorId, context.actorRoleIds);
    if (access === 'none') throw new TimeoutError('STAFF_REQUIRED');
    if (context.targetIsBot) throw new TimeoutError('BOT_TARGET');
    if (context.targetIsOwner || context.targetIsAdministrator) throw new TimeoutError('PROTECTED_TARGET');
    if (!context.actorCanModerate) throw new TimeoutError('ACTOR_PERMISSION');
    if (!context.botCanModerate || !context.botAboveTarget) throw new TimeoutError('BOT_PERMISSION');
    if (!context.actorAboveTarget) throw new TimeoutError('ROLE_HIERARCHY');
    const targetAccess = await getStaffAccess(client, input.guildId, input.targetId, context.targetRoleIds);
    if (targetAccess === 'admin' || (targetAccess === 'moderator' && access !== 'admin')) throw new TimeoutError('STAFF_TARGET');
    const previousUntil = context.previousUntil ? new Date(context.previousUntil) : null;
    if (previousUntil && !Number.isFinite(previousUntil.getTime())) throw new TimeoutError('INVALID_RESPONSE');
    if (input.action === 'untimeout' && (!previousUntil || previousUntil.getTime() <= Date.now())) throw new TimeoutError('NO_TIMEOUT');
    const requestedUntil = input.action === 'timeout' ? new Date(Date.now() + input.durationSeconds! * 1000) : null;
    const counter = await client.query<{ last_case_number: number }>(
      `INSERT INTO guild_case_counters (guild_id,last_case_number) VALUES ($1,1)
       ON CONFLICT (guild_id) DO UPDATE SET last_case_number=guild_case_counters.last_case_number+1 RETURNING last_case_number`, [input.guildId]);
    const channelId = logChannelId(guild.rows[0].settings);
    const result = await client.query<WarningCase>(
      `INSERT INTO moderation_cases (guild_id,case_number,request_id,action,actor_id,target_user_id,reason,guild_name,
        log_channel_id,log_status,action_status,duration_seconds,requested_until,previous_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13) RETURNING *`,
      [input.guildId,counter.rows[0]!.last_case_number,input.requestId,input.action,input.actorId,input.targetId,reason,
        context.guildName.slice(0,100),channelId,channelId ? 'pending' : 'not_configured',
        input.action === 'timeout' ? input.durationSeconds : null,requestedUntil,previousUntil]);
    saved = result.rows[0]!;
    await client.query(
      `INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)`,
      [input.guildId,input.actorId,`${input.action.toUpperCase()}_REQUESTED`,JSON.stringify({ case_number: saved.case_number,
        target_user_id: input.targetId,reason,duration_seconds: saved.duration_seconds,requested_until: requestedUntil,
        previous_until: previousUntil,request_id: input.requestId })]);
    await client.query('COMMIT'); transaction = false;
    committed = true;
    // A failed/uncertain claim acknowledgement must never proceed to the Discord mutation.
    const claim = await client.query<WarningCase>(
      `UPDATE moderation_cases SET action_status='applying',action_attempted_at=NOW()
       WHERE guild_id=$1 AND case_number=$2 AND action_status='pending' RETURNING *`, [input.guildId,saved.case_number]);
    if (!claim.rows[0]) throw new TimeoutError('OUTCOME_UNAVAILABLE', saved.case_number);
    saved = claim.rows[0];
    let status: 'applied' | 'rejected' | 'unconfirmed' = 'unconfirmed';
    let errorCode: string | null = null;
    try {
      const until = saved.requested_until ? new Date(saved.requested_until).toISOString() : null;
      if (until && Date.parse(until) <= Date.now()) {
        status = 'rejected'; errorCode = 'DURATION_EXPIRED_BEFORE_SEND';
      } else {
        const response = await deps.applyTimeout(input.targetId,until,saved.case_number,input.action);
        if (response.targetId === input.targetId && (until === null ? response.until === null
          : response.until !== null && Math.abs(Date.parse(response.until)-Date.parse(until)) <= 1)) status = 'applied';
        else errorCode = 'UNEXPECTED_RESPONSE';
      }
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'status' in error && [400,401,403,404].includes(Number(error.status))) {
        status = 'rejected'; errorCode = `HTTP_${Number(error.status)}`;
      } else errorCode = 'RESPONSE_UNAVAILABLE';
    }
    await client.query('BEGIN'); transaction = true;
    const outcome = await client.query<WarningCase>(
      `UPDATE moderation_cases SET action_status=$3,action_completed_at=NOW(),action_error=$4,
       dm_status=CASE WHEN $3='applied' THEN dm_status ELSE 'skipped' END
       WHERE guild_id=$1 AND case_number=$2 RETURNING *`, [input.guildId,saved.case_number,status,errorCode]);
    await client.query(
      `INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)`,
      [input.guildId,input.actorId,`${input.action.toUpperCase()}_${status.toUpperCase()}`,JSON.stringify({
        case_number: saved.case_number,target_user_id: input.targetId,requested_until: saved.requested_until,
        previous_until: saved.previous_until,error_code: errorCode,reason: `Recorded Discord action result: ${status}.` })]);
    await client.query('COMMIT'); transaction = false;
    return { record: outcome.rows[0]!, created: true };
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
    if (saved && committed) throw new TimeoutError('OUTCOME_UNAVAILABLE',saved.case_number);
    throw error;
  } finally {
    if (locked) { try { await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', [input.guildId,input.targetId]); }
      catch { discard = true; } }
    client.release(discard ? new Error('Timeout connection could not release its lock safely.') : undefined);
  }
}

export function timeoutNotification(record: WarningCase, kind: 'dm' | 'log'): RESTPostAPIChannelMessageJSONBody {
  const label = actionLabel(record.action);
  const fields = [{ name: 'Case', value: String(record.case_number) },
    { name: 'Action result', value: actionResultLabel(record.action_status) },
    { name: 'Reason', value: escapeMarkdown(record.reason) }];
  if (record.requested_until) fields.push({ name: 'Requested end (UTC)', value: new Date(record.requested_until).toISOString() });
  if (record.duration_seconds) fields.push({ name: 'Requested duration', value: durationLabel(record.duration_seconds) });
  if (kind === 'log') fields.push({ name: 'Member ID', value: record.target_user_id }, { name: 'Staff ID', value: record.actor_id });
  return { allowed_mentions: { parse: [] }, enforce_nonce: true,
    nonce: digest(`${record.action}:${kind}:${record.guild_id}:${record.case_number}`).slice(0,25),
    embeds: [{ title: `${label} · Case #${record.case_number}`,color: 0xe6ad73,
      description: kind === 'dm' ? `A staff member ${record.action === 'timeout' ? 'applied a timeout' : 'removed your timeout'} in **${escapeMarkdown(record.guild_name)}**.`
        : 'Recorded moderation action result. This is not a live timeout-status check.',
      fields,timestamp: new Date(record.created_at).toISOString() }] };
}
