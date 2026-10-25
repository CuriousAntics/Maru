import type { Pool } from 'pg';
import { getStaffAccess } from './staff-access.js';

export class StaffGrantError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export type StaffGrantInput = {
  guildId: string;
  actorId: string;
  actorRoleIds: readonly string[];
  targetId: string;
  targetRoleIds: readonly string[];
  targetIsBot: boolean;
  action: 'grant' | 'revoke';
  reason: string;
};

export async function changeStaffGrant(
  pool: Pick<Pool, 'connect'>, input: StaffGrantInput
): Promise<'changed' | 'unchanged'> {
  if (!['grant', 'revoke'].includes(input.action)) throw new StaffGrantError('INVALID_ACTION');
  if (![input.guildId, input.actorId, input.targetId].every((id) => /^\d{17,20}$/.test(id))) {
    throw new StaffGrantError('INVALID_USER_ID');
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new StaffGrantError('INVALID_REASON');

  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // All grant mutations take this per-server lock before checking authorization.
    const guild = await client.query(
      'SELECT guild_id FROM guild_settings WHERE guild_id = $1 FOR UPDATE', [input.guildId]
    );
    if (!guild.rowCount) throw new StaffGrantError('SERVER_NOT_CONFIGURED');
    if (await getStaffAccess(client, input.guildId, input.actorId, input.actorRoleIds) !== 'admin') {
      throw new StaffGrantError('ADMIN_REQUIRED');
    }

    let changed = false;
    if (input.action === 'grant') {
      if (input.targetIsBot) throw new StaffGrantError('BOT_TARGET_NOT_ALLOWED');
      const moderator = await client.query(
        `SELECT role_id FROM staff_roles
         WHERE guild_id = $1 AND access_level = 'moderator' AND role_id = ANY($2::text[])`,
        [input.guildId, [...input.targetRoleIds]]
      );
      if (!moderator.rowCount) throw new StaffGrantError('TARGET_MOD_ROLE_REQUIRED');
      const result = await client.query(
        `INSERT INTO staff_access_grants (guild_id, user_id, granted_by)
         VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO NOTHING RETURNING user_id`,
        [input.guildId, input.targetId, input.actorId]
      );
      changed = result.rowCount === 1;
    } else {
      // Revocation also works after the target leaves the server or loses its role.
      const result = await client.query(
        'DELETE FROM staff_access_grants WHERE guild_id = $1 AND user_id = $2 RETURNING user_id',
        [input.guildId, input.targetId]
      );
      changed = result.rowCount === 1;
    }

    if (changed) {
      await client.query(
        `INSERT INTO audit_events (guild_id, actor_id, event_type, details)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [input.guildId, input.actorId,
          input.action === 'grant' ? 'STAFF_ACCESS_GRANTED' : 'STAFF_ACCESS_REVOKED',
          JSON.stringify({ target_user_id: input.targetId, reason })]
      );
    }
    await client.query('COMMIT');
    transaction = false;
    return changed ? 'changed' : 'unchanged';
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); } catch { /* Retain the original error. */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
