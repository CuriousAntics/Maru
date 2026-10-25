import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { getStaffAccess, resolveStaffAccess } from '../src/staff-access.js';

test('unmapped members have no access', () => {
  assert.equal(resolveStaffAccess([]), 'none');
});
test('configured Admin role grants Admin', () => {
  assert.equal(resolveStaffAccess([{ access_level: 'admin', full_access: false }]), 'admin');
});
test('configured Mod role grants Moderator', () => {
  assert.equal(resolveStaffAccess([{ access_level: 'moderator', full_access: false }]), 'moderator');
});
test('a full-access grant elevates an existing Mod', () => {
  assert.equal(resolveStaffAccess([{ access_level: 'moderator', full_access: true }]), 'admin');
});
test('Admin takes precedence when several configured roles match', () => {
  assert.equal(resolveStaffAccess([
    { access_level: 'moderator', full_access: false },
    { access_level: 'admin', full_access: false },
  ]), 'admin');
});
test('unknown mappings do not grant access even with an individual grant', () => {
  assert.equal(resolveStaffAccess([{ access_level: 'unknown', full_access: true }]), 'none');
});
test('database failures reject access lookup', async () => {
  const pool = { query: async () => { throw new Error('database unavailable'); } } as unknown as Pool;
  await assert.rejects(getStaffAccess(pool, 'guild', 'member', []));
});
