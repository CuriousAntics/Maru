import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { APIMessage, Client, REST, RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { autoModProof, autoModSectionProof, digest, randomToken, settingsProof } from '../src/web-security.js';
import { AutoModError, autoModExempt, readAutoModSettings, saveAutoModSettings } from '../src/automod-settings.js';
import type { AutoModResources } from '../src/automod-settings.js';
import { matchBlockedWords, parseBlockedWords } from '../src/blocked-words.js';
import { enqueueAutoModCandidates, parseAutoModEvent, processAutoModJob } from '../src/automod-worker.js';
import type { AutoModContext, AutoModDependencies, AutoModMessage } from '../src/automod-engine.js';
import { autoModDependencies, imageUploads } from '../src/automod-discord.js';
import { createImageFingerprinter, trustedImageUrl, imageByteLimit, messageImageByteLimit } from '../src/image-fingerprints.js';
import type { AutoModImage } from '../src/image-fingerprints.js';
import { repeatedTextKey } from '../src/repeated-messages.js';
import { caseSummary } from '../src/handle-warning.js';
import type { WarningCase } from '../src/warnings.js';

const db=new PGlite();
const guild='100000000000000001',otherGuild='100000000000000002';
const admin='200000000000000001',mod='200000000000000002',community='200000000000000003';
const actor='300000000000000001',member='300000000000000002',bot='300000000000000003';
const channel='500000000000000001',logs='500000000000000002',otherChannel='500000000000000003';
let messageId=600000000000000000n;
let token=randomToken(),roles: string[] | null,resources: AutoModResources;
let connectHook: (() => Promise<void>) | undefined;
let failAudit: string | undefined,failClaim=false,busy=false,failUnlock=false,discarded=false,transaction=false;
async function query(sql: string,values?: unknown[]) {
  if(busy && sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }],rowCount: 1 };
  if(failUnlock && (sql.includes('pg_advisory_unlock_all') || sql.includes('pg_advisory_unlock('))) throw new Error('unlock failed');
  if(failClaim && sql.includes("SET action_status='applying'")) throw new Error('claim lost');
  if(failAudit && (sql.includes(`'${failAudit}'`) || values?.[2]===failAudit)) throw new Error('private audit diagnostic');
  const result=await db.query(sql,values); if(sql==='BEGIN') transaction=true; if(['ROLLBACK','COMMIT'].includes(sql)) transaction=false;
  return { rows: result.rows,rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool={ query,async connect() { const hook=connectHook; connectHook=undefined; await hook?.(); return { query,release(error?: Error) { if(error) discarded=true; } }; } } as unknown as Pool;
let readHook: (() => Promise<void>) | undefined;
const readRoles=async () => { await readHook?.(); return roles; };
const readResources=async () => resources;
function settings(overrides: Record<string,unknown>={}) {
  return { guildId: guild,actorId: actor,token,revision: 0,enabled: true,words: 'marutestword\nbad phrase',timeoutSeconds: 600,
    exemptRoles: [admin,mod],ignoredChannels: [],enforcedRoles: [],enforcedChannels: [],reason: 'Configure development filter',readRoles,readResources,...overrides };
}
async function save(overrides: Record<string,unknown>={}) { return saveAutoModSettings(pool,settings(overrides)); }
let imageData=new Map<string,Uint8Array>(),imageRequests: string[]=[];
let fingerprintImages=createImageFingerprinter();
let context: AutoModContext;
let messages: Map<string,AutoModMessage>;
let nativeFailure: 'network'|'forbidden'|'after'|undefined,logFailure: 'network'|'forbidden'|undefined;
let deleteFailure: 'before'|'after'|undefined;
let actions: { user: string; until: string; number: number }[],sent: RESTPostAPIChannelMessageJSONBody[],deletes: string[];
let contextHook: (() => Promise<void>) | undefined;
const deps: AutoModDependencies={ imageFingerprints: async (value) => fingerprintImages(value),botId: () => bot,
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
async function request(path: string,init: RequestInit={}) { return fetch(base+path,{ ...init,redirect: 'manual',headers: { connection: 'close',cookie: `maru_session=${token}`,...init.headers } }); }
function form(overrides: Record<string,string>={}) { return new URLSearchParams({ csrf: autoModProof(token,0),revision: '0',enabled: 'true',words: 'marutestword',timeout: '10m',reason: 'Enable test rule',exempt_role: admin,...overrides }); }
async function post(body: URLSearchParams | string=form(),headers: Record<string,string>={}) { return request('/automod',{ method: 'POST',body,headers: { origin: base,'content-type': 'application/x-www-form-urlencoded',...headers } }); }
before(async () => {
  for(const name of ['001_foundation.sql','002_dashboard_auth.sql','003_moderation_warnings.sql','004_case_changes.sql','005_timeouts.sql','006_bans.sql','010_blocked_words.sql','011_rapid_messages.sql','012_repeated_messages.sql']) await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  connectHook=undefined; failAudit=undefined; failClaim=busy=failUnlock=discarded=transaction=false; readHook=contextHook=undefined;
  imageData=new Map(); imageRequests=[]; fingerprintImages=createImageFingerprinter((async (url) => { const address=String(url); imageRequests.push(address); const bytes=imageData.get(new URL(address).pathname.split('/')[3]!); if(!bytes) throw new Error('Image unavailable'); return new Response(Buffer.from(bytes)); }) as typeof fetch);
  nativeFailure=logFailure=deleteFailure=undefined; actions=[]; sent=[]; deletes=[]; messages=new Map(); token=randomToken(); roles=[admin]; ready=true;
  resources={ roles: [{ id: admin,name: 'Admin' },{ id: mod,name: 'Mods' },{ id: community,name: 'Community Manager' }],
    channels: [{ id: channel,name: 'general' },{ id: logs,name: 'logs' },{ id: otherChannel,name: 'finished-work' }],canDelete: true,canTimeout: true };
  context={ guildName: 'Maru Development',roleIds: [],parentId: null,owner: false,canDelete: true,canTimeout: true,timeoutUntil: null };
  await db.exec('SELECT pg_advisory_unlock_all()');
  await db.exec('TRUNCATE automod_repeat_activity,automod_message_activity,automod_counters,automod_violations,automod_jobs,automod_settings,moderation_cases,guild_case_counters,dashboard_sessions,dashboard_login_attempts,audit_events,staff_access_grants,staff_roles,guild_settings RESTART IDENTITY');
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
  assert.equal(page.headers.get('referrer-policy'),'same-origin'); assert.ok(html.includes(`name="csrf" value="${autoModSectionProof(token,0,'blocked_words')}"`));
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

async function spamSave(overrides: Record<string,unknown>={}) {
  await save({ enabled: false,spamEnabled: true,spamLimit: 5,spamWindowSeconds: 5,spamTimeoutSeconds: 600,spamEnforcedRoles: [],spamEnforcedChannels: [],...overrides });
}
async function rapid(value=message('ordinary conversation'),at=new Date()) {
  await enqueueAutoModCandidates(pool,guild,[{ messageId: value.id,channelId: value.channelId,content: value.content,eventAt: at,isCreate: true }]);
  await processAutoModJob(pool,guild,deps); return value;
}
async function burst(n: number,at=new Date()) { for(let i=0;i<n;i++) await rapid(message('ordinary conversation'),at); }
async function spamViolations() { return (await violations()).filter((v) => v.rule_key==='rapid_messages'); }
test('rapid messages default Off and reject out-of-range limits, windows and durations', async () => {
  const initial=await readAutoModSettings(pool,guild); assert.equal(initial.spam_enabled,false); assert.equal(initial.spam_limit,5); assert.equal(initial.spam_window_seconds,5);
  for(const fields of [{ spamLimit: 1 },{ spamLimit: 51 },{ spamWindowSeconds: 0 },{ spamWindowSeconds: 61 },{ spamTimeoutSeconds: 2419201 },{ spamLimit: 3.5 }]) await assert.rejects(spamSave(fields),/INVALID_SPAM/);
  assert.equal((await query('SELECT * FROM automod_settings')).rows.length,0);
});
test('five human creates are allowed; the sixth and further eligible messages are deleted and logged', async () => {
  await spamSave(); await burst(5); assert.equal(deletes.length,0); await rapid(); await rapid();
  assert.equal(deletes.length,2); assert.equal((await spamViolations()).length,2); assert.equal(actions.length,0);
  const log=sent[0]!; assert.equal(log.embeds![0]!.title,'Rapid-message violation'); assert.deepEqual(log.allowed_mentions,{ parse: [] }); assert.ok(!JSON.stringify(log).includes('ordinary conversation'));
});
test('spam uses a configurable rolling window, excludes its left boundary and allows a later quiet message', async () => {
  await spamSave({ spamLimit: 2,spamWindowSeconds: 2 }); const at=new Date(Date.now()-3000);
  await rapid(message('first'),at); await rapid(message('second'),at);
  await rapid(message('boundary'),new Date(at.getTime()+2000)); assert.equal(deletes.length,0);
  await rapid(message('fourth'),new Date(at.getTime()+2001)); await rapid(message('fifth'),new Date(at.getTime()+2002)); assert.equal(deletes.length,1);
});
test('rapid-message counts span eligible channels but not members', async () => {
  await spamSave({ spamLimit: 2 }); await rapid(); const cross=message('cross channel'); cross.channelId=otherChannel; await rapid(cross);
  await rapid(message('other member',actor)); assert.equal(deletes.length,0); await rapid(); assert.equal(deletes.length,1);
});
test('duplicate creates and edits cannot inflate traffic or repeat deletion and log', async () => {
  await spamSave({ spamLimit: 2 }); const first=await rapid(); for(let i=0;i<4;i++) await rapid(first); await rapid(); assert.equal(deletes.length,0);
  const last=await rapid(); assert.equal(deletes.length,1); for(let i=0;i<3;i++) { await enqueue(last); await retry(); }
  assert.equal((await query('SELECT * FROM automod_message_activity')).rows.length,3); assert.equal(deletes.length,1); assert.equal(sent.length,1);
});
test('spam-only content edits are not ingested as new messages', async () => {
  await spamSave(); for(let i=0;i<10;i++) await enqueue(message('changed content'));
  assert.equal((await query('SELECT * FROM automod_jobs')).rows.length,0);
});
test('ignored channels and roles do not contribute to rapid-message counts; overrides are independent', async () => {
  await spamSave({ spamLimit: 2,ignoredChannels: [otherChannel] });
  for(let i=0;i<6;i++) { const m=message('ignored'); m.channelId=otherChannel; await rapid(m); }
  context.roleIds=[mod]; await burst(6); context.roleIds=[]; await burst(2);
  assert.equal(deletes.length,0); assert.equal((await query('SELECT * FROM automod_message_activity')).rows.length,2); await rapid(); assert.equal(deletes.length,1);
});
test('rapid-message role overrides do not change blocked-word exemptions', async () => {
  await spamSave({ enabled: true,spamLimit: 2,spamEnforcedRoles: [mod] }); context.roleIds=[mod];
  await rapid(message()); await rapid(message()); await rapid(message());
  assert.equal(deletes.length,1); assert.equal((await violations()).length,1); assert.equal((await violations())[0]!.rule_key,'rapid_messages');
});
test('rapid-message channel overrides include threads but retain exempt roles', async () => {
  await spamSave({ spamLimit: 2,ignoredChannels: [otherChannel],spamEnforcedChannels: [otherChannel] }); context.parentId=otherChannel;
  await burst(3); assert.equal(deletes.length,1); context.roleIds=[mod]; await burst(3); assert.equal(deletes.length,1);
});
test('bots webhooks and the guild owner never build rapid-message history', async () => {
  await spamSave({ spamLimit: 2 }); const b=message(); b.bot=true; await rapid(b); const w=message(); w.webhook=true; await rapid(w);
  context.owner=true; await burst(4); assert.equal((await query('SELECT * FROM automod_message_activity')).rows.length,0); assert.equal(deletes.length,0);
});
test('fifth spam violation times out using its own duration and resets only its own counter', async () => {
  await spamSave({ enabled: true,spamTimeoutSeconds: 60 }); await run(); await burst(10);
  assert.equal(actions.length,1); const records=await cases(); assert.equal(records.length,1); assert.equal(records[0]!.duration_seconds,60); assert.match(records[0]!.reason,/rapid-message/);
  const counters=(await query('SELECT * FROM automod_counters ORDER BY rule_key')).rows as { rule_key: string; reset_at: unknown }[];
  assert.equal(counters.length,2); const blockedCount=(await query("SELECT count(*)::int AS n FROM automod_violations WHERE rule_key='blocked_words' AND delete_status='removed'")).rows[0] as { n: number }; assert.equal(blockedCount.n,1);
  assert.equal(sent.at(-1)!.embeds![0]!.fields!.find((f) => f.name==='Timeout result')!.value,'Timeout applied');
});
test('one message can violate both rules without duplicate cases or cross-rule log nonces', async () => {
  await spamSave({ enabled: true,spamLimit: 2 }); await rapid(message()); await rapid(message()); await rapid(message());
  const last=(await violations()).filter((v) => v.message_id===String(messageId)); assert.equal(last.length,2); assert.equal(deletes.length,3);
  assert.equal(new Set(sent.map((body) => body.nonce)).size,sent.length); assert.equal(actions.length,0);
});
test('a blocked-word timeout does not also apply a spam timeout to an already timed-out member', async () => {
  await spamSave({ enabled: true,spamLimit: 2 }); for(let i=0;i<7;i++) await rapid(message());
  assert.equal(actions.length,1); assert.equal((await cases()).length,1); assert.ok((await spamViolations()).length>=5);
});
test('rapid-message deletion can recover a lost response without counting or logging twice', async () => {
  await spamSave({ spamLimit: 2 }); await burst(2); deleteFailure='after'; await rapid(); assert.equal(deletes.length,1); deleteFailure=undefined; await retry();
  assert.equal(deletes.length,1); assert.equal((await spamViolations()).length,1); assert.equal(sent.length,1);
});
test('rapid-message deletion requires fresh permissions and later retries remain idempotent', async () => {
  await spamSave({ spamLimit: 2 }); await burst(2); context.canDelete=false; await rapid(); assert.equal(deletes.length,0); assert.equal((await spamViolations()).length,0);
  context.canDelete=true; await retry(); assert.equal(deletes.length,1);
});
test('rapid-message timeout response loss stays unconfirmed and is not resent', async () => {
  await spamSave(); nativeFailure='network'; await burst(10); assert.equal(actions.length,1); await rapid(); assert.equal(actions.length,1);
  assert.equal((await cases())[0]!.action_status,'unconfirmed');
});
test('rapid-message audit failure prevents deletion and retry uses saved traffic evidence', async () => {
  await spamSave({ spamLimit: 2 }); await burst(2); failAudit='AUTOMOD_RAPID_MESSAGE'; await rapid(); assert.equal(deletes.length,0); assert.equal(sent.length,0);
  failAudit=undefined; await retry(); assert.equal(deletes.length,1);
});
test('settings changes start a fresh traffic window and disable queued spam deletions', async () => {
  await spamSave({ spamLimit: 2 }); await burst(2);
  const m=message('queued'); await enqueueAutoModCandidates(pool,guild,[{ messageId: m.id,channelId: channel,content: m.content,eventAt: new Date(),isCreate: true }]);
  await save({ enabled: false,revision: 1,spamEnabled: false }); await processAutoModJob(pool,guild,deps); assert.equal(deletes.length,0);
  await save({ enabled: false,revision: 2,spamEnabled: true }); await rapid(); assert.equal(deletes.length,0);
});
test('old replayed and future-dated creates do not build spam history or cause punishment', async () => {
  await spamSave({ spamLimit: 2 }); for(let i=0;i<4;i++) await rapid(message(),new Date(Date.now()-700000)); for(let i=0;i<4;i++) await rapid(message(),new Date(Date.now()+60000));
  assert.equal(deletes.length,0); assert.equal((await query('SELECT * FROM automod_message_activity')).rows.length,0);
});
test('rapid-message settings require Admin access, permissions and logging even when blocked words are Off', async () => {
  resources.canTimeout=false; await assert.rejects(spamSave(),/BOT_PERMISSIONS/); resources.canTimeout=true;
  roles=[mod]; await assert.rejects(spamSave(),/ADMIN_REQUIRED/); roles=[admin]; await query("UPDATE guild_settings SET settings='{}'"); await assert.rejects(spamSave(),/LOG_REQUIRED/);
});
test('HTTP spam settings save atomically, render on refresh and reject duplicate or incomplete inputs', async () => {
  const fields={ spam_enabled: 'true',spam_limit: '4',spam_window: '8',spam_timeout: '1m' };
  assert.equal((await post(form(fields))).status,303); const saved=await readAutoModSettings(pool,guild); assert.equal(saved.spam_limit,4); assert.equal(saved.spam_window_seconds,8); assert.equal(saved.spam_timeout_seconds,60);
  const html=await (await request('/automod')).text(); assert.match(html,/Enable rapid-message filtering/); assert.match(html,/Rapid messages: On/);
  assert.equal((await post(form({ revision: '1',csrf: autoModProof(token,1),...fields,spam_limit: '99' }))).status,400);
  const duplicate=form({ revision: '1',csrf: autoModProof(token,1),...fields }); duplicate.append('spam_limit','5'); assert.equal((await post(duplicate)).status,400);
  assert.equal((await post(form({ revision: '1',csrf: autoModProof(token,1),spam_enabled: 'true' }))).status,400);
});
test('HTTP rejects legacy open forms when spam is enabled and enforces current session and origin', async () => {
  await spamSave(); assert.equal((await post(form({ revision: '1',csrf: autoModProof(token,1) }))).status,409);
  assert.equal((await post(form({ spam_enabled: 'true',spam_limit: '5',spam_window: '5',spam_timeout: '1m' }),{ origin: 'null' })).status,403);
});
test('an unresolved blocked-word timeout also blocks native timeout dispatch from the spam rule', async () => {
  await spamSave({ enabled: true,spamLimit: 2 }); nativeFailure='network'; for(let i=0;i<7;i++) await rapid(message());
  assert.equal(actions.length,1); assert.equal((await cases()).length,1); assert.match(String((await spamViolations()).at(-1)!.timeout_note),/unresolved timeout/);
});
test('changing rate settings cancels an undispatched spam violation from the previous revision', async () => {
  await spamSave({ spamLimit: 2 }); await burst(2); deleteFailure='before'; await rapid(); assert.equal((await spamViolations()).length,1); const attempted=deletes.length;
  deleteFailure=undefined; await save({ enabled: false,revision: 1,spamLimit: 20 }); await retry(); assert.equal(deletes.length,attempted); assert.equal(actions.length,0);
});
test('persisted rate evidence survives a blocked-word deletion and failed spam audit before retry', async () => {
  await spamSave({ enabled: true,spamLimit: 2 }); await rapid(message()); await rapid(message()); failAudit='AUTOMOD_RAPID_MESSAGE';
  const value=await rapid(message()); assert.equal(messages.has(value.id),false); failAudit=undefined; await retry();
  assert.equal((await spamViolations()).length,1); assert.equal(deletes.length,3); assert.equal(sent.length,4);
});
test('a create followed by a matching edit retains its creation time for traffic and edit time for blocked words', async () => {
  await spamSave({ enabled: true,spamLimit: 2 }); const value=message('ordinary'); const created=new Date(Date.now()-1000),edited=new Date();
  await enqueueAutoModCandidates(pool,guild,[{ messageId: value.id,channelId: channel,content: value.content,eventAt: created,isCreate: true }]);
  value.content='marutestword'; await enqueueAutoModCandidates(pool,guild,[{ messageId: value.id,channelId: channel,content: value.content,eventAt: edited,isCreate: false }]);
  await processAutoModJob(pool,guild,deps);
  const observation=(await query('SELECT occurred_at FROM automod_message_activity')).rows[0] as { occurred_at: Date };
  assert.equal(new Date(observation.occurred_at).getTime(),created.getTime()); assert.equal(new Date((await violations())[0]!.occurred_at as string).getTime(),edited.getTime());
});
test('spam overrides require global selection and full-access grants still require current staff roles', async () => {
  await assert.rejects(spamSave({ spamEnforcedRoles: [community] }),/INVALID_SELECTION/);
  await assert.rejects(spamSave({ spamEnforcedChannels: [channel] }),/INVALID_SELECTION/);
  roles=[]; await assert.rejects(spamSave(),/ADMIN_REQUIRED/);
});
test('unprocessed creates cannot enter a newer settings revision after a limit change', async () => {
  await spamSave({ spamLimit: 2 }); const at=new Date();
  for(let i=0;i<5;i++) { const v=message('queued'); await enqueueAutoModCandidates(pool,guild,[{ messageId: v.id,channelId: channel,content: v.content,eventAt: at,isCreate: true }]); }
  await save({ enabled: false,revision: 1,spamTimeoutSeconds: 60 }); while(await processAutoModJob(pool,guild,deps)) { /* drain */ }
  assert.equal(deletes.length,0); assert.equal((await query('SELECT * FROM automod_message_activity')).rows.length,0);
});
test('creates queued while spam is Off cannot count when the rule is enabled before processing', async () => {
  await save(); const at=new Date();
  for(let i=0;i<5;i++) { const v=message(); await enqueueAutoModCandidates(pool,guild,[{ messageId: v.id,channelId: channel,content: v.content,eventAt: at,isCreate: true }]); }
  await save({ enabled: false,revision: 1,spamEnabled: true,spamLimit: 2 }); while(await processAutoModJob(pool,guild,deps)) { /* drain */ }
  assert.equal(deletes.length,0); assert.equal((await query('SELECT * FROM automod_message_activity')).rows.length,0);
});

function sectionForm(section: string,revision=0,overrides: Record<string,string>={}) {
  const defaults: Record<string,Record<string,string>>={ blocked_words: { enabled: 'true',words: 'newword, another phrase',timeout: '2m' },rapid_messages: { spam_enabled: 'true',spam_limit: '3',spam_window: '8',spam_timeout: '1m' },exemptions: { exempt_role: admin,ignored_channel: otherChannel } };
  return new URLSearchParams({ section,revision: String(revision),csrf: autoModSectionProof(token,revision,section),reason: 'Save this section',...defaults[section],...overrides });
}
test('AutoMod renders four independent forms with distinct save buttons and section proofs', async () => {
  const html=await (await request('/automod')).text(); const forms=[...html.matchAll(/<form method="post" action="\/automod">([\s\S]*?)<\/form>/g)].map((match) => match[1]!);
  assert.equal(forms.length,4);
  for(const [index,section] of ['blocked_words','rapid_messages','repeated_messages','exemptions'].entries()) {
    assert.ok(forms[index]!.includes(`name="section" value="${section}"`)); assert.ok(forms[index]!.includes(autoModSectionProof(token,0,section))); assert.ok(forms[index]!.includes('name="reason"'));
  }
  assert.match(forms[0]!,/Save blocked words/); assert.ok(!forms[0]!.includes('name="spam_limit"')); assert.ok(!forms[0]!.includes('name="exempt_role"'));
  assert.match(forms[1]!,/Save rapid messaging/); assert.ok(!forms[1]!.includes('name="words"'));
  assert.match(forms[2]!,/Save repeated messages/); assert.ok(!forms[2]!.includes('name="words"'));
  assert.match(forms[3]!,/Save shared exemptions/); assert.ok(!forms[3]!.includes('name="enabled"'));
});
test('saving blocked words preserves every rapid-message setting and shared exemption', async () => {
  await spamSave({ enabled: true,spamLimit: 7,spamWindowSeconds: 12,spamTimeoutSeconds: 120,ignoredChannels: [otherChannel],spamEnforcedRoles: [mod],spamEnforcedChannels: [otherChannel] });
  const before=await readAutoModSettings(pool,guild); assert.equal((await post(sectionForm('blocked_words',1))).status,303);
  const after=await readAutoModSettings(pool,guild); assert.deepEqual(after.blocked_words,['newword','another phrase']); assert.equal(after.timeout_seconds,120);
  for(const key of ['spam_enabled','spam_limit','spam_window_seconds','spam_timeout_seconds','spam_enforced_role_ids','spam_enforced_channel_ids','exempt_role_ids','ignored_channel_ids'] as const) assert.deepEqual(after[key],before[key]);
});
test('saving rapid messaging preserves all blocked-word fields and shared exemptions', async () => {
  await save({ enabled: true,enforcedRoles: [mod],ignoredChannels: [otherChannel],enforcedChannels: [otherChannel] }); const before=await readAutoModSettings(pool,guild);
  assert.equal((await post(sectionForm('rapid_messages',1))).status,303); const after=await readAutoModSettings(pool,guild);
  assert.equal(after.spam_enabled,true); assert.equal(after.spam_limit,3); assert.equal(after.spam_window_seconds,8); assert.equal(after.spam_timeout_seconds,60);
  for(const key of ['blocked_enabled','blocked_words','timeout_seconds','enforced_role_ids','enforced_channel_ids','exempt_role_ids','ignored_channel_ids'] as const) assert.deepEqual(after[key],before[key]);
});
test('an unchecked section toggle disables only the selected rule', async () => {
  await spamSave({ enabled: true }); const blocked=sectionForm('blocked_words',1); blocked.delete('enabled'); assert.equal((await post(blocked)).status,303);
  let current=await readAutoModSettings(pool,guild); assert.equal(current.blocked_enabled,false); assert.equal(current.spam_enabled,true);
  const spam=sectionForm('rapid_messages',2); spam.delete('spam_enabled'); assert.equal((await post(spam)).status,303);
  current=await readAutoModSettings(pool,guild); assert.equal(current.spam_enabled,false); assert.equal(current.blocked_enabled,false);
});
test('shared-exemption saves preserve rule configuration and prune only overrides for removed exemptions', async () => {
  await spamSave({ enabled: true,enforcedRoles: [mod],spamEnforcedRoles: [mod],ignoredChannels: [otherChannel],enforcedChannels: [otherChannel],spamEnforcedChannels: [otherChannel] });
  const before=await readAutoModSettings(pool,guild); const form=sectionForm('exemptions',1); form.delete('ignored_channel');
  assert.equal((await post(form)).status,303); const after=await readAutoModSettings(pool,guild);
  assert.deepEqual(after.exempt_role_ids,[admin]); assert.deepEqual(after.ignored_channel_ids,[]); assert.deepEqual(after.enforced_role_ids,[]); assert.deepEqual(after.spam_enforced_role_ids,[]); assert.deepEqual(after.enforced_channel_ids,[]); assert.deepEqual(after.spam_enforced_channel_ids,[]);
  for(const key of ['blocked_enabled','blocked_words','timeout_seconds','spam_enabled','spam_limit','spam_window_seconds','spam_timeout_seconds'] as const) assert.deepEqual(after[key],before[key]);
});
test('section saves reject another section proof and fields from a different form', async () => {
  assert.equal((await post(sectionForm('rapid_messages',0,{ csrf: autoModSectionProof(token,0,'blocked_words') }))).status,403);
  assert.equal((await post(sectionForm('rapid_messages',0,{ csrf: autoModProof(token,0) }))).status,403);
  assert.equal((await post(sectionForm('blocked_words',0,{ spam_limit: '9' }))).status,400);
  assert.equal((await post(sectionForm('rapid_messages',0,{ exempt_role: mod }))).status,400);
  for(const section of ['unknown','__proto__','constructor']) assert.equal((await post(sectionForm(section))).status,400);
  assert.equal((await query('SELECT * FROM automod_settings')).rows.length,0);
});
test('section saves reject duplicate missing and invalid fields before any write', async () => {
  const duplicated=sectionForm('blocked_words'); duplicated.append('section','blocked_words'); assert.equal((await post(duplicated)).status,400);
  const missing=sectionForm('rapid_messages'); missing.delete('spam_timeout'); assert.equal((await post(missing)).status,400);
  assert.equal((await post(sectionForm('blocked_words',0,{ timeout: 'forever' }))).status,400);
  assert.equal((await post(sectionForm('rapid_messages',0,{ spam_limit: '99' }))).status,400);
  assert.equal((await post(sectionForm('exemptions',0,{ reason: '' }))).status,400);
  assert.equal((await query('SELECT * FROM automod_settings')).rows.length,0);
});
test('saving one section makes older forms stale without overwriting the saved change', async () => {
  assert.equal((await post(sectionForm('blocked_words'))).status,303); assert.equal((await post(sectionForm('rapid_messages'))).status,409);
  const saved=await readAutoModSettings(pool,guild); assert.deepEqual(saved.blocked_words,['newword','another phrase']); assert.equal(saved.spam_enabled,false);
});
test('a concurrent settings update during section authorization is rejected under the service lock', async () => {
  await save(); connectHook=async () => { await query('UPDATE automod_settings SET revision=revision+1,spam_limit=9 WHERE guild_id=$1',[guild]); };
  assert.equal((await post(sectionForm('blocked_words',1))).status,409); const current=await readAutoModSettings(pool,guild); assert.equal(current.spam_limit,9); assert.deepEqual(current.blocked_words,['marutestword','bad phrase']);
});
test('section saves retain role session origin and audit rollback protection', async () => {
  roles=[mod]; assert.equal((await post(sectionForm('rapid_messages'))).status,403); roles=[admin];
  assert.equal((await post(sectionForm('blocked_words'),{ origin: 'null' })).status,403);
  failAudit='AUTOMOD_SETTINGS_CHANGED'; assert.equal((await post(sectionForm('blocked_words'))).status,503); assert.equal((await query('SELECT * FROM automod_settings')).rows.length,0);
  failAudit=undefined; await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); const expired=await post(sectionForm('exemptions')); assert.equal(expired.status,303); assert.notEqual(expired.headers.get('location'),'/automod'); assert.equal((await query('SELECT * FROM automod_settings')).rows.length,0);
});
test('a no-op section save does not advance revision or duplicate an audit entry', async () => {
  assert.equal((await post(sectionForm('blocked_words'))).status,303);
  assert.equal((await post(sectionForm('blocked_words',1))).status,303); assert.equal((await readAutoModSettings(pool,guild)).revision,1);
  assert.equal((await query("SELECT * FROM audit_events WHERE event_type='AUTOMOD_SETTINGS_CHANGED'")).rows.length,1);
});

async function repeatSave(overrides: Record<string,unknown>={}) { await save({ enabled: false,repeatEnabled: true,repeatText: true,repeatImages: true,repeatLimit: 3,repeatWindowSeconds: 30,repeatTimeoutSeconds: 600,repeatEnforcedRoles: [],repeatEnforcedChannels: [],...overrides }); }
let attachmentId=900000000000000000n;
const imageBytes=Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3,4]);
function imageMessage(caption='',bytes=imageBytes,name='upload.png',user=member,where=channel) {
  const value=message(caption,user); value.channelId=where;
  const id=String(++attachmentId); imageData.set(id,bytes);
  const result=value as AutoModMessage; result.images=[{ id,url: `https://cdn.discordapp.com/attachments/${where}/${id}/${name}?ex=abc&is=def&hm=signed`,size: bytes.length }]; return result;
}
function repeatForm(revision=0,overrides: Record<string,string>={}) { return new URLSearchParams({ section: 'repeated_messages',revision: String(revision),csrf: autoModSectionProof(token,revision,'repeated_messages'),reason: 'Configure repetition filtering',repeat_enabled: 'true',repeat_text: 'true',repeat_images: 'true',repeat_limit: '3',repeat_window: '30',repeat_timeout: '1m',...overrides }); }
async function repeatViolations() { return (await violations()).filter((v) => v.rule_key==='repeated_messages'); }
test('repetition defaults Off with text and images selected and validates limits and modes', async () => {
  const config=await readAutoModSettings(pool,guild); assert.equal(config.repeat_enabled,false); assert.equal(config.repeat_text,true); assert.equal(config.repeat_images,true); assert.equal(config.repeat_limit,3); assert.equal(config.repeat_window_seconds,30);
  for(const fields of [{ repeatLimit: 1 },{ repeatLimit: 51 },{ repeatWindowSeconds: 0 },{ repeatWindowSeconds: 301 },{ repeatTimeoutSeconds: 2419201 },{ repeatText: false,repeatImages: false }]) await assert.rejects(repeatSave(fields),/INVALID_REPEAT/);
});
test('third identical text matches capitalization and repeated whitespace while earlier messages stay', async () => {
  await repeatSave(); await rapid(message('Hello    world')); await rapid(message('hello\nworld')); assert.equal(deletes.length,0); await rapid(message('HELLO WORLD'));
  assert.equal(deletes.length,1); assert.equal((await repeatViolations()).length,1); assert.equal(sent[0]!.embeds![0]!.title,'Repeated-message violation');
  assert.ok(!JSON.stringify(sent).includes('hello world')); assert.equal(repeatedTextKey('  '),null); assert.equal(repeatedTextKey('A B'),repeatedTextKey('a   b'));
});
test('third identical file matches reuploads with different attachment IDs filenames and captions', async () => {
  await repeatSave(); await rapid(imageMessage('caption one',imageBytes,'one.png')); await rapid(imageMessage('caption two',imageBytes,'renamed.png')); assert.equal(deletes.length,0);
  await rapid(imageMessage('caption three',imageBytes,'another.png')); assert.equal(deletes.length,1); assert.equal((await repeatViolations()).length,1);
  assert.match(String((await repeatViolations())[0]!.matched_entries),/Identical image: 3/); assert.equal(imageRequests.length,3);
});
test('same filenames and sizes with different bytes do not count as identical images', async () => {
  await repeatSave(); for(let i=0;i<3;i++) await rapid(imageMessage('',Uint8Array.from([1,2,i]),'same.png')); assert.equal(deletes.length,0); assert.equal((await repeatViolations()).length,0);
});
test('many copies of a file in one message count as one occurrence and one removed message is one violation', async () => {
  await repeatSave(); const first=imageMessage(); first.images!.push(first.images![0]!,first.images![0]!); await rapid(first); assert.equal(deletes.length,0);
  await rapid(imageMessage()); const third=imageMessage(); third.images!.push(third.images![0]!); await rapid(third);
  assert.equal(deletes.length,1); assert.equal((await repeatViolations()).length,1); assert.equal((await repeatViolations())[0]!.violation_count,1);
});
test('matching text and several matching image files in one message still count once', async () => {
  await repeatSave();
  for(let i=0;i<3;i++) { const value=imageMessage('same caption'); const another=imageMessage('',Uint8Array.from([4,5,6])); value.images!.push(another.images![0]!); await rapid(value); }
  const recorded=await repeatViolations(); assert.equal(recorded.length,1); assert.equal(recorded[0]!.violation_count,1); assert.equal((recorded[0]!.matched_entries as string[]).length,3); assert.equal(deletes.length,1);
});
test('text-only mode performs no image downloads and image-only mode ignores repeated captions', async () => {
  await repeatSave({ repeatImages: false }); for(let i=0;i<3;i++) await rapid(imageMessage('same')); assert.equal(deletes.length,1); assert.equal(imageRequests.length,0);
  await save({ enabled: false,revision: 1,repeatText: false,repeatImages: true }); const before=deletes.length;
  for(let i=0;i<3;i++) await rapid(imageMessage('same',Uint8Array.from([9,i]))); assert.equal(deletes.length,before);
});
test('repetition spans eligible channels but remains per member and uses an exclusive window boundary', async () => {
  await repeatSave({ repeatLimit: 2,repeatWindowSeconds: 2 }); const at=new Date();
  await rapid(imageMessage('',imageBytes,'one.png',member,channel),at); await rapid(imageMessage('',imageBytes,'two.png',actor,otherChannel),at); assert.equal(deletes.length,0);
  await rapid(imageMessage('',imageBytes,'three.png',member,otherChannel),new Date(at.getTime()+1)); assert.equal(deletes.length,1);
  await rapid(imageMessage('',imageBytes,'four.png',member,channel),new Date(at.getTime()+2001)); assert.equal(deletes.length,1);
});
test('five repeated-message violations trigger one timeout with a separate counter and the configured duration', async () => {
  await repeatSave({ repeatTimeoutSeconds: 60 }); const at=new Date(); for(let i=0;i<7;i++) await rapid(imageMessage(),at);
  assert.equal(deletes.length,5); assert.equal(actions.length,1); const record=(await cases())[0]!; assert.equal(record.duration_seconds,60); assert.equal(record.origin,'automod'); assert.equal(record.dm_status,'skipped'); assert.match(record.reason,/repeated-message/);
  assert.deepEqual(sent.at(-1)!.allowed_mentions,{ parse: [] }); assert.equal((await repeatViolations()).at(-1)!.violation_count,5);
});
test('duplicate creates and content edits cannot inflate repetition history or repeat actions', async () => {
  await repeatSave(); const first=await rapid(imageMessage()); for(let i=0;i<4;i++) await rapid(first); await rapid(imageMessage()); assert.equal(deletes.length,0);
  const third=await rapid(imageMessage()); for(let i=0;i<3;i++) { await enqueue(third); await retry(); }
  assert.equal(deletes.length,1); assert.equal(sent.length,1); assert.equal((await query('SELECT * FROM automod_repeat_activity')).rows.length,3);
});
test('exempt members ignored channels thread parents bots and owner do not enter repetition history or download images', async () => {
  await repeatSave({ ignoredChannels: [otherChannel] }); context.roleIds=[mod]; await rapid(imageMessage()); context.roleIds=[]; context.parentId=otherChannel; await rapid(imageMessage()); context.parentId=null;
  const ignored=imageMessage('',imageBytes,'x.png',member,otherChannel); await rapid(ignored); const botMessage=imageMessage(); botMessage.bot=true; await rapid(botMessage); context.owner=true; await rapid(imageMessage());
  assert.equal(imageRequests.length,0); assert.equal((await query('SELECT * FROM automod_repeat_activity')).rows.length,0);
});
test('repetition rule overrides are separate and do not bypass an ignored channel', async () => {
  await repeatSave({ repeatLimit: 2,repeatEnforcedRoles: [mod],ignoredChannels: [otherChannel] }); context.roleIds=[mod]; await rapid(imageMessage()); await rapid(imageMessage()); assert.equal(deletes.length,1);
  await rapid(imageMessage('',imageBytes,'ignored.png',member,otherChannel)); assert.equal(deletes.length,1);
});
test('missing image bytes are skipped rather than treated as matches and the dashboard reports incomplete checks', async () => {
  await repeatSave(); for(let i=0;i<3;i++) { const value=imageMessage(); imageData.delete(value.images![0]!.id); await rapid(value); }
  assert.equal(deletes.length,0); const html=await (await request('/automod')).text(); assert.match(html,/3 message\(s\) in the last hour had images/);
  assert.equal((await query("SELECT * FROM automod_repeat_activity WHERE image_status='partly_skipped'")).rows.length,3);
});
test('unavailable images do not prevent text repetition checks', async () => {
  await repeatSave(); for(let i=0;i<3;i++) { const value=imageMessage('same words'); imageData.delete(value.images![0]!.id); await rapid(value); }
  assert.equal(deletes.length,1); assert.match(String((await repeatViolations())[0]!.matched_entries),/Repeated text/);
});
test('image links without uploaded attachments do not download remote URLs', async () => {
  await repeatSave({ repeatText: false }); for(let i=0;i<3;i++) await rapid(message('https://untrusted.example/same.png')); assert.equal(imageRequests.length,0); assert.equal(deletes.length,0);
});
test('an attachment removed before dispatch avoids a stale image deletion', async () => {
  await repeatSave(); await rapid(imageMessage()); await rapid(imageMessage()); const last=imageMessage(); let reads=0;
  contextHook=async () => { if(++reads===2) last.images=[]; }; await rapid(last); assert.equal(deletes.length,0); assert.equal(actions.length,0);
});
test('saved file fingerprints survive a blocked-word deletion and failed repetition audit without retaining files', async () => {
  await repeatSave({ enabled: true,repeatLimit: 2 }); await rapid(imageMessage('marutestword')); failAudit='AUTOMOD_REPEATED_MESSAGE'; const last=await rapid(imageMessage('marutestword')); failAudit=undefined; imageData.clear(); await retry();
  assert.equal(messages.has(last.id),false); assert.equal((await repeatViolations()).length,1); assert.equal(deletes.length,2);
  const stored=JSON.stringify((await query('SELECT * FROM automod_repeat_activity')).rows); assert.ok(!stored.includes('marutestword')); assert.ok(!stored.includes('cdn.discordapp.com')); assert.ok(!stored.includes('signed'));
});
test('repetition timeout response loss is unconfirmed and never blindly resent', async () => {
  await repeatSave(); nativeFailure='network'; const at=new Date(); for(let i=0;i<8;i++) await rapid(message('same'),at); assert.equal(actions.length,1); assert.equal((await cases())[0]!.action_status,'unconfirmed');
});
test('queued creates and earlier observations cannot be punished under a newer repetition configuration', async () => {
  await repeatSave(); await rapid(imageMessage()); await rapid(imageMessage()); const last=imageMessage();
  await enqueueAutoModCandidates(pool,guild,[{ messageId: last.id,channelId: channel,content: '',eventAt: new Date(),isCreate: true }]);
  await save({ enabled: false,revision: 1,repeatWindowSeconds: 40 }); await processAutoModJob(pool,guild,deps); assert.equal(deletes.length,0); await rapid(imageMessage()); assert.equal(deletes.length,0);
});
test('old replayed creates and invalid image identity cannot add current repetition activity', async () => {
  await repeatSave({ repeatLimit: 2 }); for(let i=0;i<3;i++) await rapid(imageMessage(),new Date(Date.now()-700000)); assert.equal(deletes.length,0); assert.equal(imageRequests.length,0);
});
test('repetition settings save independently with their own proof and preserve both existing rules', async () => {
  await spamSave({ enabled: true }); const before=await readAutoModSettings(pool,guild);
  assert.equal((await post(repeatForm(1))).status,303); const after=await readAutoModSettings(pool,guild); assert.equal(after.repeat_enabled,true); assert.equal(after.repeat_timeout_seconds,60);
  for(const key of ['blocked_enabled','blocked_words','timeout_seconds','spam_enabled','spam_limit','spam_window_seconds','spam_timeout_seconds','exempt_role_ids','ignored_channel_ids'] as const) assert.deepEqual(after[key],before[key]);
  assert.equal((await post(repeatForm(2,{ csrf: autoModSectionProof(token,2,'rapid_messages') }))).status,403);
  assert.equal((await post(repeatForm(2,{ words: 'unrelated' }))).status,400); assert.equal((await post(repeatForm(2,{ repeat_limit: '99' }))).status,400);
});
test('shared-exemption changes prune repetition overrides without changing its configuration', async () => {
  await repeatSave({ repeatEnforcedRoles: [mod],ignoredChannels: [otherChannel],repeatEnforcedChannels: [otherChannel] }); const shared=sectionForm('exemptions',1); shared.delete('ignored_channel'); assert.equal((await post(shared)).status,303);
  const after=await readAutoModSettings(pool,guild); assert.equal(after.repeat_enabled,true); assert.deepEqual(after.repeat_enforced_role_ids,[]); assert.deepEqual(after.repeat_enforced_channel_ids,[]);
});
test('repetition save rejects expired stale nonstaff and invalid mode requests with atomic auditing', async () => {
  roles=[mod]; assert.equal((await post(repeatForm())).status,403); roles=[admin]; const noModes=repeatForm(); noModes.delete('repeat_text'); noModes.delete('repeat_images'); assert.equal((await post(noModes)).status,400);
  failAudit='AUTOMOD_SETTINGS_CHANGED'; assert.equal((await post(repeatForm())).status,503); failAudit=undefined; assert.equal((await query('SELECT * FROM automod_settings')).rows.length,0);
  assert.equal((await post(repeatForm())).status,303); assert.equal((await post(repeatForm())).status,409);
});
test('image downloader permits only original Discord attachment URLs without credentials or redirects', async () => {
  const id='900000000000000001'; const image={ id,url: `https://cdn.discordapp.com/attachments/${channel}/${id}/x.png?hm=secret`,size: 3 }; let fetched=0;
  const loader=createImageFingerprinter((async (_url,options) => { fetched++; assert.equal(options?.redirect,'error'); assert.deepEqual(options?.headers,{ 'accept-encoding': 'identity' }); return new Response(Uint8Array.from([1,2,3])); }) as typeof fetch);
  for(const address of [`http://cdn.discordapp.com/attachments/${channel}/${id}/x.png`,`https://cdn.discordapp.com.evil.test/attachments/${channel}/${id}/x.png`,`https://cdn.discordapp.com@127.0.0.1/attachments/${channel}/${id}/x.png`,`https://media.discordapp.net/attachments/${channel}/${id}/x.png`,`https://cdn.discordapp.com/attachments/${otherChannel}/${id}/x.png`]) {
    assert.equal(trustedImageUrl({ ...image,url: address },channel),null); const result=await loader({ channelId: channel,images: [{ ...image,url: address }] }); assert.equal(result.hashes.length,0);
  }
  assert.equal(fetched,0); const good=await loader({ channelId: channel,images: [image] }); assert.equal(good.hashes.length,1); assert.equal(good.skipped,false);
});
test('image hashing compares bytes not URL filenames and caches only immutable attachment identity', async () => {
  let count=0; const loader=createImageFingerprinter((async () => { count++; return new Response(imageBytes); }) as typeof fetch);
  const a={ id: '900000000000000001',url: `https://cdn.discordapp.com/attachments/${channel}/900000000000000001/a.png`,size: imageBytes.length };
  const b={ id: '900000000000000002',url: `https://cdn.discordapp.com/attachments/${channel}/900000000000000002/b.png`,size: imageBytes.length };
  const first=await loader({ channelId: channel,images: [a] }); const second=await loader({ channelId: channel,images: [b] }); assert.deepEqual(first.hashes,second.hashes); await loader({ channelId: channel,images: [a] }); assert.equal(count,2);
});
test('image downloader skips oversized truncated overlong encoded redirected and unavailable responses', async () => {
  const image={ id: '900000000000000001',url: `https://cdn.discordapp.com/attachments/${channel}/900000000000000001/x.png`,size: 3 };
  for(const response of [new Response(Uint8Array.from([1,2])),new Response(Uint8Array.from([1,2,3,4])),new Response(Uint8Array.from([1,2,3]),{ headers: { 'content-length': '9' } }),new Response(Uint8Array.from([1,2,3]),{ headers: { 'content-encoding': 'gzip' } }),new Response(null,{ status: 302,headers: { location: 'http://127.0.0.1/' } }),new Response(null,{ status: 403 })]) {
    const result=await createImageFingerprinter((async () => response) as typeof fetch)({ channelId: channel,images: [image] }); assert.equal(result.hashes.length,0); assert.equal(result.skipped,true);
  }
  let called=false; const result=await createImageFingerprinter((async () => { called=true; throw new Error('not reached'); }) as typeof fetch)({ channelId: channel,images: [{ ...image,size: imageByteLimit+1 }] }); assert.equal(called,false); assert.equal(result.skipped,true);
});
test('image downloads enforce per-message byte and file budgets and do not leak signed URLs in errors', async () => {
  let count=0; const images=Array.from({ length: 12 },(_,i) => { const id=String(900000000000000000n+BigInt(i)); return { id,url: `https://cdn.discordapp.com/attachments/${channel}/${id}/x.png?hm=secret`,size: 1 }; });
  const result=await createImageFingerprinter((async () => { count++; return new Response(Uint8Array.from([1])); }) as typeof fetch)({ channelId: channel,images }); assert.equal(count,10); assert.equal(result.hashes.length,1); assert.equal(result.skipped,true);
  count=0; const large=images.slice(0,3).map((image) => ({ ...image,size: messageImageByteLimit/2 })); const limited=await createImageFingerprinter((async () => { count++; throw new Error('private signed URL'); }) as typeof fetch)({ channelId: channel,images: large }); assert.equal(count,2); assert.deepEqual(limited,{ hashes: [],skipped: true });
});

test('Discord image extraction uses original attachments, accepts missing dimensions and excludes videos', () => {
  const image={ id: '900000000000000001',url: 'https://cdn.discordapp.com/original',proxy_url: 'https://media.discordapp.net/transformed',filename: 'original.png',size: 3,content_type: 'image/png' };
  const selected=imageUploads([image,{ ...image,id: '900000000000000002',content_type: undefined },{ ...image,filename: 'movie.mp4',content_type: 'video/mp4' }]);
  assert.equal(selected.length,2); assert.equal(selected[0]!.url,image.url); assert.ok(!JSON.stringify(selected).includes('transformed'));
});
test('raw image-only creates with empty text enter repetition intake but image edits do not add occurrences', async () => {
  await repeatSave(); const value=imageMessage(); const event=parseAutoModEvent({ t: 'MESSAGE_CREATE',d: { guild_id: guild,id: value.id,channel_id: channel,content: '',author: { bot: false },attachments: value.images } },guild)!;
  assert.equal(event.isCreate,true); await enqueueAutoModCandidates(pool,guild,[event]); await processAutoModJob(pool,guild,deps); assert.equal((await query('SELECT * FROM automod_repeat_activity')).rows.length,1);
  const update=parseAutoModEvent({ t: 'MESSAGE_UPDATE',d: { guild_id: guild,id: value.id,channel_id: channel,content: '' } },guild)!; assert.equal(update.isCreate,false); await enqueueAutoModCandidates(pool,guild,[update]); assert.equal(await processAutoModJob(pool,guild,deps),false);
});
test('repetition overrides cannot change rapid-message or blocked-word exemption overrides', async () => {
  await repeatSave({ repeatEnforcedRoles: [mod],ignoredChannels: [otherChannel],repeatEnforcedChannels: [otherChannel] });
  let current=await readAutoModSettings(pool,guild); assert.deepEqual(current.spam_enforced_role_ids,[]); assert.deepEqual(current.spam_enforced_channel_ids,[]); assert.deepEqual(current.enforced_role_ids,[]); assert.deepEqual(current.enforced_channel_ids,[]);
  assert.equal(autoModExempt(current,[mod],channel,null,'rapid_messages'),true); assert.equal(autoModExempt(current,[mod],channel,null,'repeated_messages'),false);
  assert.equal((await post(sectionForm('rapid_messages',1))).status,303); current=await readAutoModSettings(pool,guild); assert.deepEqual(current.repeat_enforced_role_ids,[mod]); assert.deepEqual(current.repeat_enforced_channel_ids,[otherChannel]);
});
