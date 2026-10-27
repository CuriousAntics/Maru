import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { APIMessage, Client, REST, RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { autoModProof, digest, randomToken, settingsProof } from '../src/web-security.js';
import { AutoModError, autoModExempt, readAutoModSettings, saveAutoModSettings } from '../src/automod-settings.js';
import type { AutoModResources } from '../src/automod-settings.js';
import { matchBlockedWords, parseBlockedWords } from '../src/blocked-words.js';
import { enqueueAutoModCandidates, parseAutoModEvent, processAutoModJob } from '../src/automod-worker.js';
import type { AutoModContext, AutoModDependencies, AutoModMessage } from '../src/automod-engine.js';
import { autoModDependencies } from '../src/automod-discord.js';
import { caseSummary } from '../src/handle-warning.js';
import type { WarningCase } from '../src/warnings.js';

const db=new PGlite();
const guild='100000000000000001',otherGuild='100000000000000002';
const admin='200000000000000001',mod='200000000000000002',community='200000000000000003';
const actor='300000000000000001',member='300000000000000002',bot='300000000000000003';
const channel='500000000000000001',logs='500000000000000002',otherChannel='500000000000000003';
let messageId=600000000000000000n;
let token=randomToken(),roles: string[] | null,resources: AutoModResources;
let failAudit: string | undefined,failClaim=false,busy=false,failUnlock=false,discarded=false,transaction=false;
async function query(sql: string,values?: unknown[]) {
  if(busy && sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }],rowCount: 1 };
  if(failUnlock && (sql.includes('pg_advisory_unlock_all') || sql.includes('pg_advisory_unlock('))) throw new Error('unlock failed');
  if(failClaim && sql.includes("SET action_status='applying'")) throw new Error('claim lost');
  if(failAudit && (sql.includes(`'${failAudit}'`) || values?.[2]===failAudit)) throw new Error('private audit diagnostic');
  const result=await db.query(sql,values); if(sql==='BEGIN') transaction=true; if(['ROLLBACK','COMMIT'].includes(sql)) transaction=false;
  return { rows: result.rows,rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool={ query,async connect() { return { query,release(error?: Error) { if(error) discarded=true; } }; } } as unknown as Pool;
let readHook: (() => Promise<void>) | undefined;
const readRoles=async () => { await readHook?.(); return roles; };
const readResources=async () => resources;
function settings(overrides: Record<string,unknown>={}) {
  return { guildId: guild,actorId: actor,token,revision: 0,enabled: true,words: 'marutestword\nbad phrase',timeoutSeconds: 600,
    exemptRoles: [admin,mod],ignoredChannels: [],enforcedRoles: [],enforcedChannels: [],reason: 'Configure development filter',readRoles,readResources,...overrides };
}
async function save(overrides: Record<string,unknown>={}) { return saveAutoModSettings(pool,settings(overrides)); }
let context: AutoModContext;
let messages: Map<string,AutoModMessage>;
let nativeFailure: 'network'|'forbidden'|'after'|undefined,logFailure: 'network'|'forbidden'|undefined;
let deleteFailure: 'before'|'after'|undefined;
let actions: { user: string; until: string; number: number }[],sent: RESTPostAPIChannelMessageJSONBody[],deletes: string[];
let contextHook: (() => Promise<void>) | undefined;
const deps: AutoModDependencies={ botId: () => bot,
  readMessage: async (_channel,id) => messages.get(id) ?? null,
  readContext: async () => { await contextHook?.(); return { ...context }; },
  deleteMessage: async (_channel,id) => { assert.equal(transaction,false); deletes.push(id); if(deleteFailure==='before') throw new Error('delete network failure'); messages.delete(id); if(deleteFailure==='after') throw new Error('delete response lost'); },
  applyTimeout: async (user,until,number) => {
    assert.equal(transaction,false); const row=(await query('SELECT action_status FROM moderation_cases WHERE guild_id=$1 AND case_number=$2',[guild,number])).rows[0] as { action_status: string };
    assert.equal(row.action_status,'applying'); actions.push({ user,until,number });
    if(nativeFailure==='forbidden') throw Object.assign(new Error('private response'),{ status: 403 });
    if(nativeFailure==='network') throw new Error('private connection diagnostic');
    context.timeoutUntil=until; if(nativeFailure==='after') throw new Error('response lost after native action'); return { targetId: user,until };
  },
  sendLog: async (_channel,body) => { sent.push(body); if(logFailure==='forbidden') throw Object.assign(new Error('forbidden'),{ status: 403 }); if(logFailure==='network') throw new Error('response lost'); return '800000000000000001'; },
};
function message(content='MARUTESTWORD',userId=member) {
  const id=String(++messageId); const value={ id,channelId: channel,userId,content,bot: false,webhook: false }; messages.set(id,value); return value;
}
async function enqueue(value: AutoModMessage,eventAt=new Date()) { await enqueueAutoModCandidates(pool,guild,[{ messageId: value.id,channelId: value.channelId,content: value.content,eventAt }]); }
async function run(value=message(),eventAt=new Date()) { await enqueue(value,eventAt); await processAutoModJob(pool,guild,deps); return value; }
async function retry() { await query("UPDATE automod_jobs SET available_at=NOW()-INTERVAL '1 second'"); return processAutoModJob(pool,guild,deps); }
async function violations() { return (await query('SELECT * FROM automod_violations ORDER BY message_id')).rows as Record<string,unknown>[]; }
async function cases() { return (await query('SELECT * FROM moderation_cases ORDER BY case_number')).rows as WarningCase[]; }
async function five() { for(let i=0;i<5;i++) await run(); }
let base='',ready=true,handler: ReturnType<typeof createDashboardHandler>;
const server=createServer((req,res) => { void handler(req,res); });
async function request(path: string,init: RequestInit={}) { return fetch(base+path,{ ...init,redirect: 'manual',headers: { cookie: `maru_session=${token}`,...init.headers } }); }
function form(overrides: Record<string,string>={}) { return new URLSearchParams({ csrf: autoModProof(token,0),revision: '0',enabled: 'true',words: 'marutestword',timeout: '10m',reason: 'Enable test rule',exempt_role: admin,...overrides }); }
async function post(body: URLSearchParams | string=form(),headers: Record<string,string>={}) { return request('/automod',{ method: 'POST',body,headers: { origin: base,'content-type': 'application/x-www-form-urlencoded',...headers } }); }
before(async () => {
  for(const name of ['001_foundation.sql','002_dashboard_auth.sql','003_moderation_warnings.sql','004_case_changes.sql','005_timeouts.sql','006_bans.sql','010_blocked_words.sql']) await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  failAudit=undefined; failClaim=busy=failUnlock=discarded=transaction=false; readHook=contextHook=undefined;
  nativeFailure=logFailure=deleteFailure=undefined; actions=[]; sent=[]; deletes=[]; messages=new Map(); token=randomToken(); roles=[admin]; ready=true;
  resources={ roles: [{ id: admin,name: 'Admin' },{ id: mod,name: 'Mods' },{ id: community,name: 'Community Manager' }],
    channels: [{ id: channel,name: 'general' },{ id: logs,name: 'logs' },{ id: otherChannel,name: 'finished-work' }],canDelete: true,canTimeout: true };
  context={ guildName: 'Maru Development',roleIds: [],parentId: null,owner: false,canDelete: true,canTimeout: true,timeoutUntil: null };
  await db.exec('SELECT pg_advisory_unlock_all()');
  await db.exec('TRUNCATE automod_counters,automod_violations,automod_jobs,automod_settings,moderation_cases,guild_case_counters,dashboard_sessions,dashboard_login_attempts,audit_events,staff_access_grants,staff_roles,guild_settings RESTART IDENTITY');
  await query('INSERT INTO guild_settings (guild_id,settings) VALUES ($1,$3::jsonb),($2,$3::jsonb)',[guild,otherGuild,JSON.stringify({ moderation_log_channel_id: logs })]);
  await query("INSERT INTO staff_roles (guild_id,role_id,access_level) VALUES ($1,$2,'admin'),($1,$3,'moderator')",[guild,admin,mod]);
  await query("INSERT INTO dashboard_sessions (token_hash,guild_id,user_id,display_name,expires_at) VALUES ($1,$2,$3,'Staff',NOW()+INTERVAL '1 hour')",[digest(token),guild,actor]);
  handler=createDashboardHandler({ pool,guildId: guild,config: { origin: base,secure: false,applicationId: '400000000000000001',clientSecret: 'test-only' },isBotReady: () => ready,readMemberRoles: readRoles,readAutoModResources: readResources });
});
after(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); await db.close(); });

test('literal matching is case insensitive and uses Unicode word boundaries and normalized phrases', () => {
  assert.deepEqual(parseBlockedWords(' Bad, BAD, bad   phrase, a+b,,\r\n other '),['bad','bad phrase','a+b','other']);
  const entries=parseBlockedWords(' Bad \n BAD\n bad   phrase \n a+b'); assert.deepEqual(entries,['bad','bad phrase','a+b']);
  assert.deepEqual(matchBlockedWords('BAD, and bad\nphrase with a+b!',entries),entries);
  assert.deepEqual(matchBlockedWords('badminton notbad bad_name bad123 badé',entries),[]);
  assert.deepEqual(matchBlockedWords('ｂａｄ b\u200bad',['bad']),['bad']);
  assert.deepEqual(matchBlockedWords('aaab',['a+b']),[]);
  assert.throws(() => parseBlockedWords('x'.repeat(101))); assert.throws(() => parseBlockedWords(Array.from({ length: 101 },(_,i) => `word${i}`).join('\n')));
});
test('defaults are Off, ten minutes, and suggest current staff and named Community Manager roles', async () => {
  const config=await readAutoModSettings(pool,guild,resources); assert.equal(config.blocked_enabled,false); assert.equal(config.timeout_seconds,600);
  assert.deepEqual(config.exempt_role_ids,[admin,mod,community]); await run(); assert.equal(deletes.length,0);
});
test('whole-word matches remove the message, record one violation and log without pings or full content', async () => {
  await save(); const value=await run(message('A private message with MARUTESTWORD inside.'));
  assert.equal(messages.has(value.id),false); assert.equal((await violations()).length,1); assert.equal(sent.length,1);
  assert.deepEqual(sent[0]!.allowed_mentions,{ parse: [] }); assert.ok(!JSON.stringify(sent).includes('private message'));
  assert.equal((await violations())[0]!.violation_count,1); assert.equal(actions.length,0);
});
test('five distinct violations trigger one native timeout, a case, and a counter reset', async () => {
  await save(); await five(); assert.equal(deletes.length,5); assert.equal(actions.length,1); assert.equal(sent.length,5);
  const record=(await cases())[0]!; assert.equal(record.action_status,'applied'); assert.equal(record.origin,'automod'); assert.equal(record.dm_status,'skipped'); assert.equal(record.log_status,'sent');
  assert.equal(record.duration_seconds,600); assert.equal((await violations())[4]!.violation_count,5); assert.match(caseSummary(record),/Not sent for automatic moderation/);
  context.timeoutUntil=null; await run(); assert.equal((await violations())[5]!.violation_count,1); assert.equal(actions.length,1);
});
test('repeated events and repeated edits to one message cannot count or log twice', async () => {
  await save(); const value=await run(); await enqueue(value); await processAutoModJob(pool,guild,deps);
  assert.equal((await violations()).length,1); assert.equal(deletes.length,1); assert.equal(sent.length,1);
});
test('messages edited to a harmless value before processing are not deleted', async () => {
  await save(); const value=message(); await enqueue(value); messages.set(value.id,{ ...value,content: 'No matches now' }); await processAutoModJob(pool,guild,deps);
  assert.equal(deletes.length,0); assert.equal((await violations()).length,0);
});
test('bot webhook owner and exempt members do not get violations', async () => {
  await save(); const botMessage=message(); botMessage.bot=true; await run(botMessage); const webhook=message(); webhook.webhook=true; await run(webhook);
  context.owner=true; await run(); context.owner=false; context.roleIds=[mod]; await run(); assert.equal(deletes.length,0); assert.equal((await violations()).length,0);
});
test('ignored channels and their threads are exempt, with independent rule overrides', async () => {
  await save({ ignoredChannels: [otherChannel] }); context.parentId=otherChannel; await run(); assert.equal(deletes.length,0);
  await save({ revision: 1,ignoredChannels: [otherChannel],enforcedChannels: [otherChannel] }); await run(); assert.equal(deletes.length,1);
  context.roleIds=[mod]; await run(); assert.equal(deletes.length,1);
});
test('an enforced globally exempt role is checked while an ignored channel still wins', async () => {
  await save({ enforcedRoles: [mod],ignoredChannels: [otherChannel] }); context.roleIds=[mod]; await run(); assert.equal(deletes.length,1);
  context.parentId=otherChannel; await run(); assert.equal(deletes.length,1);
});
test('violations older than ten minutes cannot reach the timeout threshold', async () => {
  await save(); for(let i=0;i<4;i++) await run(message(),new Date(Date.now()-11*60000)); await run(); assert.equal(actions.length,0); assert.equal((await violations())[4]!.violation_count,1);
});
test('member counters are independent', async () => {
  await save(); for(let i=0;i<4;i++) await run(); await run(message('marutestword',actor)); assert.equal(actions.length,0);
  await run(); assert.equal(actions.length,1); assert.equal(actions[0]!.user,member);
});
test('the configured timeout duration is used and existing native timeouts are never shortened', async () => {
  await save({ timeoutSeconds: 3600 }); await five(); assert.equal((await cases())[0]!.duration_seconds,3600);
  await query('TRUNCATE automod_violations,automod_counters,automod_jobs'); context.timeoutUntil=new Date(Date.now()+86400000).toISOString(); actions=[];
  await five(); assert.equal(actions.length,0);
});
test('missing delete permissions defer work without recording a violation or native action', async () => {
  await save(); context.canDelete=false; await run(); assert.equal((await violations()).length,0); assert.equal(actions.length,0);
  context.canDelete=true; await retry(); assert.equal(deletes.length,1);
});
test('lost delete response is reconciled once without duplicating the violation', async () => {
  await save(); deleteFailure='after'; await run(); deleteFailure=undefined; await retry(); assert.equal(deletes.length,1); assert.equal((await violations()).length,1); assert.equal(sent.length,1);
});
test('audit failure before the deletion prevents every external action', async () => {
  await save(); failAudit='AUTOMOD_BLOCKED_WORD'; await run(); assert.equal(deletes.length,0); assert.equal((await violations()).length,0);
});
test('protected target or changed native permissions do not trigger a timeout', async () => {
  await save(); context.canTimeout=false; await five(); assert.equal(deletes.length,5); assert.equal(actions.length,0); assert.equal((await cases()).length,0);
});
test('roles assigned between removal and timeout prevent that native action', async () => {
  await save(); for(let i=0;i<4;i++) await run(); let calls=0; contextHook=async () => { if(++calls===2) context.roleIds=[mod]; };
  await run(); assert.equal(actions.length,0);
});
test('explicit native rejection leaves the window unreset and records a rejected case', async () => {
  await save(); nativeFailure='forbidden'; await five(); assert.equal((await cases())[0]!.action_status,'rejected');
  assert.equal((await violations())[4]!.violation_count,5); await run(); assert.equal(actions.length,1);
});
test('unconfirmed timeout is never blindly resent on a later violation', async () => {
  await save(); nativeFailure='network'; await five(); nativeFailure=undefined; await run(); assert.equal(actions.length,1); assert.equal((await cases())[0]!.action_status,'unconfirmed');
});
test('failed action-outcome audit verifies actual Discord state after restart without reapplying', async () => {
  await save(); failAudit='AUTOMOD_TIMEOUT_APPLIED'; await five(); assert.equal(actions.length,1); assert.equal((await cases())[0]!.action_status,'applying');
  failAudit=undefined; await retry(); assert.equal(actions.length,1); assert.equal((await cases())[0]!.action_status,'applied');
});
test('uncertain native claim acknowledgement never dispatches the timeout', async () => {
  await save(); failClaim=true; await five(); assert.equal(actions.length,0); assert.equal((await cases())[0]!.action_status,'pending');
});
test('a rejected log and lost log response never undo deletion or resend automatically', async () => {
  await save(); logFailure='network'; const value=await run(); await enqueue(value); await processAutoModJob(pool,guild,deps);
  assert.equal(sent.length,1); assert.equal((await violations())[0]!.log_status,'unconfirmed'); assert.equal(deletes.length,1);
});
test('job and case access stay scoped to the configured server', async () => {
  await save(); const value=message(); await enqueue(value); assert.equal(await processAutoModJob(pool,otherGuild,deps),false); assert.equal(deletes.length,0);
});
test('worker mutex prevents concurrent actions and unsafe unlock discards its connection', async () => {
  await save(); await enqueue(message()); busy=true; assert.equal(await processAutoModJob(pool,guild,deps),false); assert.equal(deletes.length,0);
  busy=false; failUnlock=true; await processAutoModJob(pool,guild,deps); assert.equal(discarded,true); failUnlock=false; await db.exec('SELECT pg_advisory_unlock_all()');
});
test('configuration save is Admin-only, atomic, revisioned and bounded', async () => {
  roles=[mod]; await assert.rejects(save(),/ADMIN_REQUIRED/); roles=[admin]; await save();
  await assert.rejects(save({ words: 'changed' }),/STALE_SETTINGS/);
  await assert.rejects(save({ revision: 1,enforcedRoles: [community] }),/INVALID_SELECTION/);
  await assert.rejects(save({ revision: 1,timeoutSeconds: 2419201 }),/INVALID_DURATION/);
  failAudit='AUTOMOD_SETTINGS_CHANGED'; await assert.rejects(save({ revision: 1,words: 'changed' }),/private audit/); assert.deepEqual((await readAutoModSettings(pool,guild)).blocked_words,['marutestword','bad phrase']);
});
test('expired session unavailable permissions and missing log destination prevent enabling', async () => {
  resources.canDelete=false; await assert.rejects(save(),/BOT_PERMISSIONS/); resources.canDelete=true;
  await query("UPDATE guild_settings SET settings='{}' WHERE guild_id=$1",[guild]); await assert.rejects(save(),/LOG_REQUIRED/);
  await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); await assert.rejects(save(),/SESSION_EXPIRED/);
});
test('unchanged settings do not create duplicate audit entries', async () => {
  await save(); await save({ revision: 1 }); const events=await query("SELECT * FROM audit_events WHERE event_type='AUTOMOD_SETTINGS_CHANGED'"); assert.equal(events.rows.length,1);
});
test('HTTP page is authenticated, Mods can view but cannot change settings', async () => {
  assert.equal((await request('/automod',{ headers: { cookie: '' } })).status,303);
  roles=[mod]; const html=await (await request('/automod')).text(); assert.match(html,/Only Admins/); assert.ok(!html.includes('Save AutoMod settings'));
  assert.equal((await post()).status,403);
});
test('HTTP form saves an enabled rule and refresh shows its current configuration', async () => {
  const response=await post(form({ words: 'marutestword, bad phrase' })); assert.equal(response.status,303); const html=await (await request('/automod')).text(); assert.match(html,/On · Revision 1/); assert.match(html,/marutestword, bad phrase/);
  assert.match(html,/Blocked words and phrases — separated by commas/);
  assert.deepEqual((await readAutoModSettings(pool,guild)).blocked_words,['marutestword','bad phrase']);
});
test('HTTP same origin exact fields session-purpose proofs and body limits protect settings', async () => {
  for(const origin of ['null','https://elsewhere.test','']) assert.equal((await post(form(),{ origin })).status,403);
  assert.equal((await post(form({ csrf: settingsProof(token) }))).status,403);
  const duplicate=form(); duplicate.append('revision','0'); assert.equal((await post(duplicate)).status,400);
  const foreign=form(); foreign.append('guild_id',otherGuild); assert.equal((await post(foreign)).status,400);
  assert.equal((await post('x'.repeat(131073))).status,413);
});
test('HTTP reauthorization blocks lost staff access and stale or expired forms', async () => {
  let count=0; readHook=async () => { if(++count===2) roles=[]; }; assert.equal((await post()).status,403);
  readHook=undefined; roles=[admin]; await save(); assert.equal((await post()).status,409);
});
test('HTML escapes blocked entries and role names', async () => {
  await save({ words: '<script>alert(1)</script>' }); resources.roles[0]!.name='<img src=x>';
  const html=await (await request('/automod')).text(); assert.ok(!html.includes('<script>alert')); assert.match(html,/&lt;script&gt;/); assert.ok(!html.includes('<img src=x>'));
});
test('gateway intake handles only configured-server content creates and edits, not bots or DMs', () => {
  const d={ guild_id: guild,id: '600000000000000001',channel_id: channel,content: 'marutestword' };
  assert.ok(parseAutoModEvent({ t: 'MESSAGE_CREATE',d },guild)); assert.ok(parseAutoModEvent({ t: 'MESSAGE_UPDATE',d },guild));
  for(const packet of [{ t: 'MESSAGE_CREATE',d: { ...d,guild_id: otherGuild } },{ t: 'MESSAGE_UPDATE',d: { ...d,content: undefined } },
    { t: 'MESSAGE_CREATE',d: { ...d,author: { bot: true } } },{ t: 'MESSAGE_DELETE',d },{ t: 'MESSAGE_CREATE',d: { ...d,webhook_id: actor } }]) assert.equal(parseAutoModEvent(packet,guild),undefined);
});
test('Discord adapter accepts an actual empty delete response and uses an absolute timeout', async () => {
  const { parseResponse }=await import('@discordjs/rest'); const calls: unknown[]=[];
  const writer={ delete: async () => parseResponse(new Response(null,{ status: 204 })),patch: async (route: string,options: { body: { communication_disabled_until: string }; signal: AbortSignal }) => {
    calls.push({ route,options }); return { user: { id: member },communication_disabled_until: options.body.communication_disabled_until };
  } } as unknown as Pick<REST,'get'|'delete'|'patch'|'post'>;
  const adapter=autoModDependencies({ user: { id: bot } } as Client,guild,'test-token',writer); await adapter.deleteMessage(channel,'600000000000000001');
  const until=new Date(Date.now()+600000).toISOString(); assert.deepEqual(await adapter.applyTimeout(member,until,1),{ targetId: member,until }); assert.equal(calls.length,1);
});
test('Discord adapter distinguishes missing messages from permission failures', async () => {
  const make=(code: number) => autoModDependencies({ user: { id: bot } } as Client,guild,'test-token',{ get: async () => { throw { code }; } } as unknown as Pick<REST,'get'|'delete'|'patch'|'post'>);
  assert.equal(await make(10008).readMessage(channel,'600000000000000001'),null); await assert.rejects(make(50001).readMessage(channel,'600000000000000001'));
});

test('disabling the filter stops queued messages before any deletion or punishment', async () => {
  await save(); const value=message(); await enqueue(value); await save({ revision: 1,enabled: false });
  await processAutoModJob(pool,guild,deps); assert.equal(deletes.length,0); assert.equal(actions.length,0);
});
test('removing an entry from the list stops its previously queued match', async () => {
  await save(); const value=message(); await enqueue(value); await save({ revision: 1,words: 'different word' });
  await processAutoModJob(pool,guild,deps); assert.equal(deletes.length,0);
});
test('an existing queued violation can be disabled without requiring deleted selection resources', async () => {
  await save({ ignoredChannels: [otherChannel] }); resources.channels=resources.channels.filter((entry) => entry.id!==otherChannel);
  await save({ revision: 1,enabled: false,ignoredChannels: [otherChannel] }); assert.equal((await readAutoModSettings(pool,guild)).blocked_enabled,false);
});
test('an unconfigured member-native hierarchy cannot be bypassed by full staff grants', async () => {
  await save(); context.canTimeout=false; await query('INSERT INTO staff_access_grants (guild_id,user_id,granted_by) VALUES ($1,$2,$3)',[guild,member,actor]);
  await five(); assert.equal(actions.length,0);
});
test('a confirmed native timeout recovered on a later violation resets only the blocked-word counter', async () => {
  await save(); nativeFailure='after'; await five(); assert.equal((await cases())[0]!.action_status,'unconfirmed');
  nativeFailure=undefined; await run(); assert.equal(actions.length,1); assert.equal((await cases())[0]!.action_status,'applied');
});
test('an expired unconfirmed request no longer blocks a later new automatic timeout', async () => {
  await save(); nativeFailure='network'; await five(); nativeFailure=undefined;
  await query("UPDATE moderation_cases SET requested_until=NOW()-INTERVAL '1 second'");
  await query("UPDATE automod_counters SET last_attempt_at=NOW()-INTERVAL '61 seconds'");
  await run(); assert.equal(actions.length,2); assert.equal((await cases()).length,2); assert.equal((await cases())[0]!.action_status,'unconfirmed');
});
test('timeout-intent audit failure prevents native dispatch and rolls back case allocation', async () => {
  await save(); failAudit='AUTOMOD_TIMEOUT_REQUESTED'; await five(); assert.equal(actions.length,0); assert.equal((await cases()).length,0);
  failAudit=undefined; await retry(); assert.equal(actions.length,1); assert.equal((await cases())[0]!.case_number,1);
});
test('automatic timeout case uses the shared case sequence rather than a separate counter', async () => {
  await save(); await query(`INSERT INTO moderation_cases (guild_id,case_number,request_id,action,actor_id,target_user_id,reason,guild_name)
    VALUES ($1,1,'previous-warning','warning',$2,$3,'Earlier manual warning','Development')`,[guild,actor,member]);
  await query('INSERT INTO guild_case_counters (guild_id,last_case_number) VALUES ($1,1)',[guild]); await five(); assert.equal((await cases())[1]!.case_number,2);
});
test('case log outcome failure never repeats the actual deletion timeout or log', async () => {
  await save(); for(let i=0;i<4;i++) await run(); failAudit='AUTOMOD_LOG_SENT'; await run();
  const before=sent.length; failAudit=undefined; await retry(); assert.equal(sent.length,before); assert.equal(actions.length,1); assert.equal((await cases())[0]!.log_status,'sending');
});
test('native timeout verification only accepts the requested target and exact end', async () => {
  await save(); const bad={ ...deps,applyTimeout: async () => ({ targetId: actor,until: null }) };
  for(let i=0;i<5;i++) { const value=message(); await enqueue(value); await processAutoModJob(pool,guild,bad); }
  assert.equal((await cases())[0]!.action_status,'unconfirmed');
});
test('enabled settings validate duplicate IDs and same-server resources', async () => {
  await assert.rejects(save({ exemptRoles: [admin,admin] }),/INVALID_SELECTION/);
  await assert.rejects(save({ ignoredChannels: ['500000000000000099'] }),/INVALID_SELECTION/);
  await assert.rejects(save({ exemptRoles: ['200000000000000099'] }),/INVALID_SELECTION/);
});
test('old manual case inserts remain compatible with the new origin column', async () => {
  await query(`INSERT INTO moderation_cases (guild_id,case_number,request_id,action,actor_id,target_user_id,reason,guild_name)
    VALUES ($1,1,'old-insert','warning',$2,$3,'Legacy insert','Development')`,[guild,actor,member]);
  assert.equal((await cases())[0]!.origin,'manual');
});
test('the actual rendered AutoMod form has a working session and revision proof', async () => {
  const page=await request('/automod'); const html=await page.text();
  assert.equal(page.headers.get('referrer-policy'),'same-origin'); assert.ok(html.includes(`name="csrf" value="${autoModProof(token,0)}"`));
  assert.equal((await post(form({ csrf: autoModProof(token,0) }))).status,303);
});
test('server configuration and other moderation settings are preserved by AutoMod edits', async () => {
  await save(); const global=(await query('SELECT settings FROM guild_settings WHERE guild_id=$1',[guild])).rows[0] as { settings: Record<string,unknown> };
  assert.equal(global.settings.moderation_log_channel_id,logs); assert.equal((await cases()).length,0);
});
test('raw intake never persists benign message content or creates jobs for a whole-word false positive', async () => {
  await save(); await enqueue(message('This marutestwordy message is fine')); assert.equal((await query('SELECT * FROM automod_jobs')).rows.length,0);
});

test('a second five-violation window can trigger immediately after a moderator removes a successful timeout', async () => {
  await save(); await five(); context.timeoutUntil=null; await five(); assert.equal(actions.length,2); assert.equal((await cases()).length,2);
});
test('fresh Discord permission context protects owners and Administrators and resolves thread parents', async () => {
  let nativeAdmin=true; const target={ id: member,user: { bot: false },roles: { cache: new Map([[mod,{}]]),highest: {} },
    permissions: { has: () => nativeAdmin },communicationDisabledUntil: null };
  const me={ roles: { highest: { comparePositionTo: () => 1 } },permissions: { has: () => true } };
  const fakeGuild={ ownerId: actor,name: 'Development',roles: { fetch: async () => {} },members: { fetchMe: async () => me,fetch: async () => target },
    channels: { fetch: async () => ({ isTextBased: () => true,isThread: () => true,parentId: otherChannel,permissionsFor: () => ({ has: () => true }) }) } };
  const client={ user: { id: bot },guilds: { fetch: async () => fakeGuild } } as unknown as Client;
  const adapter=autoModDependencies(client,guild,'test-token');
  const adminContext=await adapter.readContext(channel,member); assert.equal(adminContext.canTimeout,false); assert.equal(adminContext.parentId,otherChannel);
  nativeAdmin=false; assert.equal((await adapter.readContext(channel,member)).canTimeout,true); assert.equal((await adapter.readContext(channel,actor)).owner,true);
});
test('saved words and permissions remain server-scoped on a foreign settings POST', async () => {
  await assert.rejects(save({ guildId: otherGuild }),/SESSION_EXPIRED/); assert.equal((await readAutoModSettings(pool,guild)).blocked_enabled,false);
});

test('gateway resume timestamps and real edit timestamps preserve rolling-window timing', () => {
  const created=new Date(Date.now()-20*60000).toISOString(),edited=new Date(Date.now()-60000).toISOString();
  const d={ guild_id: guild,id: '600000000000000001',channel_id: channel,content: 'marutestword',timestamp: created,edited_timestamp: edited };
  assert.equal(parseAutoModEvent({ t: 'MESSAGE_CREATE',d },guild)!.eventAt.toISOString(),created);
  assert.equal(parseAutoModEvent({ t: 'MESSAGE_UPDATE',d },guild)!.eventAt.toISOString(),edited);
  assert.equal(parseAutoModEvent({ t: 'MESSAGE_CREATE',d: { ...d,timestamp: 'invalid' } },guild),undefined);
});

test('duplicate threshold events preserve the original count snapshot after a successful reset', async () => {
  await save(); await five(); const last=(await violations())[4]!;
  await enqueueAutoModCandidates(pool,guild,[{ messageId: String(last.message_id),channelId: channel,content: 'marutestword',eventAt: new Date() }]);
  await processAutoModJob(pool,guild,deps); assert.equal((await violations())[4]!.violation_count,5); assert.equal(actions.length,1);
});
test('a pending undispatched timeout is rejected if its original violation window has elapsed', async () => {
  await save({ timeoutSeconds: 86400 }); failClaim=true; await five(); assert.equal(actions.length,0);
  await query("UPDATE automod_violations SET occurred_at=NOW()-INTERVAL '11 minutes'"); failClaim=false; await retry();
  assert.equal(actions.length,0); assert.equal((await cases())[0]!.action_status,'rejected'); assert.equal((await cases())[0]!.action_error,'VIOLATION_WINDOW_EXPIRED');
});
test('disabling the rule cancels a saved but undispatched timeout', async () => {
  await save(); failClaim=true; await five(); failClaim=false; await save({ revision: 1,enabled: false }); await retry();
  assert.equal(actions.length,0); assert.equal((await cases())[0]!.action_status,'rejected');
});

test('a previously detected but unremoved message is rechecked against a new entry after an edit', async () => {
  await save(); const value=message();
  await query(`INSERT INTO automod_violations (guild_id,message_id,channel_id,user_id,occurred_at,matched_entries,log_channel_id)
    VALUES ($1,$2,$3,$4,NOW()-INTERVAL '11 minutes',ARRAY['olderterm'],$5)`,[guild,value.id,channel,member,logs]);
  await enqueue(value); await processAutoModJob(pool,guild,deps);
  assert.equal(deletes.length,1); assert.equal((await violations()).length,1); assert.equal((await violations())[0]!.violation_count,1);
  assert.deepEqual((await violations())[0]!.matched_entries,['marutestword']);
});
