import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { PermissionFlagsBits } from 'discord.js';
import type { ChatInputCommandInteraction, Client, REST, RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { runTimeout, timeoutNotification, TimeoutError } from '../src/timeouts.js';
import type { TimeoutContext, TimeoutDependencies } from '../src/timeouts.js';
import { deliverWarning, createWarning } from '../src/warnings.js';
import { parseTimeoutDuration } from '../src/case-labels.js';
import { caseSummary } from '../src/handle-warning.js';
import { handleTimeout } from '../src/handle-timeout.js';
import { timeoutDependencies } from '../src/timeout-discord.js';
import { timeout, untimeout } from '../src/commands.js';

const db = new PGlite();
const guild = '100000000000000001';
const otherGuild = '100000000000000002';
const adminRole = '200000000000000001';
const modRole = '200000000000000002';
const actor = '300000000000000001';
const target = '300000000000000002';
const channel = '500000000000000001';
const messageId = '600000000000000001';
let nextRequest = 400000000000000000n;
let busy = false;
let failRequestAudit = false;
let failOutcomeAudit = false;
let failClaim = false;
let failUnlock = false;
let discarded = false;
async function query(sql: string, values?: unknown[]) {
  if (busy && sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }],rowCount: 1 };
  if (failUnlock && sql.includes('pg_advisory_unlock(')) throw new Error('unlock connection lost');
  if (failClaim && sql.includes("SET action_status='applying'")) throw new Error('claim unavailable');
  if (failRequestAudit && ['TIMEOUT_REQUESTED','UNTIMEOUT_REQUESTED'].includes(String(values?.[2]))) throw new Error('request audit unavailable');
  if (failOutcomeAudit && ['TIMEOUT_APPLIED','UNTIMEOUT_APPLIED'].includes(String(values?.[2]))) throw new Error('result audit unavailable');
  const result = await db.query(sql,values);
  return { rows: result.rows,rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool = { query,async connect() { return { query,release(error?: Error) { if (error) discarded = true; } }; } } as unknown as Pool;
let actorRoles: string[] | null;
let context: TimeoutContext;
let contextHook: (() => Promise<void>) | undefined;
let nativeFailure: 'forbidden' | 'network' | 'wrong-target' | 'wrong-time' | undefined;
let closedDM = false;
let logUsable = true;
let actions: { targetId: string; until: string | null; number: number; action: string }[];
let dms: RESTPostAPIChannelMessageJSONBody[];
let logs: RESTPostAPIChannelMessageJSONBody[];
const deps: TimeoutDependencies = {
  readActorRoles: async () => actorRoles,
  readContext: async () => context,
  readTimeoutContext: async () => { await contextHook?.(); return { ...context,actorRoleIds: actorRoles ?? [] }; },
  readLogChannels: async () => [{ id: channel,name: 'logs',usable: logUsable }],
  applyTimeout: async (targetId,until,number,action) => {
    const record = (await db.query<{ action_status: string }>('SELECT action_status FROM moderation_cases WHERE guild_id=$1 AND case_number=$2',[guild,number])).rows[0];
    assert.equal(record?.action_status,'applying','intent and claim are persisted before the native request');
    actions.push({ targetId,until,number,action });
    if (nativeFailure === 'forbidden') throw Object.assign(new Error('private Discord response'),{ status: 403 });
    if (nativeFailure === 'network') throw new Error('private network response');
    return { targetId: nativeFailure === 'wrong-target' ? actor : targetId,until: nativeFailure === 'wrong-time' ? null : until };
  },
  sendDM: async (_target,body) => {
    dms.push(body); if (closedDM) throw Object.assign(new Error('closed'),{ status: 403 }); return { id: messageId };
  },
  sendLog: async (_channel,body) => { logs.push(body); return { id: messageId }; },
};
function input(overrides: Record<string,unknown> = {}) {
  return { guildId: guild,actorId: actor,targetId: target,requestId: String(++nextRequest),
    action: 'timeout' as 'timeout' | 'untimeout',durationSeconds: 60,reason: 'Development timeout test',...overrides };
}
async function run(overrides: Record<string,unknown> = {}) { return runTimeout(pool,input(overrides),deps); }
async function expectCode(overrides: Record<string,unknown>, code: string) {
  await assert.rejects(run(overrides),(error: unknown) => error instanceof TimeoutError && error.code === code);
}
async function events() {
  return (await db.query<{ event_type: string; details: Record<string,unknown> }>('SELECT event_type,details FROM audit_events ORDER BY event_id')).rows;
}
before(async () => {
  for (const name of ['001_foundation.sql','003_moderation_warnings.sql','004_case_changes.sql','005_timeouts.sql', '006_bans.sql']) {
    await db.exec((await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8')).replace(/^\uFEFF/,''));
  }
});
beforeEach(async () => {
  busy = false; failRequestAudit = false; failOutcomeAudit = false; failClaim = false; failUnlock = false; discarded = false;
  actorRoles = [adminRole]; contextHook = undefined; nativeFailure = undefined; closedDM = false; logUsable = true;
  actions = []; dms = []; logs = [];
  context = { actorRoleIds: [adminRole],targetRoleIds: [],targetIsBot: false,targetIsOwner: false,actorAboveTarget: true,
    guildName: 'Maru Development',actorCanModerate: true,botCanModerate: true,botAboveTarget: true,
    targetIsAdministrator: false,previousUntil: null };
  await db.exec('SELECT pg_advisory_unlock_all()');
  await db.exec('TRUNCATE moderation_cases,guild_case_counters,audit_events,staff_access_grants,staff_roles,guild_settings RESTART IDENTITY');
  await pool.query('INSERT INTO guild_settings (guild_id,settings) VALUES ($1,$3::jsonb),($2,$3::jsonb)',
    [guild,otherGuild,JSON.stringify({ moderation_log_channel_id: channel })]);
  await pool.query(`INSERT INTO staff_roles (guild_id,role_id,access_level)
    VALUES ($1,$3,'admin'),($1,$4,'moderator'),($2,$3,'admin')`,[guild,otherGuild,adminRole,modRole]);
});
after(async () => { await db.close(); });

test('duration parser supports explicit units and rejects ambiguous or out-of-range values', () => {
  for (const [text,seconds] of [['30s',30],['10m',600],['2H',7200],['1d',86400],['1w',604800],['28d',2419200]] as const) {
    assert.equal(parseTimeoutDuration(text),seconds);
  }
  for (const text of ['0s','29d','5w','1.5h','-1m','10','forever','1h30m','999999999999999999999s']) assert.throws(() => parseTimeoutDuration(text));
});
test('successful timeout persists intent, claim, absolute end, and confirmed result', async () => {
  const start = Date.now(); const { record } = await run();
  assert.equal(record.action,'timeout'); assert.equal(record.action_status,'applied');
  assert.equal(record.duration_seconds,60); assert.ok(new Date(record.requested_until!).getTime() >= start + 60000);
  assert.equal(actions.length,1); assert.equal(actions[0]!.targetId,target);
  assert.equal(record.original_reason,record.reason); assert.ok(record.action_attempted_at); assert.ok(record.action_completed_at);
  assert.deepEqual((await events()).map((event) => event.event_type),['TIMEOUT_REQUESTED','TIMEOUT_APPLIED']);
});
test('timeout removal uses null and records the previous end', async () => {
  context.previousUntil = new Date(Date.now()+600000).toISOString();
  const { record } = await run({ action: 'untimeout',durationSeconds: undefined });
  assert.equal(record.action,'untimeout'); assert.equal(record.action_status,'applied'); assert.equal(actions[0]!.until,null);
  assert.equal(record.duration_seconds,null); assert.equal(new Date(record.previous_until!).toISOString(),context.previousUntil);
});
test('a new timeout explicitly replaces an existing timeout end', async () => {
  context.previousUntil = new Date(Date.now()+3600000).toISOString();
  const { record } = await run({ durationSeconds: 60 });
  assert.ok(new Date(record.requested_until!).getTime() < new Date(record.previous_until!).getTime());
});
test('removing a missing or expired timeout performs no action and creates no case', async () => {
  await expectCode({ action: 'untimeout' },'NO_TIMEOUT');
  context.previousUntil = new Date(Date.now()-1000).toISOString(); await expectCode({ action: 'untimeout' },'NO_TIMEOUT');
  assert.equal(actions.length,0); assert.equal((await events()).length,0);
});
test('unmapped members and departed staff cannot mutate Discord', async () => {
  actorRoles = []; await expectCode({},'STAFF_REQUIRED'); actorRoles = null; await expectCode({},'STAFF_REQUIRED');
  assert.equal(actions.length,0);
});
test('self, bot, owner and Administrator targets are protected', async () => {
  await expectCode({ targetId: actor },'SELF_TARGET');
  context.targetIsBot = true; await expectCode({},'BOT_TARGET'); context.targetIsBot = false;
  context.targetIsOwner = true; await expectCode({},'PROTECTED_TARGET'); context.targetIsOwner = false;
  context.targetIsAdministrator = true; await expectCode({},'PROTECTED_TARGET'); assert.equal(actions.length,0);
});
test('both actor permission and bot permission/role order are required', async () => {
  context.actorCanModerate = false; await expectCode({},'ACTOR_PERMISSION'); context.actorCanModerate = true;
  context.botCanModerate = false; await expectCode({},'BOT_PERMISSION'); context.botCanModerate = true;
  context.botAboveTarget = false; await expectCode({},'BOT_PERMISSION'); context.botAboveTarget = true;
  context.actorAboveTarget = false; await expectCode({},'ROLE_HIERARCHY'); assert.equal(actions.length,0);
});
test('Mods can time out ordinary members but cannot target peer staff', async () => {
  actorRoles = [modRole]; assert.equal((await run()).record.action_status,'applied');
  context.targetRoleIds = [modRole]; await expectCode({},'STAFF_TARGET');
});
test('a full-access grant does not replace native Moderate Members permission', async () => {
  actorRoles = [modRole]; await pool.query('INSERT INTO staff_access_grants (guild_id,user_id,granted_by) VALUES ($1,$2,$3)',[guild,actor,actor]);
  context.actorCanModerate = false; await expectCode({},'ACTOR_PERMISSION');
});
test('role loss during target validation prevents the native request', async () => {
  contextHook = async () => { actorRoles = []; }; await expectCode({},'STAFF_REQUIRED'); assert.equal(actions.length,0);
});
test('invalid input and unconfigured servers do not allocate a case', async () => {
  await expectCode({ durationSeconds: 0 },'INVALID_DURATION'); await expectCode({ durationSeconds: 2419201 },'INVALID_DURATION');
  await expectCode({ reason: ' ' },'INVALID_REASON'); await expectCode({ targetId: 'invalid' },'INVALID_INPUT');
  await expectCode({ guildId: '100000000000000099' },'SERVER_NOT_CONFIGURED');
  assert.equal((await run()).record.case_number,1);
});
test('duplicate interaction returns its stored result without repeating the native action', async () => {
  const data = input(); const first = await runTimeout(pool,data,deps); const second = await runTimeout(pool,data,deps);
  assert.equal(first.record.case_number,second.record.case_number); assert.equal(second.created,false); assert.equal(actions.length,1);
  await assert.rejects(runTimeout(pool,{ ...data,durationSeconds: 600 },deps),/REQUEST_MISMATCH/);
});
test('initial audit failure rolls back the case and prevents the native request', async () => {
  failRequestAudit = true; await assert.rejects(run(),/request audit unavailable/);
  assert.equal(actions.length,0); assert.equal((await events()).length,0);
  failRequestAudit = false; assert.equal((await run()).record.case_number,1);
});
test('claim failure retains the case but never dispatches an uncertain claim', async () => {
  failClaim = true; await assert.rejects(run(),(error: unknown) => error instanceof TimeoutError && error.caseNumber === 1);
  assert.equal(actions.length,0);
  const row = (await db.query<{ action_status: string }>('SELECT action_status FROM moderation_cases')).rows[0]!;
  assert.equal(row.action_status,'pending');
});
test('explicit Discord rejection is recorded and never DMs a false success', async () => {
  nativeFailure = 'forbidden'; const { record } = await run(); assert.equal(record.action_status,'rejected'); assert.equal(record.dm_status,'skipped');
  const delivered = await deliverWarning(pool,record,deps,timeoutNotification);
  assert.equal(dms.length,0); assert.equal(logs.length,1); assert.equal(delivered.log_status,'sent');
  assert.match(JSON.stringify(logs),/Rejected/); assert.ok(!JSON.stringify(await events()).includes('private Discord response'));
});
test('lost native response is unconfirmed and is not automatically retried', async () => {
  nativeFailure = 'network'; const data = input(); const result = await runTimeout(pool,data,deps);
  assert.equal(result.record.action_status,'unconfirmed');
  await deliverWarning(pool,result.record,deps,timeoutNotification); await runTimeout(pool,data,deps);
  assert.equal(actions.length,1); assert.equal(dms.length,0); assert.equal(logs.length,1);
});
test('an unexpected native response does not claim the action was applied', async () => {
  nativeFailure = 'wrong-target'; assert.equal((await run()).record.action_status,'unconfirmed');
  nativeFailure = 'wrong-time'; assert.equal((await run()).record.action_status,'unconfirmed');
});
test('outcome audit failure rolls back the recorded result without retrying the native action', async () => {
  failOutcomeAudit = true; const data = input();
  await assert.rejects(runTimeout(pool,data,deps),(error: unknown) => error instanceof TimeoutError && error.caseNumber === 1);
  assert.equal(actions.length,1); failOutcomeAudit = false;
  const duplicate = await runTimeout(pool,data,deps); assert.equal(duplicate.record.action_status,'applying');
  assert.equal(actions.length,1); assert.equal(dms.length+logs.length,0);
});
test('DM failure does not undo an applied timeout or prevent the staff log', async () => {
  closedDM = true; const { record } = await run(); const result = await deliverWarning(pool,record,deps,timeoutNotification);
  assert.equal(result.action_status,'applied'); assert.equal(result.dm_status,'failed'); assert.equal(result.log_status,'sent');
});
test('log permissions do not undo the native action or successful member DM', async () => {
  logUsable = false; const { record } = await run(); const result = await deliverWarning(pool,record,deps,timeoutNotification);
  assert.equal(result.action_status,'applied'); assert.equal(result.dm_status,'sent'); assert.equal(result.log_status,'failed');
});
test('timeout removal sends its own DM and log, with mentions disabled', async () => {
  context.previousUntil = new Date(Date.now()+600000).toISOString(); const { record } = await run({ action: 'untimeout',durationSeconds: undefined });
  await deliverWarning(pool,record,deps,timeoutNotification);
  assert.equal(dms.length,1); assert.match(JSON.stringify(dms),/removed your timeout/);
  assert.deepEqual(dms[0]!.allowed_mentions,{ parse: [] }); assert.equal(dms[0]!.enforce_nonce,true);
});
test('duplicate notification claims never repeat timeout DMs or logs', async () => {
  const { record } = await run(); await deliverWarning(pool,record,deps,timeoutNotification); await deliverWarning(pool,record,deps,timeoutNotification);
  assert.equal(dms.length,1); assert.equal(logs.length,1);
});
test('timeout operations and warnings share the server case counter', async () => {
  const warning = await createWarning(pool,{ guildId: guild,actorId: actor,targetId: target,requestId: String(++nextRequest),reason: 'Warning' },deps);
  assert.equal(warning.record.case_number,1); assert.equal((await run()).record.case_number,2);
});
test('busy native member lock prevents any case or API request', async () => {
  busy = true; await expectCode({},'MEMBER_BUSY'); assert.equal(actions.length,0); assert.equal((await events()).length,0);
});
test('failed unlock discards the pooled connection instead of retaining a session lock', async () => {
  failUnlock = true; assert.equal((await run()).record.action_status,'applied'); assert.equal(discarded,true);
  failUnlock = false; await db.exec('SELECT pg_advisory_unlock_all()');
});
test('historical summaries label action result separately from notifications', async () => {
  const { record } = await run(); const text = caseSummary(record);
  assert.match(text,/Timeout · Recorded/); assert.match(text,/Action: Applied/); assert.match(text,/DM: Not attempted/);
});
test('command definitions require a duration for timeout and a reason for both actions', () => {
  assert.equal(timeout.toJSON().name,'timeout'); assert.equal(timeout.toJSON().options!.length,3);
  assert.equal(untimeout.toJSON().name,'untimeout'); assert.equal(untimeout.toJSON().options!.length,2);
});
function interaction(commandName: string, replies: { content: string }[], id = String(++nextRequest)) {
  return { id,commandName,user: { id: actor },options: {
    getUser: () => ({ id: target }),getString: (name: string) => name === 'duration' ? '10m' : 'Development test',
  },editReply: async (body: { content: string }) => { replies.push(body); } } as unknown as ChatInputCommandInteraction;
}
test('timeout handler reports applied action and independent DM/log results', async () => {
  const replies: { content: string }[] = []; closedDM = true;
  await handleTimeout(interaction('timeout',replies),pool,guild,deps);
  assert.match(replies[0]!.content,/Action: Applied/); assert.match(replies[0]!.content,/DM: Failed/); assert.match(replies[0]!.content,/Moderation log: Sent/);
});
test('duplicate command handler never repeats either action or notifications', async () => {
  const replies: { content: string }[] = []; const call = interaction('timeout',replies);
  await handleTimeout(call,pool,guild,deps); await handleTimeout(call,pool,guild,deps);
  assert.equal(actions.length,1); assert.equal(dms.length,1); assert.match(replies[1]!.content,/already recorded/);
});
test('outcome failure reply refers to the saved case and does not imply confirmed success', async () => {
  const replies: { content: string }[] = []; failOutcomeAudit = true;
  await handleTimeout(interaction('timeout',replies),pool,guild,deps);
  assert.match(replies[0]!.content,/Case #1 is saved/); assert.ok(!replies[0]!.content.includes('Action: Applied'));
});
test('Discord mutation adapter uses a single explicit PATCH with the requested absolute time or null', async () => {
  const calls: { route: string; options: { body: unknown; signal: AbortSignal; reason: string } }[] = [];
  const writer = { patch: async (route: string,options: { body: { communication_disabled_until: string | null }; signal: AbortSignal; reason: string }) => {
    calls.push({ route,options }); return { user: { id: target },communication_disabled_until: options.body.communication_disabled_until };
  } } as unknown as Pick<REST,'patch'>;
  const adapter = timeoutDependencies({} as Client,guild,'test-token',deps,writer);
  const until = new Date(Date.now()+60000).toISOString();
  assert.deepEqual(await adapter.applyTimeout(target,until,1,'timeout'),{ targetId: target,until });
  await adapter.applyTimeout(target,null,2,'untimeout');
  assert.equal(calls.length,2); assert.equal(calls[0]!.route,`/guilds/${guild}/members/${target}`);
  assert.deepEqual(calls[1]!.options.body,{ communication_disabled_until: null });
  assert.ok(calls.every((call) => call.options.signal instanceof AbortSignal));
});

test('native adapter refreshes actor, target, bot, roles and ownership before checking permissions', async () => {
  const calls: unknown[] = []; const previous = new Date(Date.now()+60000);
  const fakeActor = { id: actor,roles: { cache: new Map([[adminRole,{}]]),highest: { comparePositionTo: () => 1 } },
    permissions: { has: (permission: bigint) => permission === PermissionFlagsBits.ModerateMembers } };
  const fakeTarget = { id: target,user: { bot: false },roles: { cache: new Map(),highest: {} },
    permissions: { has: (permission: bigint) => permission === PermissionFlagsBits.Administrator },communicationDisabledUntil: previous };
  const me = { roles: { highest: { comparePositionTo: () => -1 } },permissions: { has: () => false } };
  const fakeGuild = { name: 'Fresh guild',ownerId: '300000000000000099',roles: { fetch: async () => { calls.push('roles'); } },
    members: { fetch: async (options: { user: string; force: boolean }) => { calls.push(options); return options.user === actor ? fakeActor : fakeTarget; },
      fetchMe: async (options: unknown) => { calls.push(options); return me; } } };
  const client = { guilds: { fetch: async (options: unknown) => { calls.push(options); return fakeGuild; } } } as unknown as Client;
  const result = await timeoutDependencies(client,guild,'test-token',deps,{ patch: async () => ({}) } as unknown as Pick<REST,'patch'>)
    .readTimeoutContext(actor,target);
  assert.deepEqual(calls,[{ guild,force: true },'roles',{ user: actor,force: true },{ user: target,force: true },{ force: true }]);
  assert.equal(result.actorCanModerate,true); assert.equal(result.botCanModerate,false); assert.equal(result.botAboveTarget,false);
  assert.equal(result.targetIsAdministrator,true); assert.equal(result.previousUntil,previous.toISOString());
});

test('database keeps native action cases read only during mixed-version rollout', async () => {
  await run();
  await assert.rejects(pool.query("UPDATE moderation_cases SET state='void',void_reason='Undo',revision=revision+1 WHERE guild_id=$1",[guild]),
    /moderation_cases_native_read_only/);
  assert.equal(actions.length,1);
});
