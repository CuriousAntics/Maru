import type { Pool } from 'pg';

export type StaffAccess = 'admin' | 'moderator' | 'none';

type Mapping = { access_level: string; full_access: boolean };

export function resolveStaffAccess(mappings: readonly Mapping[]): StaffAccess {
  if (mappings.some((mapping) => mapping.access_level === 'admin')) return 'admin';
  const moderators = mappings.filter((mapping) => mapping.access_level === 'moderator');
  if (moderators.some((mapping) => mapping.full_access === true)) return 'admin';
  return moderators.length ? 'moderator' : 'none';
}

export async function getStaffAccess(
  pool: Pool, guildId: string, userId: string, roleIds: readonly string[]
): Promise<StaffAccess> {
  // Role membership comes from the current Discord interaction, never command input.
  // One statement reads mappings and grants from a consistent database snapshot.
  const result = await pool.query<Mapping>(
    `SELECT sr.access_level,
       EXISTS (
         SELECT 1 FROM staff_access_grants AS grant_row
         WHERE grant_row.guild_id = sr.guild_id AND grant_row.user_id = $3
       ) AS full_access
     FROM staff_roles AS sr
     WHERE sr.guild_id = $1 AND sr.role_id = ANY($2::text[])`,
    [guildId, [...roleIds], userId]
  );
  return resolveStaffAccess(result.rows);
}
