import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { changeStaffGrant, StaffGrantError } from '../src/staff-grants.js';
import type { StaffGrantInput } from '../src/staff-grants.js';
import { getStaffAccess } from '../src/staff-access.js';

// Run SQL against an isolated PostgreSQL WASM engine, not Railway.
const db = new PGlite();
const guild = '100000000000000001';
const otherGuild = '100000000000000002';
const adminRole = '200000000000000001';
const modRole = '200000000000000002';
const admin = '300000000000000001';
const target = '300000000000000002';
const nextTarget = '300000000000000003';

async function query(sql: string, values?: unknown[]) {
  const result = await db.query(sql, values);
  return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
}
const client = { query, release() {} };
const pool = { query, async connect() { return client; } } as unknown as Pool;

function input(overrides: Partial<StaffGrantInput> = {}): StaffGrantInput {
  return {
    guildId: guild, actorId: admin, actorRoleIds: [adminRole],
    targetId: target, targetRoleIds: [modRole], targetIsBot: false,
    action: 'grant', reason: 'Approved test access', ...overrides,
  };
}
async function count(table: 'staff_access_grants' | 'audit_events'): Promise<number> {
  const result = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
  return result.rows[0]!.count;
}
async function expectCode(value: StaffGrantInput, code: string) {
  await assert.rejects(changeStaffGrant(pool, value), (error: unknown) =>
    error instanceof StaffGrantError && error.code === code);
}

before(async () => {
  const schema = await readFile(new URL('../migrations/001_foundation.sql', import.meta.url), 'utf8');
  await db.exec(schema.replace(/^\uFEFF/, ''));
});
beforeEach(async () => {
  await db.exec('TRUNCATE audit_events, staff_access_grants, staff_roles, guild_settings RESTART IDENTITY');
  await query('INSERT INTO guild_settings (guild_id) VALUES ($1), ($2)', [guild, otherGuild]);
  await query(`INSERT INTO staff_roles (guild_id, role_id, access_level)
    VALUES ($1, $3, 'admin'), ($1, $4, 'moderator'), ($2, $3, 'admin')`,
    [guild, otherGuild, adminRole, modRole]);
});
after(async () => { await db.close(); });

test('Admin grants full access and records actor, target, and reason', async () => {
  assert.equal(await changeStaffGrant(pool, input()), 'changed');
  assert.equal(await getStaffAccess(pool, guild, target, [modRole]), 'admin');
  const audit = await db.query<{ actor_id: string; event_type: string; details: Record<string, unknown> }>(
    'SELECT actor_id, event_type, details FROM audit_events');
  assert.equal(audit.rows[0]!.actor_id, admin);
  assert.equal(audit.rows[0]!.event_type, 'STAFF_ACCESS_GRANTED');
  assert.equal(audit.rows[0]!.details.target_user_id, target);
  assert.equal(audit.rows[0]!.details.reason, 'Approved test access');
});
test('ordinary Mods cannot grant or revoke access', async () => {
  for (const action of ['grant', 'revoke'] as const) {
    await expectCode(input({ actorRoleIds: [modRole], action }), 'ADMIN_REQUIRED');
  }
  assert.equal(await count('staff_access_grants'), 0);
  assert.equal(await count('audit_events'), 0);
});
test('members without staff roles cannot grant access', async () => {
  await expectCode(input({ actorRoleIds: [] }), 'ADMIN_REQUIRED');
  assert.equal(await count('staff_access_grants'), 0);
});
test('grant requires a current configured Mod role on the target', async () => {
  await expectCode(input({ targetRoleIds: [] }), 'TARGET_MOD_ROLE_REQUIRED');
  await expectCode(input({ targetRoleIds: [adminRole] }), 'TARGET_MOD_ROLE_REQUIRED');
  assert.equal(await count('staff_access_grants'), 0);
});
test('bots cannot receive full-access grants', async () => {
  await expectCode(input({ targetIsBot: true }), 'BOT_TARGET_NOT_ALLOWED');
});
test('repeated grant is idempotent and does not duplicate audit records', async () => {
  await changeStaffGrant(pool, input());
  assert.equal(await changeStaffGrant(pool, input()), 'unchanged');
  assert.equal(await count('staff_access_grants'), 1);
  assert.equal(await count('audit_events'), 1);
});
test('revocation restores normal Mod access and records the change', async () => {
  await changeStaffGrant(pool, input());
  assert.equal(await changeStaffGrant(pool, input({ action: 'revoke', reason: 'Test complete' })), 'changed');
  assert.equal(await getStaffAccess(pool, guild, target, [modRole]), 'moderator');
  assert.equal(await count('audit_events'), 2);
});
test('revoke works for a target who has left or lost their Mod role', async () => {
  await changeStaffGrant(pool, input());
  assert.equal(await changeStaffGrant(pool, input({ action: 'revoke', targetRoleIds: [] })), 'changed');
  assert.equal(await count('staff_access_grants'), 0);
});
test('repeated revoke makes no further changes', async () => {
  assert.equal(await changeStaffGrant(pool, input({ action: 'revoke' })), 'unchanged');
  assert.equal(await count('audit_events'), 0);
});
test('access and revocation are scoped to the selected server', async () => {
  await changeStaffGrant(pool, input());
  assert.equal(await getStaffAccess(pool, otherGuild, target, [modRole]), 'none');
  assert.equal(await changeStaffGrant(pool, input({ guildId: otherGuild, action: 'revoke' })), 'unchanged');
  assert.equal(await count('staff_access_grants'), 1);
});
test('losing the Mod role disables a stored grant', async () => {
  await changeStaffGrant(pool, input());
  assert.equal(await getStaffAccess(pool, guild, target, []), 'none');
  await expectCode(input({ actorId: target, actorRoleIds: [], targetId: nextTarget }), 'ADMIN_REQUIRED');
});
test('a Mod with full management access can administer grants', async () => {
  await changeStaffGrant(pool, input());
  assert.equal(await changeStaffGrant(pool, input({
    actorId: target, actorRoleIds: [modRole], targetId: nextTarget,
  })), 'changed');
});
test('invalid input does not create records', async () => {
  await expectCode(input({ reason: '   ' }), 'INVALID_REASON');
  await expectCode(input({ targetId: 'not-an-id' }), 'INVALID_USER_ID');
  assert.equal(await count('staff_access_grants'), 0);
});
test('unconfigured server fails closed', async () => {
  await expectCode(input({ guildId: '100000000000000099' }), 'SERVER_NOT_CONFIGURED');
});
test('an audit-write failure rolls back a grant', async () => {
  await db.exec("ALTER TABLE audit_events ADD CONSTRAINT test_reject_audit CHECK (event_type = 'reject')");
  try {
    await assert.rejects(changeStaffGrant(pool, input()));
    assert.equal(await count('staff_access_grants'), 0);
    assert.equal(await count('audit_events'), 0);
  } finally {
    await db.exec('ALTER TABLE audit_events DROP CONSTRAINT test_reject_audit');
  }
});
test('an audit-write failure rolls back a revocation', async () => {
  await changeStaffGrant(pool, input());
  await db.exec("ALTER TABLE audit_events ADD CONSTRAINT test_reject_revoke CHECK (event_type <> 'STAFF_ACCESS_REVOKED')");
  try {
    await assert.rejects(changeStaffGrant(pool, input({ action: 'revoke' })));
    assert.equal(await count('staff_access_grants'), 1);
    assert.equal(await count('audit_events'), 1);
  } finally {
    await db.exec('ALTER TABLE audit_events DROP CONSTRAINT test_reject_revoke');
  }
});
