import assert from 'node:assert/strict';
import { test, before, beforeEach, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { Client, REST, RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { readHoneypotSettings, saveHoneypotSettings } from '../src/honeypot-settings.js';
import type { HoneypotResources } from '../src/honeypot-settings.js';
import { parseHoneypotEvent, enqueueHoneypot, processHoneypotJob } from '../src/honeypot-engine.js';
import type { HoneypotContext, HoneypotDependencies, HoneypotRow } from '../src/honeypot-engine.js';
import { honeypotDependencies } from '../src/honeypot-discord.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { digest, honeypotProof, randomToken, autoModProof } from '../src/web-security.js';
import { caseSummary } from '../src/handle-warning.js';
import type { WarningCase } from '../src/warnings.js';
const db=new PGlite();
const guild='100000000000000001',foreign='100000000000000002',admin='200000000000000001',mod='200000000000000002',extra='200000000000000003';
const actor='300000000000000001',member='300000000000000002',bot='300000000000000003',trap='400000000000000001',logs='400000000000000002',elsewhere='400000000000000003';
let token=randomToken(),actorRoles: string[] | null,resources: HoneypotResources,context: HoneypotContext;
let bans: Map<string,{ reason: string | null }>,calls: string[],sent: RESTPostAPIChannelMessageJSONBody[];
let failAudit: string | undefined,failClaim: string | undefined,failOutcome=false,busy=false,failUnlock=false,discarded=false,transaction=false;
let banMode: 'ok'|'reject'|'lost-before'|'lost-after',unbanMode: 'ok'|'reject'|'lost-before'|'lost-after';
let banHook: (() => Promise<void>) | undefined,readHook: (() => Promise<void>) | undefined,contextHook: (() => Promise<void>) | undefined;
let logMode: 'ok'|'lost'|'reject',lookupFail=false;
async function query(sql: string,values?: unknown[]) {
  if(busy && sql.includes('pg_try_advisory_lock(hashtext($1),hashtext($2))')) return { rows: [{ locked: false }],rowCount: 1 };
  if(failUnlock && sql.includes('pg_advisory_unlock(')) throw new Error('unlock failed');
  if(failAudit && values?.[2]===failAudit) throw new Error('private diagnostic');
  if(failClaim && sql.includes('UPDATE honeypot_events SET ban_status=') && values?.[failClaim==='ban'?2:3]==='applying') throw new Error('claim failed');
  if(failOutcome && sql.includes('UPDATE moderation_cases SET action_status=$3')) throw new Error('outcome failed');
  const result=await db.query(sql,values); if(sql==='BEGIN') transaction=true; if(['COMMIT','ROLLBACK'].includes(sql)) transaction=false;
  return { rows: result.rows,rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool={ query,async connect() { return { query,release(e?: Error) { if(e) discarded=true; } }; } } as unknown as Pool;
const deps: HoneypotDependencies={ botId: () => bot,
  readContext: async () => { await contextHook?.(); return { ...context,roles: [...context.roles] }; },
  readBan: async (id) => { if(lookupFail) throw new Error('lookup failure'); await readHook?.(); return bans.get(id) ?? null; },
  ban: async (id,reason) => {
    assert.equal(transaction,false); const r=(await query('SELECT * FROM honeypot_events WHERE guild_id=$1 AND NOT done ORDER BY message_id LIMIT 1',[guild])).rows[0] as HoneypotRow; assert.equal(r.ban_status,'applying'); calls.push('ban');
    await banHook?.();
    if(banMode==='reject') throw Object.assign(new Error('forbidden'),{ status: 403 });
    if(banMode==='lost-before') throw new Error('lost');
    bans.set(id,{ reason }); context.member=false;
    if(banMode==='lost-after') throw new Error('lost');
  },
  unban: async (id,reason) => {
    assert.equal(transaction,false); const r=(await query('SELECT * FROM honeypot_events WHERE guild_id=$1 AND NOT done ORDER BY message_id LIMIT 1',[guild])).rows[0] as HoneypotRow; assert.equal(r.unban_status,'applying'); assert.equal(bans.get(id)?.reason,reason); calls.push('unban');
    if(unbanMode==='reject') throw Object.assign(new Error('forbidden'),{ status: 403 });
    if(unbanMode==='lost-before') throw new Error('lost');
    bans.delete(id); if(unbanMode==='lost-after') throw new Error('lost');
  },
  notifications: { readActorRoles: async () => actorRoles,readContext: async () => { throw new Error('not used'); },
    readLogChannels: async () => [{ id: logs,name: 'logs',usable: true }],
    sendDM: async () => { throw new Error('Honeypot must not DM'); },
    sendLog: async (_channel,body) => { assert.equal(transaction,false); calls.push('log'); sent.push(body); if(logMode==='lost') throw new Error('lost'); if(logMode==='reject') throw Object.assign(new Error('forbidden'),{ status: 403 }); return { id: '800000000000000001' }; } },
};
function input(overrides: Record<string,unknown>={}) { return { guildId: guild,actorId: actor,token,revision: 1,enabled: true,channels: [trap],exemptRoles: [],warningConfirmed: true,reason: 'Configure trap',readRoles: async () => actorRoles,readResources: async () => resources,...overrides }; }
function packet(overrides: Record<string,unknown>={}) { return { t: 'MESSAGE_CREATE',d: { guild_id: guild,id: '600000000000000001',channel_id: trap,author: { id: member },timestamp: new Date().toISOString(),type: 0,...overrides } }; }
async function enqueue(overrides: Record<string,unknown>={}) { const event=parseHoneypotEvent(packet(overrides),guild); assert.ok(event); await enqueueHoneypot(pool,guild,[event]); }
async function event() { return (await query('SELECT * FROM honeypot_events WHERE guild_id=$1 ORDER BY message_id LIMIT 1',[guild])).rows[0] as HoneypotRow; }
async function record() { return (await query('SELECT * FROM moderation_cases WHERE guild_id=$1 ORDER BY case_number LIMIT 1',[guild])).rows[0] as WarningCase; }
async function run() { await enqueue(); return processHoneypotJob(pool,guild,deps); }
async function retry() { await query("UPDATE honeypot_events SET available_at=NOW()-INTERVAL '1 second'"); return processHoneypotJob(pool,guild,deps); }
let base='',handler: ReturnType<typeof createDashboardHandler>;
const server=createServer((req,res) => { void handler(req,res); });
async function request(path='/honeypot',init: RequestInit={}) { return fetch(base+path,{ ...init,redirect: 'manual',headers: { cookie: `maru_session=${token}`,connection: 'close',...init.headers } }); }
function form(overrides: Record<string,string>={}) { return new URLSearchParams({ csrf: honeypotProof(token,1),revision: '1',enabled: 'true',warning: 'true',channel: trap,reason: 'Update trap',...overrides }); }
async function post(body=form(),headers: Record<string,string>={}) { return request('/honeypot',{ method: 'POST',body,headers: { origin: base,'content-type': 'application/x-www-form-urlencoded',...headers } }); }
before(async () => {
  for(const name of ['001_foundation.sql','002_dashboard_auth.sql','003_moderation_warnings.sql','004_case_changes.sql','005_timeouts.sql','006_bans.sql','010_blocked_words.sql','014_honeypot.sql']) await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  failAudit=undefined; failClaim=undefined; failOutcome=false; busy=false; failUnlock=false; discarded=false; transaction=false;
  banMode='ok'; unbanMode='ok'; logMode='ok'; lookupFail=false; banHook=undefined; readHook=undefined; contextHook=undefined;
  token=randomToken(); actorRoles=[admin]; resources={ canBan: true,channels: [{ id: trap,name: 'trap',usable: true }],roles: [{ id: extra,name: 'Trusted' }] };
  context={ guildName: 'Development',member: true,bot: false,owner: false,administrator: false,roles: [],canBan: true,above: true };
  bans=new Map(); calls=[]; sent=[];
  await db.exec('TRUNCATE guild_settings CASCADE');
  await query('INSERT INTO guild_settings (guild_id,settings) VALUES ($1,$2::jsonb),($3,$2::jsonb)',[guild,JSON.stringify({ moderation_log_channel_id: logs }),foreign]);
  await query("INSERT INTO staff_roles (guild_id,role_id,access_level) VALUES ($1,$2,'admin'),($1,$3,'moderator')",[guild,admin,mod]);
  await query("INSERT INTO dashboard_sessions (token_hash,guild_id,user_id,display_name,expires_at) VALUES ($1,$2,$3,'Tester',NOW()+INTERVAL '1 hour')",[digest(token),guild,actor]);
  await query("INSERT INTO honeypot_settings (guild_id,enabled,channel_ids,warning_confirmed,revision,updated_by,updated_at) VALUES ($1,true,$2,true,1,$3,NOW()-INTERVAL '1 minute')",[guild,[trap],actor]);
  handler=createDashboardHandler({ pool,guildId: guild,config: { origin: base,applicationId: bot,clientSecret: 'not-a-real-secret',secure: false },isBotReady: () => true,readMemberRoles: async () => actorRoles,readHoneypotResources: async () => resources });
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await db.close(); });
test('default is Off without channels and first save is revisioned and audited',async () => {
  await query('DELETE FROM honeypot_settings'); assert.equal((await readHoneypotSettings(pool,guild)).enabled,false);
  await saveHoneypotSettings(pool,input({ revision: 0 })); assert.equal((await readHoneypotSettings(pool,guild)).revision,1);
  assert.equal((await query("SELECT * FROM audit_events WHERE event_type='HONEYPOT_SETTINGS_CHANGED'")).rowCount,1);
});
test('settings require current Admin access, a session, warning confirmation and valid resources',async () => {
  for(const access of [null,[],[mod]]) { actorRoles=access; await assert.rejects(saveHoneypotSettings(pool,input()),/ADMIN_REQUIRED/); }
  actorRoles=[admin];
  await assert.rejects(saveHoneypotSettings(pool,input({ warningConfirmed: false })),/WARNING_REQUIRED/);
  await assert.rejects(saveHoneypotSettings(pool,input({ channels: [] })),/WARNING_REQUIRED/);
  for(const channels of [[elsewhere],[trap,trap],['bad']]) await assert.rejects(saveHoneypotSettings(pool,input({ channels })),/INVALID_SELECTION/);
  resources.canBan=false; await assert.rejects(saveHoneypotSettings(pool,input()),/PERMISSIONS_OR_LOG/); resources.canBan=true;
  await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); await assert.rejects(saveHoneypotSettings(pool,input()),/SESSION_EXPIRED/);
});
test('full-access Mods can configure only while their current Mod role remains',async () => {
  actorRoles=[mod]; await query('INSERT INTO staff_access_grants (guild_id,user_id,granted_by) VALUES ($1,$2,$2)',[guild,actor]);
  await saveHoneypotSettings(pool,input({ enabled: false })); actorRoles=[];
  await assert.rejects(saveHoneypotSettings(pool,input({ revision: 2 })),/ADMIN_REQUIRED/);
});
test('log destination must be configured and separate from traps',async () => {
  await query('UPDATE guild_settings SET settings=$2::jsonb WHERE guild_id=$1',[guild,JSON.stringify({ moderation_log_channel_id: trap })]);
  await assert.rejects(saveHoneypotSettings(pool,input()),/PERMISSIONS_OR_LOG/);
  await query("UPDATE guild_settings SET settings='{}' WHERE guild_id=$1",[guild]); await assert.rejects(saveHoneypotSettings(pool,input()),/PERMISSIONS_OR_LOG/);
});
test('stale saves and audit failures cannot change settings; no-op saves do not duplicate audit',async () => {
  await assert.rejects(saveHoneypotSettings(pool,input({ revision: 0 })),/STALE_SETTINGS/);
  await saveHoneypotSettings(pool,input()); assert.equal((await query('SELECT * FROM audit_events')).rowCount,0);
  // Settings audit uses a literal SQL value, so inject at the database through a trigger.
  await db.exec("CREATE FUNCTION reject_hp_audit() RETURNS trigger AS $$ BEGIN IF NEW.event_type='HONEYPOT_SETTINGS_CHANGED' THEN RAISE EXCEPTION 'TEST'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql; CREATE TRIGGER reject_hp_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_hp_audit()");
  try { await assert.rejects(saveHoneypotSettings(pool,input({ enabled: false }))); assert.equal((await readHoneypotSettings(pool,guild)).enabled,true); }
  finally { await db.exec('DROP TRIGGER reject_hp_audit ON audit_events; DROP FUNCTION reject_hp_audit()'); }
});
test('Off can be saved after selected channels and roles disappear',async () => {
  resources.channels=[]; resources.roles=[]; resources.canBan=false;
  await saveHoneypotSettings(pool,input({ enabled: false })); assert.equal((await readHoneypotSettings(pool,guild)).enabled,false);
});
test('intake accepts human creates including attachments and replies, never edits bots webhooks DMs or stale traffic',async () => {
  assert.ok(parseHoneypotEvent(packet({ type: 19 }),guild));
  for(const d of [{ guild_id: foreign },{ author: { id: bot,bot: true } },{ webhook_id: '700000000000000001' },{ timestamp: 'invalid' },{ timestamp: new Date(Date.now()-180000).toISOString() },{ timestamp: new Date(Date.now()+60000).toISOString() },{ type: 7 },{ id: 'bad' },{ author: {} }]) assert.equal(parseHoneypotEvent(packet(d),guild),undefined);
  assert.equal(parseHoneypotEvent({ ...packet(),t: 'MESSAGE_UPDATE' },guild),undefined);
});
test('intake queues only configured channels while enabled and never stores source content',async () => {
  await enqueue({ channel_id: elsewhere }); assert.equal(await event(),undefined);
  await enqueue(); await enqueue(); assert.equal((await query('SELECT * FROM honeypot_events')).rowCount,1);
  assert.ok(!JSON.stringify(await event()).includes('content'));
  await query('DELETE FROM honeypot_events'); await query('UPDATE honeypot_settings SET enabled=false'); await enqueue(); assert.equal(await event(),undefined);
});
test('messages from before enable or settings edits cannot be punished under the new revision',async () => {
  const old=new Date(Date.now()-30000); await saveHoneypotSettings(pool,input({ exemptRoles: [extra] }));
  await enqueueHoneypot(pool,guild,[{ messageId: '600000000000000001',channelId: trap,userId: member,occurredAt: old }]); assert.equal(await event(),undefined);
});
test('softban claims each step before dispatch, deletes exactly 24h and records one shared case plus one log without DM',async () => {
  await run(); assert.deepEqual(calls,['ban','unban','log']); assert.equal(bans.size,0);
  assert.equal((await event()).done,true); const c=await record(); assert.equal(c.action,'softban'); assert.equal(c.delete_message_seconds,86400); assert.equal(c.action_status,'applied'); assert.equal(c.dm_status,'skipped'); assert.equal(c.log_status,'sent');
  assert.deepEqual(sent[0]?.allowed_mentions,{ parse: [] }); assert.ok(!JSON.stringify(sent).includes('content'));
  assert.match(caseSummary(c),/24 hours/); assert.match(caseSummary(c),/Honeypot softban/);
});
test('duplicate gateway events and restarted processing never repeat ban unban or notification',async () => {
  await run(); await enqueue(); assert.equal(await retry(),false); assert.deepEqual(calls,['ban','unban','log']); assert.equal((await query('SELECT * FROM moderation_cases')).rowCount,1);
});
test('staff, owners, Administrators, bots, absent members and additional exempt roles are protected',async () => {
  for(const change of [{ roles: [admin] },{ roles: [mod] },{ owner: true },{ administrator: true },{ bot: true },{ member: false },{ roles: [extra] }]) {
    await query('DELETE FROM honeypot_events'); context={ ...context,roles: [],owner: false,administrator: false,bot: false,member: true,...change };
    await query('UPDATE honeypot_settings SET exempt_role_ids=$1',[[extra]]);
    await run(); assert.equal((await event()).ban_status,'skipped'); assert.equal(await record(),undefined);
  }
  assert.deepEqual(calls,[]);
});
test('changed settings, disabled rules and old queued events cancel before native dispatch',async () => {
  for(const change of ["enabled=false","revision=revision+1","channel_ids='{}',enabled=false"]) {
    await query('DELETE FROM honeypot_events'); await query('UPDATE honeypot_settings SET enabled=true,channel_ids=$1,revision=1',[[trap]]); await enqueue();
    await query(`UPDATE honeypot_settings SET ${change}`); await processHoneypotJob(pool,guild,deps); assert.equal((await event()).ban_status,'skipped');
  }
  assert.deepEqual(calls,[]);
});
test('permissions and hierarchy failures are recorded honestly and leave the member untouched',async () => {
  for(const change of [{ canBan: false,above: true },{ canBan: true,above: false }]) {
    await query('TRUNCATE honeypot_events,moderation_cases CASCADE'); context={ ...context,...change }; await run(); assert.equal((await event()).ban_status,'rejected'); assert.equal((await record()).action_status,'rejected');
  }
  assert.deepEqual(calls,['log','log']);
});
test('a role gained during ban lookup is rechecked before the native claim',async () => {
  readHook=async () => { context.roles=[mod]; }; await run(); assert.deepEqual(calls,['log']); assert.equal((await event()).ban_status,'skipped');
});
test('pre-existing bans are never replaced or removed',async () => {
  bans.set(member,{ reason: 'Staff permanent ban' }); await run(); assert.deepEqual(calls,[]); assert.equal(bans.get(member)?.reason,'Staff permanent ban'); assert.equal(await record(),undefined);
});
test('request audit failure prevents ban and rolls back case allocation',async () => {
  failAudit='HONEYPOT_REQUESTED'; await run(); assert.deepEqual(calls,[]); assert.equal(await record(),undefined); assert.equal((await event()).case_number,null);
  failAudit=undefined; await retry(); assert.deepEqual(calls,['ban','unban','log']); assert.equal((await record()).case_number,1);
});
test('ban claim audit failure prevents dispatch and retry can safely begin',async () => {
  failAudit='HONEYPOT_BAN_CLAIMED'; await run(); assert.deepEqual(calls,[]); assert.equal((await event()).ban_status,'pending');
  failAudit=undefined; await retry(); assert.deepEqual(calls,['ban','unban','log']);
});
test('explicit ban rejection never dispatches unban and logs a rejected softban',async () => {
  banMode='reject'; await run(); assert.deepEqual(calls,['ban','log']); assert.equal((await record()).action_status,'rejected');
});
test('lost ban response is recovered from its unique reason without replaying ban',async () => {
  banMode='lost-after'; await run(); assert.deepEqual(calls,['ban','unban','log']); assert.equal((await record()).action_status,'applied');
});
test('lost ban response without a matching ban stays unconfirmed and never dispatches unban or repeats ban',async () => {
  banMode='lost-before'; await run(); await retry(); assert.deepEqual(calls,['ban','log']); assert.equal((await record()).action_status,'unconfirmed');
});
test('a different ban created during an ambiguous attempt is left in place',async () => {
  banMode='lost-before'; banHook=async () => { bans.set(member,{ reason: 'Other staff action' }); }; await run(); assert.deepEqual(calls,['ban','log']); assert.equal(bans.get(member)?.reason,'Other staff action'); assert.equal((await event()).unban_status,'skipped');
});
test('unban claim audit failure is recoverable after restart, even with protection now Off',async () => {
  failAudit='HONEYPOT_UNBAN_CLAIMED'; await run(); assert.deepEqual(calls,['ban']); assert.equal(bans.size,1);
  failAudit=undefined; await query('UPDATE honeypot_settings SET enabled=false'); await retry(); assert.deepEqual(calls,['ban','unban','log']); assert.equal((await record()).action_status,'applied');
});
test('unban rejection and lost response with ban still present require staff review without retry',async () => {
  for(const mode of ['reject','lost-before'] as const) {
    await query('TRUNCATE honeypot_events,moderation_cases CASCADE'); bans.clear(); calls=[]; context.member=true; unbanMode=mode;
    await run(); assert.equal((await record()).action_status,'unconfirmed'); assert.equal(bans.size,1); await retry(); assert.deepEqual(calls,['ban','unban','log']);
  }
});
test('lost unban response is reconciled as applied when the ban is absent',async () => {
  unbanMode='lost-after'; await run(); assert.equal((await record()).action_status,'applied'); assert.deepEqual(calls,['ban','unban','log']);
});
test('interrupted claimed ban with no matching state does not replay a destructive action',async () => {
  await enqueue(); await query("UPDATE honeypot_events SET ban_status='applying'"); await processHoneypotJob(pool,guild,deps); assert.deepEqual(calls,[]); assert.equal((await event()).ban_status,'unconfirmed');
});
test('interrupted unban claim never repeats DELETE against a ban still present',async () => {
  failAudit='HONEYPOT_UNBAN_CLAIMED'; await run(); failAudit=undefined;
  await query("UPDATE honeypot_events SET ban_status='applied',unban_status='applying'"); await retry(); assert.deepEqual(calls,['ban','log']); assert.equal(bans.size,1); assert.equal((await event()).unban_status,'unconfirmed');
});
test('interrupted unban whose ban is now absent is recovered without another DELETE',async () => {
  failAudit='HONEYPOT_UNBAN_CLAIMED'; await run(); failAudit=undefined; bans.clear();
  await query("UPDATE honeypot_events SET ban_status='applied',unban_status='applying'"); await retry(); assert.deepEqual(calls,['ban','log']); assert.equal((await record()).action_status,'applied');
});
test('outcome audit failure after both mutations reconciles without replaying either action',async () => {
  failAudit='HONEYPOT_RESULT'; await run(); assert.deepEqual(calls,['ban','unban']); failAudit=undefined; await retry(); assert.deepEqual(calls,['ban','unban','log']); assert.equal((await record()).action_status,'applied');
});
test('ban lookup failure fails closed and retains saved work for retry',async () => {
  lookupFail=true; await run(); assert.deepEqual(calls,[]); assert.equal((await event()).done,false); lookupFail=false; await retry(); assert.deepEqual(calls,['ban','unban','log']);
});
test('shared member lock prevents overlap and unsafe unlock discards the connection',async () => {
  busy=true; await run(); assert.deepEqual(calls,[]); busy=false; failUnlock=true; await retry(); assert.equal(discarded,true);
});
test('log rejection or lost response cannot undo a completed softban or resend on restart',async () => {
  for(const mode of ['reject','lost'] as const) {
    await query('TRUNCATE honeypot_events,moderation_cases CASCADE'); bans.clear(); calls=[]; context.member=true; logMode=mode;
    await run(); await retry(); assert.deepEqual(calls,['ban','unban','log']); assert.equal((await record()).action_status,'applied'); assert.equal((await record()).log_status,mode==='lost'?'unconfirmed':'failed');
  }
});
test('server scope separates events, cases, roles, and settings',async () => {
  await enqueue(); assert.equal(await processHoneypotJob(pool,foreign,deps),false); assert.deepEqual(calls,[]);
  await processHoneypotJob(pool,guild,deps); assert.equal((await query('SELECT * FROM moderation_cases WHERE guild_id=$1',[foreign])).rowCount,0);
});
test('database prevents non-24h softbans and manual or DM-enabled softban records',async () => {
  await run(); for(const change of ['delete_message_seconds=0',"origin='manual'","dm_status='pending'","reason='Changed'"]) await assert.rejects(query(`UPDATE moderation_cases SET ${change}`));
});
test('Honeypot page requires authentication and allows GET and POST only',async () => {
  assert.equal((await request('/honeypot',{ headers: { cookie: '' } })).status,303);
  assert.equal((await request('/honeypot',{ method: 'DELETE' })).status,405);
  const response=await request(); assert.equal(response.status,200); assert.match(await response.text(),/24 hours/);
});
test('Mods may view but cannot save, and Admin forms contain revision-specific CSRF protection',async () => {
  actorRoles=[mod]; assert.match(await (await request()).text(),/fieldset disabled/); assert.equal((await post()).status,403); actorRoles=[admin];
  const html=await (await request()).text(); assert.ok(html.includes(honeypotProof(token,1)));
  const body=form({ enabled: 'false' }); assert.equal((await post(body)).status,303); assert.equal((await readHoneypotSettings(pool,guild)).enabled,false);
});
test('HTTP rejects cross-origin, null origin, unrelated CSRF, duplicate fields and unknown fields',async () => {
  for(const origin of ['https://elsewhere.invalid','null','']) assert.equal((await post(form(),{ origin })).status,403);
  assert.equal((await post(form({ csrf: autoModProof(token,1) }))).status,403);
  const duplicate=form(); duplicate.append('enabled','false'); assert.equal((await post(duplicate)).status,409);
  const unknown=form(); unknown.append('delete_seconds','0'); assert.equal((await post(unknown)).status,409);
  assert.equal((await readHoneypotSettings(pool,guild)).revision,1);
});
test('HTTP rejects stale forms and lost access and escapes channel role and event strings',async () => {
  assert.equal((await post(form({ revision: '0',csrf: honeypotProof(token,0) }))).status,409);
  resources.roles=[{ id: extra,name: '<script>bad</script>' }]; resources.channels[0]!.name='<img src=x>';
  await enqueue(); await query("UPDATE honeypot_events SET note='<script>event</script>'");
  const html=await (await request()).text(); assert.ok(html.includes('&lt;script&gt;bad')); assert.ok(html.includes('&lt;img')); assert.ok(html.includes('&lt;script&gt;event')); assert.ok(!html.includes('<script>'));
  actorRoles=[]; assert.equal((await post()).status,403);
});
test('HTTP oversized requests cannot save and another server remains unchanged',async () => {
  const body=form({ reason: 'x'.repeat(17000) }); assert.equal((await post(body)).status,409);
  assert.equal((await readHoneypotSettings(pool,foreign)).enabled,false);
});
test('adapter sends exact ban deletion, accepts REST empty 204 and rechecks the reason before unban',async () => {
  const operations: { method: string; route: string; options: unknown }[]=[];
  let current: { user: { id: string }; reason: string } | null=null;
  const writer={ get: async (route: string,options: unknown) => { operations.push({ method: 'get',route,options }); if(!current) throw { code: 10026 }; return current; },
    put: async (route: string,options: { reason: string }) => { operations.push({ method: 'put',route,options }); current={ user: { id: member },reason: options.reason }; return new ArrayBuffer(0); },
    delete: async (route: string,options: unknown) => { operations.push({ method: 'delete',route,options }); current=null; return new ArrayBuffer(0); },post: async () => ({}) };
  const adapter=honeypotDependencies({ user: { id: bot } } as Client,guild,'test-token',deps.notifications,writer as unknown as REST);
  await adapter.ban(member,'unique-marker'); assert.deepEqual((operations[0]!.options as { body: unknown }).body,{ delete_message_seconds: 86400 });
  await adapter.unban(member,'unique-marker'); assert.deepEqual(operations.map((o) => o.method),['put','get','delete']);
  current={ user: { id: member },reason: 'Other ban' }; await assert.rejects(adapter.unban(member,'unique-marker'),/OWNERSHIP/); assert.equal(operations.filter((o) => o.method==='delete').length,1);
});
test('adapter distinguishes unknown ban from lookup failure and rejects malformed mutation responses',async () => {
  let mode='unknown'; const writer={ get: async () => { if(mode==='unknown') throw { code: 10026 }; if(mode==='forbidden') throw { code: 50013 }; return { user: { id: actor },reason: 'marker' }; },put: async () => new ArrayBuffer(1),delete: async () => null,post: async () => ({}) };
  const adapter=honeypotDependencies({ user: { id: bot } } as Client,guild,'test-token',deps.notifications,writer as unknown as REST);
  assert.equal(await adapter.readBan(member),null); mode='forbidden'; await assert.rejects(adapter.readBan(member)); mode='bad'; await assert.rejects(adapter.readBan(member),/INVALID_BAN/);
  await assert.rejects(adapter.ban(member,'marker'),/UNEXPECTED_RESPONSE/);
});
test('missing Ban Members does not require an unauthorized ban lookup to record and log failure',async () => {
  context.canBan=false; lookupFail=true; await run(); assert.deepEqual(calls,['log']); assert.equal((await record()).action_status,'rejected');
});
test('a changed log destination inside the trap channels stops a new action',async () => {
  await query('UPDATE guild_settings SET settings=$2::jsonb WHERE guild_id=$1',[guild,JSON.stringify({ moderation_log_channel_id: trap })]); await run(); assert.deepEqual(calls,[]); assert.equal((await event()).ban_status,'skipped');
});
test('new softbans use the same sequence as prior manual cases',async () => {
  await query('INSERT INTO guild_case_counters (guild_id,last_case_number) VALUES ($1,9)',[guild]); await run(); assert.equal((await record()).case_number,10);
});
test('case outcome write failure after unban preserves claims and recovers without replay',async () => {
  failOutcome=true; await run(); assert.deepEqual(calls,['ban','unban']); assert.equal((await event()).done,false);
  failOutcome=false; await retry(); assert.equal((await record()).action_status,'applied'); assert.deepEqual(calls,['ban','unban','log']);
});
test('uncertain ban claim acknowledgement prevents dispatch and a later restart never blindly repeats PUT',async () => {
  failClaim='ban'; await run(); assert.deepEqual(calls,[]); assert.equal((await event()).ban_status,'pending'); failClaim=undefined;
  // Simulate a committed claim whose COMMIT acknowledgement was lost before dispatch.
  await query("UPDATE honeypot_events SET ban_status='applying'"); await retry(); assert.deepEqual(calls,[]); assert.equal((await event()).ban_status,'unconfirmed');
});
test('failed log outcome audit preserves the claim and cannot resend notifications',async () => {
  failAudit='SOFTBAN_LOG_SENT'; await run(); assert.equal((await record()).log_status,'sending'); failAudit=undefined;
  await retry(); assert.deepEqual(calls,['ban','unban','log']);
});
test('settings authorization is refreshed inside the save transaction after page access was granted',async () => {
  const change=input({ enabled: false,readRoles: async () => [] }); await assert.rejects(saveHoneypotSettings(pool,change),/ADMIN_REQUIRED/); assert.equal((await readHoneypotSettings(pool,guild)).enabled,true);
});
test('an expired queued event never creates a late softban',async () => {
  await enqueue(); await query("UPDATE honeypot_events SET occurred_at=NOW()-INTERVAL '11 minutes'"); await processHoneypotJob(pool,guild,deps); assert.deepEqual(calls,[]); assert.equal((await event()).ban_status,'skipped');
});
test('case detail and /case summaries describe softbans without showing timeout fields',async () => {
  await run(); const response=await request('/cases/1'); assert.equal(response.status,200); const html=await response.text(); assert.match(html,/24 hours/); assert.match(html,/separate ban and unban/); assert.ok(!html.includes('Requested duration:'));
});

test('a quick rejoin cannot replay older queued trap messages from the same burst',async () => {
  await enqueue(); await enqueue({ id: '600000000000000002' });
  await processHoneypotJob(pool,guild,deps); context.member=true;
  await processHoneypotJob(pool,guild,deps); assert.deepEqual(calls,['ban','unban','log']);
  const second=(await query('SELECT * FROM honeypot_events WHERE message_id=$1',['600000000000000002'])).rows[0] as HoneypotRow;
  assert.equal(second.ban_status,'skipped'); assert.equal(second.case_number,null);
});
test('a genuinely new trap post after a completed softban may trigger a new case',async () => {
  await run(); context.member=true;
  await enqueue({ id: '600000000000000002' }); await processHoneypotJob(pool,guild,deps);
  assert.deepEqual(calls,['ban','unban','log','ban','unban','log']); assert.equal((await query('SELECT * FROM moderation_cases')).rowCount,2);
});
