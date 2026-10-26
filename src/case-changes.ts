import type { Pool } from 'pg';
import type { WarningCase } from './warnings.js';
import { getStaffAccess } from './staff-access.js';
import { digest } from './web-security.js';

export class CaseChangeError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export async function changeCase(pool: Pick<Pool, 'connect'>, input: {
  guildId: string; actorId: string; sessionToken: string; caseNumber: number;
  expectedRevision: number; action: 'correct' | 'void'; reason: string; newReason?: string;
  readMemberRoles: (userId: string) => Promise<string[] | null>;
}): Promise<WarningCase> {
  if (![input.guildId, input.actorId].every((id) => /^\d{17,20}$/.test(id)) ||
      !Number.isInteger(input.caseNumber) || input.caseNumber < 1 || input.caseNumber > 2147483647 ||
      !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision > 2147483647 ||
      !['correct', 'void'].includes(input.action)) throw new CaseChangeError('INVALID_INPUT');
  const reason = input.reason.trim();
  const newReason = input.newReason?.trim();
  if (!reason || reason.length > 500 || (input.action === 'correct' && (!newReason || newReason.length > 500))) {
    throw new CaseChangeError('INVALID_REASON');
  }
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const guild = await client.query('SELECT guild_id FROM guild_settings WHERE guild_id = $1 FOR UPDATE', [input.guildId]);
    if (!guild.rowCount) throw new CaseChangeError('CASE_NOT_FOUND');
    const session = await client.query(
      `SELECT user_id FROM dashboard_sessions WHERE token_hash = $1 AND guild_id = $2
       AND user_id = $3 AND expires_at > NOW()`, [digest(input.sessionToken), input.guildId, input.actorId]);
    if (!session.rowCount) throw new CaseChangeError('SESSION_EXPIRED');
    const roles = await input.readMemberRoles(input.actorId);
    const access = roles ? await getStaffAccess(client, input.guildId, input.actorId, roles) : 'none';
    if (access === 'none') throw new CaseChangeError('ACCESS_DENIED');
    const result = await client.query<WarningCase>(
      'SELECT * FROM moderation_cases WHERE guild_id = $1 AND case_number = $2 FOR UPDATE', [input.guildId, input.caseNumber]);
    const previous = result.rows[0];
    if (!previous) throw new CaseChangeError('CASE_NOT_FOUND');
    if (access !== 'admin' && previous.actor_id !== input.actorId) throw new CaseChangeError('ACCESS_DENIED');
    if (previous.revision !== input.expectedRevision) throw new CaseChangeError('STALE_CASE');
    if (previous.state === 'void') throw new CaseChangeError('CASE_VOIDED');
    if (input.action === 'correct' && previous.reason === newReason) {
      await client.query('COMMIT'); transaction = false;
      return previous;
    }
    const updated = await client.query<WarningCase>(
      `UPDATE moderation_cases SET reason = $3, state = $4, void_reason = $5,
       revision = revision + 1, updated_at = NOW(), last_changed_by = $6
       WHERE guild_id = $1 AND case_number = $2 RETURNING *`,
      [input.guildId, input.caseNumber, input.action === 'correct' ? newReason : previous.reason,
        input.action === 'void' ? 'void' : 'active', input.action === 'void' ? reason : null, input.actorId]);
    const record = updated.rows[0]!;
    await client.query(
      `INSERT INTO audit_events (guild_id, actor_id, event_type, details) VALUES ($1,$2,$3,$4::jsonb)`,
      [input.guildId, input.actorId, input.action === 'correct' ? 'CASE_REASON_CORRECTED' : 'CASE_VOIDED',
        JSON.stringify({ case_number: input.caseNumber, target_user_id: previous.target_user_id,
          before_reason: previous.reason, after_reason: record.reason, previous_state: previous.state,
          new_state: record.state, before_revision: previous.revision, revision: record.revision, reason })]);
    await client.query('COMMIT'); transaction = false;
    return record;
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { /* Keep original failure. */ } }
    throw error;
  } finally { client.release(); }
}
