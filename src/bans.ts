import type { Pool } from 'pg';
import { escapeMarkdown } from 'discord.js';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { getStaffAccess } from './staff-access.js';
import { logChannelId } from './server-settings.js';
import { digest } from './web-security.js';
import { actionLabel, actionResultLabel, durationLabel } from './case-labels.js';
import type { WarningCase, WarningContext, WarningDependencies } from './warnings.js';

export class BanError extends Error {
  constructor(public readonly code: string, public readonly caseNumber?: number) { super(code); }
}
export type BanContext = WarningContext & {
  actorCanBan: boolean; botCanBan: boolean; botAboveTarget: boolean;
  targetIsMember: boolean; targetIsAdministrator: boolean; isBanned: boolean;
};
export type BanDependencies = WarningDependencies & {
  readBanContext: (actorId: string, targetId: string, action: 'ban' | 'unban') => Promise<BanContext>;
  applyBan: (targetId: string, deleteSeconds: number | null, caseNumber: number, action: 'ban' | 'unban') => Promise<void>;
};
const validId = (id: string) => /^\d{17,20}$/.test(id);

// Explicit units; 0 preserves history. Discord accepts at most seven days.
export function parseDeleteHistory(text: string | null): number {
  if (text === null) return 86400;
  if (text.trim() === '0') return 0;
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(text.trim());
  const scale = { s: 1,m: 60,h: 3600,d: 86400 };
  const seconds = match ? Number(match[1]) * scale[match[2]!.toLowerCase() as keyof typeof scale] : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 604800) throw new BanError('INVALID_HISTORY');
  return seconds;
}

export async function runBan(pool: Pick<Pool,'connect'>, input: {
  guildId: string; actorId: string; targetId: string; requestId: string;
  action: 'ban' | 'unban'; deleteSeconds?: number; reason: string;
}, deps: BanDependencies): Promise<{ record: WarningCase; created: boolean }> {
  if (![input.guildId,input.actorId,input.targetId,input.requestId].every(validId) || !['ban','unban'].includes(input.action)) throw new BanError('INVALID_INPUT');
  if (input.actorId === input.targetId) throw new BanError('SELF_TARGET');
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new BanError('INVALID_REASON');
  const deleteSeconds = input.action === 'ban' ? input.deleteSeconds ?? 86400 : null;
  if (deleteSeconds !== null && (!Number.isSafeInteger(deleteSeconds) || deleteSeconds < 0 || deleteSeconds > 604800)) throw new BanError('INVALID_HISTORY');
  const client = await pool.connect();
  let locked = false, transaction = false, committed = false, discard = false;
  let saved: WarningCase | undefined;
  async function audit(event: string, details: Record<string,unknown>) {
    await client.query('INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)',
      [input.guildId,input.actorId,event,JSON.stringify({ case_number: saved!.case_number,target_user_id: input.targetId,...details })]);
  }
  async function begin() {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='15s'");
  }
  async function commit() { await client.query('COMMIT'); transaction = false; }
  async function validate(): Promise<BanContext> {
    const context = await deps.readBanContext(input.actorId,input.targetId,input.action);
    const access = await getStaffAccess(client,input.guildId,input.actorId,context.actorRoleIds);
    if (access === 'none') throw new BanError('STAFF_REQUIRED');
    if (!context.actorCanBan) throw new BanError('ACTOR_PERMISSION');
    if (!context.botCanBan) throw new BanError('BOT_PERMISSION');
    if (input.action === 'unban') {
      if (!context.isBanned) throw new BanError('NOT_BANNED');
    } else {
      if (context.isBanned) throw new BanError('ALREADY_BANNED');
      if (!context.targetIsMember) throw new BanError('TARGET_NOT_MEMBER');
      if (context.targetIsBot) throw new BanError('BOT_TARGET');
      if (context.targetIsOwner || context.targetIsAdministrator) throw new BanError('PROTECTED_TARGET');
      if (!context.botAboveTarget) throw new BanError('BOT_PERMISSION');
      if (!context.actorAboveTarget) throw new BanError('ROLE_HIERARCHY');
      const targetAccess = await getStaffAccess(client,input.guildId,input.targetId,context.targetRoleIds);
      if (targetAccess === 'admin' || (targetAccess === 'moderator' && access !== 'admin')) throw new BanError('STAFF_TARGET');
    }
    return context;
  }
  try {
    // Same lock keys as timeouts: native actions for a member cannot overlap in Maru.
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',[input.guildId,input.targetId]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw new BanError('MEMBER_BUSY');
    await begin();
    const guild = await client.query<{ settings: Record<string,unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[input.guildId]);
    if (!guild.rows[0]) throw new BanError('SERVER_NOT_CONFIGURED');
    const roles = await deps.readActorRoles(input.actorId);
    if (!roles || await getStaffAccess(client,input.guildId,input.actorId,roles) === 'none') throw new BanError('STAFF_REQUIRED');
    const prior = (await client.query<WarningCase>('SELECT * FROM moderation_cases WHERE guild_id=$1 AND request_id=$2',[input.guildId,input.requestId])).rows[0];
    if (prior) {
      if (prior.actor_id !== input.actorId || prior.target_user_id !== input.targetId || prior.action !== input.action ||
          prior.original_reason !== reason || prior.delete_message_seconds !== deleteSeconds) throw new BanError('REQUEST_MISMATCH');
      await commit(); return { record: prior,created: false };
    }
    const context = await validate();
    const counter = await client.query<{ last_case_number: number }>(
      `INSERT INTO guild_case_counters (guild_id,last_case_number) VALUES ($1,1)
       ON CONFLICT (guild_id) DO UPDATE SET last_case_number=guild_case_counters.last_case_number+1 RETURNING last_case_number`,[input.guildId]);
    const channelId = logChannelId(guild.rows[0].settings);
    saved = (await client.query<WarningCase>(
      `INSERT INTO moderation_cases (guild_id,case_number,request_id,action,actor_id,target_user_id,reason,guild_name,
       log_channel_id,log_status,action_status,delete_message_seconds,dm_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12) RETURNING *`,
      [input.guildId,counter.rows[0]!.last_case_number,input.requestId,input.action,input.actorId,input.targetId,reason,
        context.guildName.slice(0,100),channelId,channelId ? 'pending' : 'not_configured',deleteSeconds,input.action === 'ban' ? 'pending' : 'skipped'])).rows[0]!;
    await audit(`${input.action.toUpperCase()}_REQUESTED`,{ reason,delete_message_seconds: deleteSeconds,request_id: input.requestId });
    await commit(); committed = true;

    if (input.action === 'ban') {
      const claim = await client.query<WarningCase>(
        `UPDATE moderation_cases SET dm_status='sending' WHERE guild_id=$1 AND case_number=$2 AND dm_status='pending' RETURNING *`,
        [input.guildId,saved.case_number]);
      if (!claim.rows[0]) throw new BanError('OUTCOME_UNAVAILABLE',saved.case_number);
      saved = claim.rows[0];
      let dmStatus: 'sent' | 'failed' | 'unconfirmed' = 'unconfirmed';
      let messageId: string | null = null;
      try {
        const result = await deps.sendDM(input.targetId,banNotification(saved,'dm'));
        if (validId(result.id)) { dmStatus = 'sent'; messageId = result.id; }
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'status' in error && [400,401,403,404].includes(Number(error.status))) dmStatus = 'failed';
      }
      await begin();
      saved = (await client.query<WarningCase>(
        'UPDATE moderation_cases SET dm_status=$3,dm_message_id=$4 WHERE guild_id=$1 AND case_number=$2 RETURNING *',
        [input.guildId,saved.case_number,dmStatus,messageId])).rows[0]!;
      await audit(`BAN_DM_${dmStatus.toUpperCase()}`,{ message_id: messageId,reason: 'Pre-ban notice result; this does not confirm a ban.' });
      await commit();
    }

    let status: 'applied' | 'rejected' | 'unconfirmed' = 'unconfirmed';
    let errorCode: string | null = null;
    // Recheck permissions, membership, ban state and grants after the potentially slow DM.
    await begin();
    await client.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[input.guildId]);
    try { await validate(); }
    catch (error) { status = 'rejected'; errorCode = error instanceof BanError ? error.code : 'AUTHORIZATION_UNAVAILABLE'; }
    if (status !== 'rejected') {
      const claim = await client.query<WarningCase>(
        `UPDATE moderation_cases SET action_status='applying',action_attempted_at=NOW()
         WHERE guild_id=$1 AND case_number=$2 AND action_status='pending' RETURNING *`,[input.guildId,saved.case_number]);
      if (!claim.rows[0]) throw new BanError('OUTCOME_UNAVAILABLE',saved.case_number);
      saved = claim.rows[0];
    }
    await commit();
    if (status !== 'rejected') {
      try {
        await deps.applyBan(input.targetId,deleteSeconds,saved.case_number,input.action); status = 'applied';
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'status' in error && [400,401,403,404].includes(Number(error.status))) {
          status = 'rejected'; errorCode = `HTTP_${Number(error.status)}`;
        } else errorCode = 'RESPONSE_UNAVAILABLE';
      }
    }
    await begin();
    saved = (await client.query<WarningCase>(
      'UPDATE moderation_cases SET action_status=$3,action_completed_at=NOW(),action_error=$4 WHERE guild_id=$1 AND case_number=$2 RETURNING *',
      [input.guildId,saved.case_number,status,errorCode])).rows[0]!;
    await audit(`${input.action.toUpperCase()}_${status.toUpperCase()}`,{ error_code: errorCode,delete_message_seconds: deleteSeconds,
      reason: `Recorded Discord action result: ${status}.` });
    await commit();
    return { record: saved,created: true };
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
    if (saved && committed) throw new BanError('OUTCOME_UNAVAILABLE',saved.case_number);
    throw error;
  } finally {
    if (locked) { try { await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',[input.guildId,input.targetId]); } catch { discard = true; } }
    client.release(discard ? new Error('Ban connection could not release its lock safely.') : undefined);
  }
}

export function banNotification(record: WarningCase, kind: 'dm' | 'log'): RESTPostAPIChannelMessageJSONBody {
  const fields = [{ name: 'Case',value: String(record.case_number) },{ name: 'Reason',value: escapeMarkdown(record.reason) }];
  if (record.action === 'ban') fields.push({ name: 'Requested message deletion',value: record.delete_message_seconds === 0 ? 'Keep message history' : durationLabel(record.delete_message_seconds!) });
  if (kind === 'log') fields.push({ name: 'Action result',value: actionResultLabel(record.action_status) },
    { name: 'User ID',value: record.target_user_id },{ name: 'Staff ID',value: record.actor_id },
    { name: 'Pre-ban DM',value: record.action === 'unban' ? 'Not sent for unbans' : record.dm_status });
  return { allowed_mentions: { parse: [] },enforce_nonce: true,
    nonce: digest(`${record.action}:${kind}:${record.guild_id}:${record.case_number}`).slice(0,25),
    embeds: [{ title: kind === 'dm' ? 'Server ban notice' : `${actionLabel(record.action)} · Case #${record.case_number}`,color: 0xe6ad73,
      description: kind === 'dm' ? `Staff requested a ban from **${escapeMarkdown(record.guild_name)}**. This notice is sent before the attempt and does not confirm its outcome.`
        : 'Recorded action result, not a live ban-status check. Unbanning does not restore deleted messages or automatically rejoin the member.',
      fields,timestamp: new Date(record.created_at).toISOString() }] };
}
