import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { ChatInputCommandInteraction, RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { createWarning, deliverWarning, getWarningCase, warningMessage, WarningError } from '../src/warnings.js';
import type { WarningCase, WarningContext, WarningDependencies } from '../src/warnings.js';
import { caseSummary, deliveryLabel, handleWarning } from '../src/handle-warning.js';
import { warningDependencies } from '../src/warning-discord.js';
import type { Client } from 'discord.js';
import { warn, caseLookup } from '../src/commands.js';

const db = new PGlite();
const guild = '100000000000000001';
const otherGuild = '100000000000000002';
const adminRole = '200000000000000001';
const modRole = '200000000000000002';
const actor = '300000000000000001';
const target = '300000000000000002';
const channel = '500000000000000001';
const nextChannel = '500000000000000002';
const dmMessage = '600000000000000001';
const logMessage = '600000000000000002';
let sequence = 400000000000000000n;
let failCreateAudit = false;
let failDeliveryAudit = false;
async function query(sql: string, values?: unknown[]) {
  if (failCreateAudit && sql.includes("'WARNING_CREATED'")) throw new Error('audit unavailable');
  if (failDeliveryAudit && String(values?.[2]).startsWith('WARNING_DM_')) throw new Error('audit unavailable');
  const result = await db.query(sql, values);
  return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
let actorRoles: string[] | null;
let context: WarningContext;
let missingTarget = false;
let contextFailure = false;
let contextHook: (() => Promise<void>) | undefined;
let channelUsable = true;
let channelFailure = false;
let dmFailure: 'forbidden' | 'network' | 'invalid' | undefined;
let logFailure: 'forbidden' | 'network' | undefined;
let dms: { target: string; body: RESTPostAPIChannelMessageJSONBody }[];
let logs: { channel: string; body: RESTPostAPIChannelMessageJSONBody }[];
const deps: WarningDependencies = {
  readActorRoles: async () => actorRoles,
  readContext: async () => {
    await contextHook?.();
    if (missingTarget) throw new WarningError('TARGET_NOT_MEMBER');
    if (contextFailure) throw new Error('Discord unavailable');
    return { ...context, actorRoleIds: actorRoles ?? [] };
  },
  readLogChannels: async () => {
    if (channelFailure) throw new Error('channel unavailable');
    return [{ id: channel, name: 'logs', usable: channelUsable }];
  },
  sendDM: async (targetId, body) => {
    dms.push({ target: targetId, body });
    if (dmFailure === 'forbidden') throw Object.assign(new Error('private Discord detail'), { status: 403, code: 50007 });
    if (dmFailure === 'network') throw new Error('private network detail');
    return { id: dmFailure === 'invalid' ? 'invalid' : dmMessage };
  },
  sendLog: async (channelId, body) => {
    logs.push({ channel: channelId, body });
    if (logFailure === 'forbidden') throw Object.assign(new Error('private Discord detail'), { status: 403 });
    if (logFailure === 'network') throw new Error('private network detail');
    return { id: logMessage };
  },
};
const input = (overrides: Record<string, unknown> = {}) => ({
  guildId: guild, actorId: actor, targetId: target, requestId: String(++sequence), reason: 'Respect the server rules.', ...overrides,
});
async function create(overrides: Record<string, unknown> = {}) { return createWarning(pool, input(overrides), deps); }
async function code(overrides: Record<string, unknown>, expected: string) {
  await assert.rejects(create(overrides), (error: unknown) => error instanceof WarningError && error.code === expected);
}
async function events() {
  return (await db.query<{ event_type: string; details: Record<string, unknown>; actor_id: string }>(
    'SELECT event_type, details, actor_id FROM audit_events ORDER BY event_id')).rows;
}
async function read(number: number, selectedGuild = guild) {
  return getWarningCase(pool, { guildId: selectedGuild, actorId: actor, caseNumber: number }, deps.readActorRoles);
}

before(async () => {
  for (const name of ['001_foundation.sql', '003_moderation_warnings.sql']) {
    await db.exec((await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
  }
});
beforeEach(async () => {
  failCreateAudit = false; failDeliveryAudit = false;
  actorRoles = [adminRole]; missingTarget = false; contextFailure = false; contextHook = undefined;
  channelUsable = true; channelFailure = false; dmFailure = undefined; logFailure = undefined; dms = []; logs = [];
  context = { actorRoleIds: [adminRole], targetRoleIds: [], targetIsBot: false, targetIsOwner: false,
    actorAboveTarget: true, guildName: 'Maru Development' };
  await db.exec('TRUNCATE moderation_cases, guild_case_counters, audit_events, staff_access_grants, staff_roles, guild_settings RESTART IDENTITY');
  await pool.query('INSERT INTO guild_settings (guild_id, settings) VALUES ($1,$3::jsonb),($2,$3::jsonb)',
    [guild, otherGuild, JSON.stringify({ moderation_log_channel_id: channel, keep: 'existing' })]);
  await pool.query(`INSERT INTO staff_roles (guild_id, role_id, access_level)
    VALUES ($1,$3,'admin'),($1,$4,'moderator'),($2,$3,'admin')`, [guild, otherGuild, adminRole, modRole]);
});
after(async () => { await db.close(); });

test('Admin saves a numbered warning and audit event before any delivery', async () => {
  const result = await create({ reason: '  Follow the rules.  ' });
  assert.equal(result.created, true); assert.equal(result.record.case_number, 1);
  assert.equal(result.record.reason, 'Follow the rules.');
  assert.equal(result.record.actor_id, actor); assert.equal(result.record.target_user_id, target);
  assert.equal(result.record.dm_status, 'pending'); assert.equal(result.record.log_status, 'pending');
  assert.equal(result.record.log_channel_id, channel);
  assert.equal(dms.length + logs.length, 0);
  const audit = await events(); assert.equal(audit.length, 1);
  assert.equal(audit[0]!.event_type, 'WARNING_CREATED'); assert.equal(audit[0]!.actor_id, actor);
  assert.equal(audit[0]!.details.case_number, 1); assert.equal(audit[0]!.details.target_user_id, target);
});
test('case numbers increase independently for each server', async () => {
  assert.equal((await create()).record.case_number, 1);
  assert.equal((await create()).record.case_number, 2);
  assert.equal((await create({ guildId: otherGuild })).record.case_number, 1);
});
test('ordinary Mod can warn an ordinary member', async () => {
  actorRoles = [modRole]; assert.equal((await create()).created, true);
});
test('unmapped members cannot create warnings or read cases', async () => {
  const saved = await create(); actorRoles = [];
  await code({}, 'STAFF_REQUIRED');
  await assert.rejects(read(saved.record.case_number), /STAFF_REQUIRED/);
  assert.equal((await events()).length, 1);
});
test('a departed actor cannot issue warnings', async () => {
  actorRoles = null; await code({}, 'STAFF_REQUIRED');
});
test('native ownership alone does not bypass configured Maru staff access', async () => {
  actorRoles = []; context.actorAboveTarget = true;
  await code({}, 'STAFF_REQUIRED');
});
test('self, bot, and server-owner targets are rejected', async () => {
  await code({ targetId: actor }, 'SELF_TARGET');
  context.targetIsBot = true; await code({}, 'BOT_TARGET');
  context.targetIsBot = false; context.targetIsOwner = true; await code({}, 'OWNER_TARGET');
  assert.equal((await events()).length, 0);
});
test('equal or higher Discord roles cannot be warned', async () => {
  context.actorAboveTarget = false; await code({}, 'ROLE_HIERARCHY');
});
test('Mods cannot warn other configured Mods', async () => {
  actorRoles = [modRole]; context.targetRoleIds = [modRole]; await code({}, 'STAFF_TARGET');
});
test('Admin may warn a lower-ranked Mod but cannot warn another Admin', async () => {
  context.targetRoleIds = [modRole]; assert.equal((await create()).created, true);
  context.targetRoleIds = [adminRole]; await code({}, 'STAFF_TARGET');
});
test('an effective full-access grant protects the target as an Admin', async () => {
  context.targetRoleIds = [modRole];
  await pool.query('INSERT INTO staff_access_grants (guild_id,user_id,granted_by) VALUES ($1,$2,$3)', [guild, target, actor]);
  await code({}, 'STAFF_TARGET');
});
test('a full-access Mod can warn a lower-ranked ordinary Mod', async () => {
  actorRoles = [modRole]; context.targetRoleIds = [modRole];
  await pool.query('INSERT INTO staff_access_grants (guild_id,user_id,granted_by) VALUES ($1,$2,$3)', [guild, actor, actor]);
  assert.equal((await create()).created, true);
});
test('losing staff roles during the context lookup prevents the write', async () => {
  contextHook = async () => { actorRoles = []; };
  await code({}, 'STAFF_REQUIRED'); assert.equal((await events()).length, 0);
});
test('grant revocation is checked again after looking up the target', async () => {
  actorRoles = [modRole]; context.targetRoleIds = [modRole];
  await pool.query('INSERT INTO staff_access_grants (guild_id,user_id,granted_by) VALUES ($1,$2,$3)', [guild, actor, actor]);
  contextHook = async () => { await pool.query('DELETE FROM staff_access_grants WHERE guild_id=$1', [guild]); };
  await code({}, 'STAFF_TARGET'); assert.equal((await events()).length, 0);
});
test('missing target and Discord context failures create no warning', async () => {
  missingTarget = true; await code({}, 'TARGET_NOT_MEMBER');
  missingTarget = false; contextFailure = true; await assert.rejects(create(), /Discord unavailable/);
  assert.equal((await events()).length, 0);
});
test('blank and overlong reasons or invalid IDs do not allocate cases', async () => {
  await code({ reason: '   ' }, 'INVALID_REASON'); await code({ reason: 'x'.repeat(501) }, 'INVALID_REASON');
  await code({ targetId: 'invalid' }, 'INVALID_ID');
  assert.equal((await create()).record.case_number, 1);
});
test('unconfigured server fails closed', async () => {
  await code({ guildId: '100000000000000099' }, 'SERVER_NOT_CONFIGURED');
});
test('same interaction returns its existing case without duplicate audits', async () => {
  const data = input(); const one = await createWarning(pool, data, deps); const two = await createWarning(pool, data, deps);
  assert.equal(two.created, false); assert.equal(two.record.case_number, one.record.case_number);
  assert.equal((await events()).length, 1);
});
test('same interaction cannot be reused for a different reason or member', async () => {
  const data = input(); await createWarning(pool, data, deps);
  await assert.rejects(createWarning(pool, { ...data, reason: 'Changed' }, deps), /REQUEST_MISMATCH/);
  await assert.rejects(createWarning(pool, { ...data, targetId: '300000000000000099' }, deps), /REQUEST_MISMATCH/);
});
test('creation audit failure rolls back both warning and counter', async () => {
  failCreateAudit = true; await assert.rejects(create(), /audit unavailable/);
  assert.equal((await events()).length, 0);
  failCreateAudit = false; assert.equal((await create()).record.case_number, 1);
});
test('warning creation does not replace unrelated server settings', async () => {
  await create();
  const result = await db.query<{ settings: Record<string, unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1', [guild]);
  assert.equal(result.rows[0]!.settings.keep, 'existing');
});
test('DM and log confirm independently and are auditable', async () => {
  const { record } = await create(); const result = await deliverWarning(pool, record, deps);
  assert.equal(result.dm_status, 'sent'); assert.equal(result.log_status, 'sent');
  assert.equal(result.dm_message_id, dmMessage); assert.equal(result.log_message_id, logMessage);
  assert.equal(dms[0]!.target, target); assert.equal(logs[0]!.channel, channel);
  assert.deepEqual((await events()).map((event) => event.event_type), ['WARNING_CREATED', 'WARNING_DM_SENT', 'WARNING_LOG_SENT']);
});
test('DM includes case, server, and reason while suppressing mentions', async () => {
  const { record } = await create({ reason: '@everyone **Please stop**' });
  await deliverWarning(pool, record, deps);
  const body = dms[0]!.body; assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.enforce_nonce, true); assert.equal(String(body.nonce).length, 25);
  assert.match(body.embeds![0]!.description!, /Maru Development/);
  assert.equal(body.embeds![0]!.fields![0]!.value, '1');
  assert.ok(body.embeds![0]!.fields![1]!.value.includes('\\*\\*Please stop\\*\\*'));
  assert.notEqual(body.nonce, logs[0]!.body.nonce);
});
test('maximum reason remains within Discord embed field length', async () => {
  const { record } = await create({ reason: '*'.repeat(500) });
  const message = warningMessage(record, 'log');
  assert.ok(message.embeds![0]!.fields!.every((field) => field.value.length <= 1024));
});
test('closed DMs do not remove the warning or prevent a log message', async () => {
  dmFailure = 'forbidden'; const { record } = await create(); const result = await deliverWarning(pool, record, deps);
  assert.equal(result.dm_status, 'failed'); assert.equal(result.log_status, 'sent');
  assert.ok(await read(1)); assert.equal(logs.length, 1);
});
test('log rejection does not prevent the member DM', async () => {
  logFailure = 'forbidden'; const { record } = await create(); const result = await deliverWarning(pool, record, deps);
  assert.equal(result.dm_status, 'sent'); assert.equal(result.log_status, 'failed');
});
test('missing channel permissions prevent a log send while DM still succeeds', async () => {
  channelUsable = false; const { record } = await create(); const result = await deliverWarning(pool, record, deps);
  assert.equal(result.dm_status, 'sent'); assert.equal(result.log_status, 'failed'); assert.equal(logs.length, 0);
});
test('channel lookup failure leaves honest uncertain log status', async () => {
  channelFailure = true; const { record } = await create(); const result = await deliverWarning(pool, record, deps);
  assert.equal(result.dm_status, 'sent'); assert.equal(result.log_status, 'unconfirmed'); assert.equal(logs.length, 0);
});
test('missing destination is reported without preventing the DM or warning', async () => {
  await pool.query('UPDATE guild_settings SET settings=$2::jsonb WHERE guild_id=$1', [guild, '{}']);
  const { record } = await create(); assert.equal(record.log_status, 'not_configured');
  const result = await deliverWarning(pool, record, deps);
  assert.equal(result.dm_status, 'sent'); assert.equal(result.log_status, 'not_configured'); assert.equal(logs.length, 0);
});
test('changed settings do not redirect a saved warning to an unreviewed destination', async () => {
  const { record } = await create();
  await pool.query('UPDATE guild_settings SET settings=$2::jsonb WHERE guild_id=$1', [guild, JSON.stringify({ moderation_log_channel_id: nextChannel })]);
  await deliverWarning(pool, record, deps); assert.equal(logs[0]!.channel, channel);
});
test('lost responses do not falsely report delivery or retry automatically', async () => {
  dmFailure = 'network'; logFailure = 'network'; const { record } = await create();
  const result = await deliverWarning(pool, record, deps);
  assert.equal(result.dm_status, 'unconfirmed'); assert.equal(result.log_status, 'unconfirmed');
  await deliverWarning(pool, record, deps); assert.equal(dms.length, 1); assert.equal(logs.length, 1);
  assert.ok(!(JSON.stringify(await events())).includes('private network detail'));
});
test('invalid delivery response is never marked sent', async () => {
  dmFailure = 'invalid'; const { record } = await create();
  assert.equal((await deliverWarning(pool, record, deps)).dm_status, 'unconfirmed');
});
test('duplicate delivery claims never repeat messages, even with a stale case object', async () => {
  const { record } = await create(); await deliverWarning(pool, record, deps); await deliverWarning(pool, record, deps);
  assert.equal(dms.length, 1); assert.equal(logs.length, 1); assert.equal((await events()).length, 3);
});
test('delivery uses saved recipient and reason rather than a stale caller object', async () => {
  const { record } = await create();
  await deliverWarning(pool, { ...record, target_user_id: actor, reason: 'forged' }, deps);
  assert.equal(dms[0]!.target, target); assert.ok(!JSON.stringify(dms).includes('forged'));
});
test('an interrupted sending state remains uncertain and is not replayed', async () => {
  const { record } = await create();
  await pool.query("UPDATE moderation_cases SET dm_status='sending',log_status='sending' WHERE guild_id=$1", [guild]);
  const result = await deliverWarning(pool, record, deps);
  assert.equal(result.dm_status, 'sending'); assert.equal(dms.length + logs.length, 0);
  assert.match(caseSummary(result), /Not confirmed/);
});
test('outcome audit failure rolls back status but still attempts the other delivery', async () => {
  failDeliveryAudit = true; const { record } = await create(); const result = await deliverWarning(pool, record, deps);
  assert.equal(result.dm_status, 'sending'); assert.equal(result.log_status, 'sent');
  assert.equal(dms.length, 1); assert.equal(logs.length, 1);
  failDeliveryAudit = false; await deliverWarning(pool, record, deps); assert.equal(dms.length, 1);
});
test('case lookup is staff only and scoped to its server', async () => {
  await create(); assert.equal(await read(1, otherGuild), undefined);
  actorRoles = [modRole]; assert.ok(await read(1));
  actorRoles = null; await assert.rejects(read(1), /STAFF_REQUIRED/);
});
test('case lookup handles missing and invalid numbers', async () => {
  assert.equal(await read(99), undefined);
  await assert.rejects(read(0), /INVALID_CASE/); await assert.rejects(read(1.5), /INVALID_CASE/);
});
test('case summary escapes reasons and reports delivery without claiming member read receipts', async () => {
  const { record } = await create({ reason: '**bold**' });
  assert.ok(caseSummary(record).includes('\\*\\*bold\\*\\*'));
  assert.match(caseSummary(record), /Not attempted/);
  assert.equal(deliveryLabel('sent'), 'Sent');
});

function interaction(commandName: string, requestId = String(++sequence), replies: unknown[] = []) {
  return { commandName, id: requestId, user: { id: actor },
    options: { getUser: () => ({ id: target }), getString: () => 'Respect the server rules.', getInteger: () => 1 },
    editReply: async (body: unknown) => { replies.push(body); },
  } as unknown as ChatInputCommandInteraction;
}
test('slash handler reports saved warning and separate delivery results', async () => {
  dmFailure = 'forbidden'; const replies: { content: string; allowedMentions: unknown }[] = [];
  await handleWarning(interaction('warn', undefined, replies), pool, guild, deps);
  assert.match(replies[0]!.content, /Warning saved/); assert.match(replies[0]!.content, /DM: Failed/);
  assert.match(replies[0]!.content, /Moderation log: Sent/); assert.deepEqual(replies[0]!.allowedMentions, { parse: [] });
});
test('duplicate slash interaction returns existing case without sending again', async () => {
  const id = String(++sequence); const replies: { content: string }[] = [];
  await handleWarning(interaction('warn', id, replies), pool, guild, deps);
  await handleWarning(interaction('warn', id, replies), pool, guild, deps);
  assert.match(replies[1]!.content, /already saved/); assert.equal(dms.length, 1); assert.equal(logs.length, 1);
});
test('case command returns saved case details without notifying the member', async () => {
  await create(); const replies: { content: string }[] = [];
  await handleWarning(interaction('case', undefined, replies), pool, guild, deps);
  assert.match(replies[0]!.content, /Case #1/); assert.equal(dms.length + logs.length, 0);
});
test('denied warning handler creates no case and no messages', async () => {
  actorRoles = []; const replies: { content: string }[] = [];
  await handleWarning(interaction('warn', undefined, replies), pool, guild, deps);
  assert.match(replies[0]!.content, /Access denied/); assert.equal((await events()).length, 0);
});
test('command definitions require a member and bounded reason or case number', () => {
  const warning = warn.toJSON(); const lookup = caseLookup.toJSON();
  assert.equal(warning.name, 'warn'); assert.equal(warning.options!.length, 2);
  assert.ok(warning.options!.every((option) => 'required' in option && option.required));
  assert.equal(lookup.name, 'case'); assert.equal(lookup.options![0]!.name, 'number');
});

test('Discord adapter refreshes owner, role hierarchy, and both member records', async () => {
  const calls: unknown[] = [];
  const actorMember = { roles: { cache: new Map([[adminRole, {}]]), highest: { comparePositionTo: () => 1 } } };
  const targetMember = { user: { bot: false }, roles: { cache: new Map(), highest: {} } };
  const fakeGuild = { ownerId: '300000000000000099', name: 'Fresh server name',
    roles: { fetch: async () => { calls.push('roles'); } },
    members: { fetch: async (options: { user: string; force: boolean }) => {
      calls.push(options); return options.user === actor ? actorMember : targetMember;
    } },
  };
  const client = { guilds: { fetch: async (options: unknown) => { calls.push(options); return fakeGuild; } }, rest: {} } as unknown as Client;
  const adapter = warningDependencies(client, guild, deps.readLogChannels);
  const result = await adapter.readContext(actor, target);
  assert.deepEqual(calls, [{ guild, force: true }, 'roles', { user: actor, force: true }, { user: target, force: true }]);
  assert.equal(result.actorAboveTarget, true); assert.equal(result.targetIsOwner, false);
  assert.equal(result.guildName, 'Fresh server name'); assert.deepEqual(result.actorRoleIds, [adminRole]);
});
test('Discord adapter creates the target DM and bounds both REST message requests', async () => {
  const calls: { route: string; options: { body: unknown; signal: AbortSignal } }[] = [];
  const dmChannel = '700000000000000001';
  const client = { rest: { post: async (route: string, options: { body: unknown; signal: AbortSignal }) => {
    calls.push({ route, options }); return { id: calls.length === 1 ? dmChannel : dmMessage };
  } } } as unknown as Client;
  const adapter = warningDependencies(client, guild, deps.readLogChannels);
  const { record } = await create(); const body = warningMessage(record, 'dm');
  assert.equal((await adapter.sendDM(target, body)).id, dmMessage);
  assert.equal(calls[0]!.route, '/users/@me/channels');
  assert.deepEqual(calls[0]!.options.body, { recipient_id: target });
  assert.equal(calls[1]!.route, `/channels/${dmChannel}/messages`);
  assert.equal(calls[1]!.options.body, body);
  assert.ok(calls.every((call) => call.options.signal instanceof AbortSignal));
});
test('failure replying after a committed warning does not create or deliver it twice', async () => {
  const replies: { content: string }[] = []; const call = interaction('warn'); let attempts = 0;
  call.editReply = (async (body: { content: string }) => {
    if (++attempts === 1) throw new Error('reply lost');
    replies.push(body);
  }) as ChatInputCommandInteraction['editReply'];
  await handleWarning(call, pool, guild, deps);
  assert.match(replies[0]!.content, /Warning #1 is saved/);
  assert.equal(dms.length, 1); assert.equal(logs.length, 1);
});
