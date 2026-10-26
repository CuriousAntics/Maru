import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { ChatInputCommandInteraction, Client, REST, RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { PermissionFlagsBits } from 'discord.js';
import { BanError, runBan, banNotification, parseDeleteHistory } from '../src/bans.js';
import type { BanContext, BanDependencies } from '../src/bans.js';
import { deliverWarning, createWarning } from '../src/warnings.js';
import { runTimeout } from '../src/timeouts.js';
import { caseSummary } from '../src/handle-warning.js';
import { handleBan } from '../src/handle-ban.js';
import { banDependencies } from '../src/ban-discord.js';
import { ban, unban } from '../src/commands.js';

const db = new PGlite();
const guild = '100000000000000001', otherGuild = '100000000000000002';
const adminRole = '200000000000000001', modRole = '200000000000000002';
const actor = '300000000000000001', target = '300000000000000002';
const channel = '500000000000000001', messageId = '600000000000000001';
let nextRequest = 400000000000000000n;
let busy = false, failRequestAudit = false, failOutcomeAudit = false, failClaim = false, failDMAudit = false, failUnlock = false, discarded = false;
async function query(sql: string, values?: unknown[]) {
  if (busy && sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }],rowCount: 1 };
  if (failUnlock && sql.includes('pg_advisory_unlock(')) throw new Error('unlock lost');
  if (failClaim && sql.includes("SET action_status='applying'")) throw new Error('claim unavailable');
  if (failRequestAudit && ['BAN_REQUESTED','UNBAN_REQUESTED'].includes(String(values?.[2]))) throw new Error('request audit unavailable');
  if (failOutcomeAudit && ['BAN_APPLIED','UNBAN_APPLIED'].includes(String(values?.[2]))) throw new Error('result audit unavailable');
  if (failDMAudit && String(values?.[2]).startsWith('BAN_DM_')) throw new Error('DM audit unavailable');
  const result = await db.query(sql,values);
  return { rows: result.rows,rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool = { query,async connect() { return { query,release(error?: Error) { if (error) discarded = true; } }; } } as unknown as Pool;
let actorRoles: string[] | null;
let context: BanContext;
let afterDM: (() => Promise<void>) | undefined;
let contextHook: (() => Promise<void>) | undefined;
let nativeFailure: 'forbidden' | 'network' | undefined;
let dmFailure: 'closed' | 'network' | 'invalid' | undefined;
let logUsable = true;
let contextCalls = 0;
let order: string[];
let actions: { targetId: string; seconds: number | null; number: number; action: string }[];
let dms: RESTPostAPIChannelMessageJSONBody[], logs: RESTPostAPIChannelMessageJSONBody[];
const deps: BanDependencies = {
  readActorRoles: async () => actorRoles,
  readContext: async () => context,
  readBanContext: async () => { contextCalls++; await contextHook?.(); return { ...context,actorRoleIds: actorRoles ?? [] }; },
  readLogChannels: async () => [{ id: channel,name: 'logs',usable: logUsable }],
  applyBan: async (targetId,seconds,number,action) => {
    const record = (await db.query<{ action_status: string; dm_status: string }>(
      'SELECT action_status,dm_status FROM moderation_cases WHERE guild_id=$1 AND case_number=$2',[guild,number])).rows[0]!;
    assert.equal(record.action_status,'applying');
    if (action === 'ban') assert.ok(['sent','failed','unconfirmed'].includes(record.dm_status),'DM outcome persisted before ban');
    actions.push({ targetId,seconds,number,action }); order.push(action);
    if (nativeFailure === 'forbidden') throw Object.assign(new Error('private Discord response'),{ status: 403 });
    if (nativeFailure === 'network') throw new Error('private network response');
  },
  sendDM: async (_target,body) => {
    const record = (await db.query<{ action_status: string; dm_status: string }>('SELECT action_status,dm_status FROM moderation_cases ORDER BY case_number DESC LIMIT 1')).rows[0]!;
    assert.equal(record.dm_status,'sending'); assert.equal(record.action_status,'pending');
    dms.push(body); order.push('dm'); await afterDM?.();
    if (dmFailure === 'closed') throw Object.assign(new Error('closed'),{ status: 403 });
    if (dmFailure === 'network') throw new Error('private network response');
    return { id: dmFailure === 'invalid' ? 'invalid' : messageId };
  },
  sendLog: async (_channel,body) => { logs.push(body); order.push('log'); return { id: messageId }; },
};
function input(overrides: Record<string,unknown> = {}) {
  return { guildId: guild,actorId: actor,targetId: target,requestId: String(++nextRequest),action: 'ban' as 'ban' | 'unban',reason: 'Development ban test',...overrides };
}
async function run(overrides: Record<string,unknown> = {}) { return runBan(pool,input(overrides),deps); }
async function expectCode(overrides: Record<string,unknown>, code: string) {
  await assert.rejects(run(overrides),(error: unknown) => error instanceof BanError && error.code === code);
}
async function events() { return (await db.query<{ event_type: string; details: Record<string,unknown> }>('SELECT event_type,details FROM audit_events ORDER BY event_id')).rows; }
before(async () => {
  for (const name of ['001_foundation.sql','003_moderation_warnings.sql','004_case_changes.sql','005_timeouts.sql','006_bans.sql']) {
    await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  }
});
beforeEach(async () => {
  busy = failRequestAudit = failOutcomeAudit = failClaim = failDMAudit = failUnlock = discarded = false;
  actorRoles = [adminRole]; afterDM = contextHook = undefined; nativeFailure = dmFailure = undefined; logUsable = true; contextCalls = 0;
  actions = []; dms = []; logs = []; order = [];
  context = { actorRoleIds: [adminRole],targetRoleIds: [],targetIsBot: false,targetIsOwner: false,actorAboveTarget: true,
    guildName: 'Maru Development',actorCanBan: true,botCanBan: true,botAboveTarget: true,
    targetIsMember: true,targetIsAdministrator: false,isBanned: false };
  await db.exec('SELECT pg_advisory_unlock_all()');
  await db.exec('TRUNCATE moderation_cases,guild_case_counters,audit_events,staff_access_grants,staff_roles,guild_settings RESTART IDENTITY');
  await pool.query('INSERT INTO guild_settings (guild_id,settings) VALUES ($1,$3::jsonb),($2,$3::jsonb)',[guild,otherGuild,JSON.stringify({ moderation_log_channel_id: channel })]);
  await pool.query("INSERT INTO staff_roles (guild_id,role_id,access_level) VALUES ($1,$3,'admin'),($1,$4,'moderator'),($2,$3,'admin')",[guild,otherGuild,adminRole,modRole]);
});
after(async () => { await db.close(); });

test('deletion parser defaults to 24h, supports keep and bounded explicit units', () => {
  assert.equal(parseDeleteHistory(null),86400);
  for (const [text,seconds] of [['0',0],['0s',0],['1h',3600],['24H',86400],['7d',604800],['604800s',604800]] as const) assert.equal(parseDeleteHistory(text),seconds);
  for (const text of ['8d','604801s','-1h','1.5h','24','1h30m','forever','999999999999999999999s']) assert.throws(() => parseDeleteHistory(text),/INVALID_HISTORY/);
});
test('default ban commits case before DM, DM outcome before ban and independent log after ban', async () => {
  const { record } = await run(); const result = await deliverWarning(pool,record,deps,banNotification);
  assert.equal(result.action,'ban'); assert.equal(result.action_status,'applied'); assert.equal(result.delete_message_seconds,86400);
  assert.deepEqual(order,['dm','ban','log']); assert.equal(contextCalls,2);
  assert.deepEqual((await events()).map((e) => e.event_type),['BAN_REQUESTED','BAN_DM_SENT','BAN_APPLIED','BAN_LOG_SENT']);
  assert.match(JSON.stringify(dms),/before the attempt/); assert.ok(!JSON.stringify(dms).includes('you have been banned'));
});
test('moderator can explicitly keep history or request seven days', async () => {
  assert.equal((await run({ deleteSeconds: 0 })).record.delete_message_seconds,0);
  assert.equal((await run({ deleteSeconds: 604800 })).record.delete_message_seconds,604800);
  assert.deepEqual(actions.map((a) => a.seconds),[0,604800]);
});
test('unban works for a departed user, sends no DM, and uses no deletion window', async () => {
  context.isBanned = true; context.targetIsMember = false;
  const { record } = await run({ action: 'unban' }); const result = await deliverWarning(pool,record,deps,banNotification);
  assert.equal(result.action_status,'applied'); assert.equal(result.delete_message_seconds,null); assert.equal(result.dm_status,'skipped');
  assert.deepEqual(order,['unban','log']); assert.equal(actions[0]!.seconds,null);
});
test('already banned and not-banned unban are no-ops without case, DM or deletion', async () => {
  context.isBanned = true; await expectCode({},'ALREADY_BANNED'); context.isBanned = false; await expectCode({ action: 'unban' },'NOT_BANNED');
  assert.equal((await events()).length,0); assert.deepEqual(order,[]);
});
test('nonmember bans and protected targets never send DMs or actions', async () => {
  await expectCode({ targetId: actor },'SELF_TARGET');
  context.targetIsMember = false; await expectCode({},'TARGET_NOT_MEMBER'); context.targetIsMember = true;
  context.targetIsBot = true; await expectCode({},'BOT_TARGET'); context.targetIsBot = false;
  context.targetIsOwner = true; await expectCode({},'PROTECTED_TARGET'); context.targetIsOwner = false;
  context.targetIsAdministrator = true; await expectCode({},'PROTECTED_TARGET'); assert.deepEqual(order,[]);
});
test('mapped staff and native Ban Members permissions and both role orders are required', async () => {
  actorRoles = []; await expectCode({},'STAFF_REQUIRED'); actorRoles = null; await expectCode({},'STAFF_REQUIRED'); actorRoles = [modRole];
  context.actorCanBan = false; await expectCode({},'ACTOR_PERMISSION'); context.actorCanBan = true;
  context.botCanBan = false; await expectCode({},'BOT_PERMISSION'); context.botCanBan = true;
  context.botAboveTarget = false; await expectCode({},'BOT_PERMISSION'); context.botAboveTarget = true;
  context.actorAboveTarget = false; await expectCode({},'ROLE_HIERARCHY'); assert.deepEqual(order,[]);
});
test('Mods can ban ordinary members but not peer staff; Admin access can target a lower Mod', async () => {
  actorRoles = [modRole]; assert.equal((await run()).record.action_status,'applied');
  context.targetRoleIds = [modRole]; await expectCode({},'STAFF_TARGET');
  actorRoles = [adminRole]; assert.equal((await run()).record.action_status,'applied');
  context.targetRoleIds = [adminRole]; await expectCode({},'STAFF_TARGET');
});
test('full-access grants do not replace native Ban Members permission', async () => {
  actorRoles = [modRole]; await pool.query('INSERT INTO staff_access_grants (guild_id,user_id,granted_by) VALUES ($1,$2,$2)',[guild,actor]);
  context.actorCanBan = false; await expectCode({},'ACTOR_PERMISSION');
});
test('invalid data and unconfigured server do not allocate cases', async () => {
  for (const seconds of [-1,604801,1.5,NaN]) await expectCode({ deleteSeconds: seconds },'INVALID_HISTORY');
  await expectCode({ reason: ' ' },'INVALID_REASON'); await expectCode({ reason: 'x'.repeat(501) },'INVALID_REASON');
  await expectCode({ targetId: 'invalid' },'INVALID_INPUT'); await expectCode({ guildId: '100000000000000099' },'SERVER_NOT_CONFIGURED');
  assert.equal((await run()).record.case_number,1);
});
test('duplicate interactions never resend pre-ban DM, ban, unban or log', async () => {
  const data = input(); const first = await runBan(pool,data,deps); await deliverWarning(pool,first.record,deps,banNotification);
  const second = await runBan(pool,data,deps); await deliverWarning(pool,second.record,deps,banNotification);
  assert.equal(second.created,false); assert.deepEqual(order,['dm','ban','log']);
  await assert.rejects(runBan(pool,{ ...data,deleteSeconds: 0 },deps),/REQUEST_MISMATCH/);
  await assert.rejects(runBan(pool,{ ...data,action: 'unban' },deps),/REQUEST_MISMATCH/);
});
test('closed DM does not block ban or moderation log', async () => {
  dmFailure = 'closed'; const { record } = await run(); const result = await deliverWarning(pool,record,deps,banNotification);
  assert.equal(result.dm_status,'failed'); assert.equal(result.action_status,'applied'); assert.equal(result.log_status,'sent'); assert.deepEqual(order,['dm','ban','log']);
});
test('ambiguous or invalid DM response is recorded once and does not block ban', async () => {
  for (const failure of ['network','invalid'] as const) {
    dmFailure = failure; const { record } = await run(); assert.equal(record.dm_status,'unconfirmed'); assert.equal(record.action_status,'applied');
  }
  assert.equal(actions.length,2); assert.equal(dms.length,2); assert.ok(!JSON.stringify(await events()).includes('private network response'));
});
test('role loss during the pre-ban DM rejects ban and still allows a result log', async () => {
  afterDM = async () => { actorRoles = []; };
  const { record } = await run(); await deliverWarning(pool,record,deps,banNotification);
  assert.equal(record.action_status,'rejected'); assert.equal(record.action_error,'STAFF_REQUIRED'); assert.deepEqual(order,['dm','log']);
});
test('grant revoked during DM blocks a peer-staff ban', async () => {
  actorRoles = [modRole]; context.targetRoleIds = [modRole];
  await pool.query('INSERT INTO staff_access_grants (guild_id,user_id,granted_by) VALUES ($1,$2,$2)',[guild,actor]);
  afterDM = async () => { await pool.query('DELETE FROM staff_access_grants WHERE guild_id=$1',[guild]); };
  const { record } = await run(); assert.equal(record.action_status,'rejected'); assert.equal(record.action_error,'STAFF_TARGET'); assert.equal(actions.length,0);
});
test('native permission, hierarchy, target membership and ban changes during DM prevent the ban', async () => {
  for (const [field,value,code] of [['actorCanBan',false,'ACTOR_PERMISSION'],['botCanBan',false,'BOT_PERMISSION'],
    ['botAboveTarget',false,'BOT_PERMISSION'],['actorAboveTarget',false,'ROLE_HIERARCHY'],['targetIsMember',false,'TARGET_NOT_MEMBER'],
    ['targetIsAdministrator',true,'PROTECTED_TARGET'],['isBanned',true,'ALREADY_BANNED']] as const) {
    const previous = context[field]; afterDM = async () => { (context[field] as boolean) = value; };
    const { record } = await run(); assert.equal(record.action_status,'rejected'); assert.equal(record.action_error,code); (context[field] as boolean) = previous;
  }
  assert.equal(actions.length,0);
});
test('reauthorization lookup failure after DM records rejection without dispatching', async () => {
  afterDM = async () => { contextHook = async () => { throw new Error('private lookup'); }; };
  const { record } = await run(); assert.equal(record.action_status,'rejected'); assert.equal(record.action_error,'AUTHORIZATION_UNAVAILABLE'); assert.equal(actions.length,0);
});
test('request audit failure rolls back the case and prevents every external send', async () => {
  failRequestAudit = true; await assert.rejects(run(),/request audit unavailable/); assert.deepEqual(order,[]);
  failRequestAudit = false; assert.equal((await run()).record.case_number,1);
});
test('pre-ban DM audit failure preserves uncertain DM and stops ban without replay', async () => {
  failDMAudit = true; const data = input(); await assert.rejects(runBan(pool,data,deps),(e: unknown) => e instanceof BanError && e.caseNumber === 1);
  failDMAudit = false; const duplicate = await runBan(pool,data,deps);
  assert.equal(duplicate.record.dm_status,'sending'); assert.equal(duplicate.record.action_status,'pending'); assert.deepEqual(order,['dm']);
});
test('action claim failure prevents the ban and duplicate never resumes it', async () => {
  failClaim = true; const data = input(); await assert.rejects(runBan(pool,data,deps),(e: unknown) => e instanceof BanError && e.caseNumber === 1);
  failClaim = false; assert.equal((await runBan(pool,data,deps)).record.action_status,'pending'); assert.deepEqual(order,['dm']);
});
test('explicit Discord rejection is recorded separately from a delivered pre-ban notice', async () => {
  nativeFailure = 'forbidden'; const { record } = await run(); const result = await deliverWarning(pool,record,deps,banNotification);
  assert.equal(result.action_status,'rejected'); assert.equal(result.dm_status,'sent'); assert.equal(result.action_error,'HTTP_403'); assert.equal(result.log_status,'sent');
  assert.match(JSON.stringify(logs),/Rejected/); assert.ok(!JSON.stringify(await events()).includes('private Discord response'));
});
test('lost native response is unconfirmed and never automatically retried', async () => {
  nativeFailure = 'network'; const data = input(); const result = await runBan(pool,data,deps);
  await deliverWarning(pool,result.record,deps,banNotification); await runBan(pool,data,deps);
  assert.equal(result.record.action_status,'unconfirmed'); assert.deepEqual(order,['dm','ban','log']);
});
test('outcome audit failure leaves an uncertain claim and does not replay ban or DM', async () => {
  failOutcomeAudit = true; const data = input(); await assert.rejects(runBan(pool,data,deps),(e: unknown) => e instanceof BanError && e.caseNumber === 1);
  failOutcomeAudit = false; const duplicate = await runBan(pool,data,deps); assert.equal(duplicate.record.action_status,'applying');
  await deliverWarning(pool,duplicate.record,deps,banNotification); assert.deepEqual(order,['dm','ban']);
});
test('missing log permissions never undo a ban', async () => {
  logUsable = false; const { record } = await run(); const result = await deliverWarning(pool,record,deps,banNotification);
  assert.equal(result.action_status,'applied'); assert.equal(result.log_status,'failed'); assert.deepEqual(order,['dm','ban']);
});
test('warning timeout and ban share one server case sequence', async () => {
  const first = await createWarning(pool,{ ...input(),reason: 'Warning' },deps);
  assert.equal(first.record.case_number,1);
  const second = await runTimeout(pool,{ ...input(),action: 'timeout',durationSeconds: 60 },{ ...deps,
    readTimeoutContext: async () => ({ ...context,actorCanModerate: true,botCanModerate: true,previousUntil: null }),
    applyTimeout: async (targetId,until) => ({ targetId,until }) });
  assert.equal(second.record.case_number,2); assert.equal((await run()).record.case_number,3);
});
test('busy shared member lock blocks case and external effects', async () => {
  busy = true; await expectCode({},'MEMBER_BUSY'); assert.deepEqual(order,[]); assert.equal((await events()).length,0);
});
test('failed unlock discards the pooled connection', async () => {
  failUnlock = true; assert.equal((await run()).record.action_status,'applied'); assert.equal(discarded,true);
  failUnlock = false; await db.exec('SELECT pg_advisory_unlock_all()');
});
test('server scope keeps cases, staff access and audit separate', async () => {
  await run(); assert.equal((await run({ guildId: otherGuild })).record.case_number,1);
  const counts = await db.query<{ guild_id: string; count: string }>('SELECT guild_id,count(*)::text FROM moderation_cases GROUP BY guild_id'); assert.equal(counts.rows.length,2);
});
test('database prevents editing native cases or invalid deletion windows', async () => {
  await run(); await assert.rejects(pool.query("UPDATE moderation_cases SET state='void',revision=1,void_reason='Undo'"),/moderation_cases_native_read_only/);
  await assert.rejects(pool.query('UPDATE moderation_cases SET delete_message_seconds=604801'),/moderation_cases_ban_fields_check/);
  await assert.rejects(pool.query('UPDATE moderation_cases SET delete_message_seconds=NULL'),/moderation_cases_ban_fields_check/);
});
test('summaries distinguish requested deletion, pre-ban DM and action result', async () => {
  const { record } = await run(); const summary = caseSummary(record);
  assert.match(summary,/Ban · Recorded/); assert.match(summary,/Requested message deletion: 1 day/); assert.match(summary,/Action: Applied/);
  assert.ok(!summary.includes('Requested end UTC'));
  const notice = banNotification(record,'dm'); assert.deepEqual(notice.allowed_mentions,{ parse: [] }); assert.equal(notice.enforce_nonce,true);
});
test('commands use required member or user ID and optional deletion override', () => {
  const command = ban.toJSON(); assert.equal(command.name,'ban'); assert.equal(command.options!.length,3);
  assert.equal(command.options![0]!.required,true); assert.equal(command.options![1]!.required,true); assert.ok(!command.options![2]!.required);
  assert.equal(unban.toJSON().options![0]!.name,'user-id');
});
function interaction(commandName: string, replies: { content: string }[], history: string | null = null) {
  return { id: String(++nextRequest),commandName,user: { id: actor },options: {
    getUser: () => ({ id: target }),getString: (name: string) => name === 'delete-history' ? history : name === 'user-id' ? target : 'Development test',
  },editReply: async (body: { content: string }) => { replies.push(body); } } as unknown as ChatInputCommandInteraction;
}
test('handler defaults to 24h and reports failed DM without hiding ban success', async () => {
  dmFailure = 'closed'; const replies: { content: string }[] = [];
  await handleBan(interaction('ban',replies),pool,guild,deps);
  assert.equal(actions[0]!.seconds,86400); assert.match(replies[0]!.content,/Action: Applied/); assert.match(replies[0]!.content,/DM: Failed/);
});
test('handler rejects invalid deletion duration before DM or ban', async () => {
  const replies: { content: string }[] = []; await handleBan(interaction('ban',replies,'8d'),pool,guild,deps);
  assert.match(replies[0]!.content,/Maximum 7d/); assert.deepEqual(order,[]);
});
test('duplicate handler never repeats external actions', async () => {
  const replies: { content: string }[] = []; const call = interaction('ban',replies);
  await handleBan(call,pool,guild,deps); await handleBan(call,pool,guild,deps);
  assert.deepEqual(order,['dm','ban','log']); assert.match(replies[1]!.content,/already recorded/);
});
test('unban handler accepts a departed user ID and makes no DM attempt', async () => {
  context.isBanned = true; context.targetIsMember = false; const replies: { content: string }[] = [];
  await handleBan(interaction('unban',replies),pool,guild,deps); assert.deepEqual(order,['unban','log']); assert.match(replies[0]!.content,/No member DM/);
});
test('uncertain action reply refers to saved case and avoids claiming success', async () => {
  failOutcomeAudit = true; const replies: { content: string }[] = []; await handleBan(interaction('ban',replies),pool,guild,deps);
  assert.match(replies[0]!.content,/Case #1 is saved/); assert.ok(!replies[0]!.content.includes('Action: Applied'));
});
test('adapter uses exact PUT deletion seconds, DELETE without body, and bounded requests', async () => {
  const calls: { method: string; route: string; options: Record<string,unknown> }[] = [];
  const writer = { put: async (route: string,options: Record<string,unknown>) => { calls.push({ method: 'put',route,options }); },
    delete: async (route: string,options: Record<string,unknown>) => { calls.push({ method: 'delete',route,options }); },post: async () => ({}) } as unknown as Pick<REST,'put'|'delete'|'post'>;
  const adapter = banDependencies({} as Client,guild,'test-token',deps,writer);
  await adapter.applyBan(target,86400,1,'ban'); await adapter.applyBan(target,null,2,'unban');
  assert.equal(calls[0]!.route,`/guilds/${guild}/bans/${target}`); assert.deepEqual(calls[0]!.options.body,{ delete_message_seconds: 86400 });
  assert.equal(calls[1]!.method,'delete'); assert.ok(!('body' in calls[1]!.options)); assert.ok(calls.every((c) => c.options.signal instanceof AbortSignal));
});
test('adapter rejects an unexpected mutation response instead of claiming a confirmed ban', async () => {
  const writer = { put: async () => ({ unexpected: true }) } as unknown as Pick<REST,'put'|'delete'|'post'>;
  await assert.rejects(banDependencies({} as Client,guild,'test-token',deps,writer).applyBan(target,86400,1,'ban'),/UNEXPECTED_RESPONSE/);
});
test('adapter refreshes permissions and ban membership, and does not need a member fetch to unban', async () => {
  const calls: unknown[] = []; let banned = false;
  const fakeActor = { id: actor,roles: { cache: new Map([[adminRole,{}]]),highest: { comparePositionTo: () => 1 } },permissions: { has: () => true } };
  const fakeTarget = { id: target,user: { bot: false },roles: { cache: new Map(),highest: {} },permissions: { has: () => false } };
  const me = { roles: { highest: { comparePositionTo: () => 1 } },permissions: { has: () => true } };
  const fakeGuild = { name: 'Fresh guild',ownerId: '300000000000000099',roles: { fetch: async () => { calls.push('roles'); } },
    members: { fetch: async (options: { user: string }) => { calls.push(options); return options.user === actor ? fakeActor : fakeTarget; },fetchMe: async (options: unknown) => { calls.push(options); return me; } },
    bans: { fetch: async (options: unknown) => { calls.push(options); if (!banned) throw { code: 10026 }; return {}; } } };
  const client = { guilds: { fetch: async (options: unknown) => { calls.push(options); return fakeGuild; } } } as unknown as Client;
  const adapter = banDependencies(client,guild,'test-token',deps);
  const result = await adapter.readBanContext(actor,target,'ban');
  assert.equal(result.targetIsMember,true); assert.equal(result.isBanned,false); assert.equal(result.actorCanBan,true);
  assert.deepEqual(calls,[{ guild,force: true },'roles',{ user: actor,force: true },{ force: true },{ user: target,force: true },{ user: target,force: true }]);
  calls.length = 0; banned = true; const removed = await adapter.readBanContext(actor,target,'unban');
  assert.equal(removed.isBanned,true); assert.equal(removed.targetIsMember,false); assert.equal(calls.length,5);
});

test('unban failures and response loss preserve separate outcomes without a DM', async () => {
  context.isBanned = true; context.targetIsMember = false;
  for (const [failure,status] of [['forbidden','rejected'],['network','unconfirmed']] as const) {
    nativeFailure = failure; const data = input({ action: 'unban' });
    const result = await runBan(pool,data,deps); await deliverWarning(pool,result.record,deps,banNotification); await runBan(pool,data,deps);
    assert.equal(result.record.action_status,status); assert.equal(result.record.dm_status,'skipped');
  }
  assert.equal(actions.length,2); assert.equal(dms.length,0); assert.equal(logs.length,2);
});
test('lookup error in initial ban validation fails closed before allocation or DM', async () => {
  contextHook = async () => { throw new Error('ban lookup unavailable'); };
  await assert.rejects(run(),/ban lookup unavailable/); assert.deepEqual(order,[]); assert.equal((await events()).length,0);
});
test('Discord adapter distinguishes unknown ban from lookup failure and checks native permission first', async () => {
  let permission = true, mode = 'network', lookups = 0;
  const member = { id: actor,roles: { cache: new Map(),highest: {} },permissions: { has: () => permission } };
  const fakeGuild = { ownerId: actor,name: 'Test',roles: { fetch: async () => {} },members: { fetch: async () => member,fetchMe: async () => member },
    bans: { fetch: async () => { lookups++; throw mode === 'network' ? new Error('lookup unavailable') : { code: 10026 }; } } };
  const client = { guilds: { fetch: async () => fakeGuild } } as unknown as Client;
  const adapter = banDependencies(client,guild,'test-token',deps);
  await assert.rejects(adapter.readBanContext(actor,target,'unban'),/lookup unavailable/);
  mode = 'missing'; assert.equal((await adapter.readBanContext(actor,target,'unban')).isBanned,false);
  permission = false; await assert.rejects(adapter.readBanContext(actor,target,'unban'),/ACTOR_PERMISSION/); assert.equal(lookups,2);
});


test('ban and unban accept the actual REST parser output for a Discord 204 response', async () => {
  const { parseResponse } = await import('@discordjs/rest');
  const emptyResponse = async () => parseResponse(new Response(null,{ status: 204 }));
  const parsed = await emptyResponse();
  assert.ok(parsed instanceof ArrayBuffer); assert.equal(parsed.byteLength,0);
  const writer = { put: emptyResponse,delete: emptyResponse } as unknown as Pick<REST,'put'|'delete'|'post'>;
  const adapter = banDependencies({} as Client,guild,'test-token',deps,writer);
  await adapter.applyBan(target,0,1,'ban');
  await adapter.applyBan(target,null,2,'unban');
});
test('nonempty binary response remains unconfirmed rather than reporting success', async () => {
  const writer = { put: async () => new ArrayBuffer(1) } as unknown as Pick<REST,'put'|'delete'|'post'>;
  await assert.rejects(banDependencies({} as Client,guild,'test-token',deps,writer).applyBan(target,0,1,'ban'),/UNEXPECTED_RESPONSE/);
});
