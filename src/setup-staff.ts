import { REST, Routes } from 'discord.js';
import type { RESTGetAPIGuildRolesResult } from 'discord.js';
import pg from 'pg';
import { required, snowflake } from './config.js';

let stage = 'configuration';

async function setup(): Promise<void> {
  const [adminRoleId, moderatorRoleId, ...extra] = process.argv.slice(2);
  if (!adminRoleId || !moderatorRoleId || extra.length ||
      !/^\d{17,20}$/.test(adminRoleId) || !/^\d{17,20}$/.test(moderatorRoleId)) {
    throw new Error('EXPECTED_ADMIN_AND_MODERATOR_ROLE_IDS');
  }
  if (adminRoleId === moderatorRoleId) throw new Error('ROLES_MUST_BE_DIFFERENT');

  const guildId = snowflake('DISCORD_TEST_GUILD_ID');
  if (adminRoleId === guildId || moderatorRoleId === guildId) {
    throw new Error('EVERYONE_ROLE_NOT_ALLOWED');
  }
  const connectionString = required('DATABASE_URL');
  const rest = new REST({ version: '10' }).setToken(required('DISCORD_TOKEN'));

  stage = 'Discord role validation';
  const roles = await rest.get(Routes.guildRoles(guildId)) as RESTGetAPIGuildRolesResult;
  for (const id of [adminRoleId, moderatorRoleId]) {
    const role = roles.find((candidate) => candidate.id === id);
    if (!role) throw new Error('ROLE_NOT_IN_CONFIGURED_TEST_SERVER');
    if (role.managed) throw new Error('MANAGED_ROLE_NOT_ALLOWED');
  }

  stage = 'PostgreSQL connection';
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
  let transaction = false;
  try {
    await client.connect();
    stage = 'saving staff mappings';
    await client.query('BEGIN');
    transaction = true;
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query(
      'INSERT INTO guild_settings (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING',
      [guildId]
    );

    // Serialize setup commands for this server without changing its settings.
    await client.query('SELECT guild_id FROM guild_settings WHERE guild_id = $1 FOR UPDATE', [guildId]);
    let added = 0;
    const mappings = [
      { roleId: adminRoleId, access: 'admin' },
      { roleId: moderatorRoleId, access: 'moderator' },
    ];

    for (const mapping of mappings) {
      const inserted = await client.query(
        `INSERT INTO staff_roles (guild_id, role_id, access_level)
         VALUES ($1, $2, $3) ON CONFLICT (guild_id, role_id) DO NOTHING
         RETURNING role_id`,
        [guildId, mapping.roleId, mapping.access]
      );
      const existing = await client.query<{ access_level: string }>(
        'SELECT access_level FROM staff_roles WHERE guild_id = $1 AND role_id = $2 FOR UPDATE',
        [guildId, mapping.roleId]
      );
      if (existing.rows[0]?.access_level !== mapping.access) {
        throw new Error('EXISTING_ACCESS_MAPPING_CONFLICT');
      }
      if (inserted.rowCount === 1) {
        added++;
        await client.query(
          `INSERT INTO audit_events (guild_id, actor_id, event_type, details)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [guildId, 'system:bootstrap', 'STAFF_ROLE_BOOTSTRAPPED', JSON.stringify({
            source: 'operator_cli', role_id: mapping.roleId, access_level: mapping.access,
          })]
        );
      }
    }

    await client.query('COMMIT');
    transaction = false;
    console.log(added ? `Saved ${added} new staff role mapping(s).` : 'Staff mappings already match; no changes made.');
    console.log('Configured test server: Admin -> admin; Mods -> moderator.');
    console.log('Role mappings are stored. Command enforcement will be added next.');
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); } catch { /* Preserve the original error. */ }
    }
    throw error;
  } finally {
    await client.end();
  }
}

setup().catch((error: unknown) => {
  const raw = error && typeof error === 'object' && 'code' in error
    ? String(error.code) : error instanceof Error ? error.message : 'UNKNOWN';
  const code = /^[A-Z0-9_]+$/.test(raw) ? raw : 'NO_SAFE_ERROR_CODE';
  console.error(`Staff setup failed at ${stage}; code=${code}`);
  process.exitCode = 1;
});
