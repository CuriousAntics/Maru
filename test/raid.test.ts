import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import type { Client, REST, RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { readRaidSettings, saveRaidSettings, parseRaidInvites, raidWindow } from '../src/raid-settings.js';
import type { RaidDependencies, RaidActor, RaidMember } from '../src/raid-settings.js';
import { createRaidPreview, confirmRaid, stopRaid } from '../src/raid-plans.js';
import type { RaidRun, RaidTarget } from '../src/raid-plans.js';
import { processRaidWork, deliverRaidLog } from '../src/raid-worker.js';
import { raidDependencies } from '../src/raid-discord.js';
import { raidSelectionKey } from '../src/raid-web.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { digest, randomToken, raidProof, settingsProof } from '../src/web-security.js';
import type { WarningDependencies, WarningCase } from '../src/warnings.js';
import { caseSummary } from '../src/handle-warning.js';
const db=new PGlite();
const guild='100000000000000001',foreign='100000000000000002',admin='200000000000000001',mod='200000000000000002',community='200000000000000003',manager='200000000000000004';
const actor='300000000000000001',user='300000000000000002',bot='300000000000000003',peer='300000000000000004',otherActor='300000000000000005',logs='400000000000000001',channel='400000000000000002';
let token=randomToken(),runId=randomUUID(),actorState: RaidActor,page: RaidMember[],members: Map<string,RaidMember>,bans: Map<string,{ reason: string | null }>,invites: Map<string,string>;
let calls: string[],sent: RESTPostAPIChannelMessageJSONBody[],canRevoke=true,transaction=false,failAudit: string | undefined,failOutcome=false,busy=false,failUnlock=false,discarded=false;
let native: 'ok'|'reject'|'lost-before'|'lost-after',revoke: 'ok'|'reject'|'lost-before'|'lost-after',readFailure=false,logFailure=false;
let pageHook: (() => Promise<void>) | undefined,memberHook: (() => Promise<void>) | undefined,inviteHook: (() => Promise<void>) | undefined;
async function query(sql: string,values?: unknown[]) {
 if(busy && sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }],rowCount: 1 };
 if(failUnlock && sql.includes('pg_advisory_unlock')) throw new Error('unlock failure');
 if(failAudit && (sql.includes(`'${failAudit}'`) || values?.[2]===failAudit)) throw new Error('private diagnostic');
 if(failOutcome && sql.includes('UPDATE moderation_cases SET action_status=')) throw new Error('outcome failed');
 const result=await db.query(sql,values); if(sql==='BEGIN') transaction=true; if(['COMMIT','ROLLBACK'].includes(sql)) transaction=false;
 return { rows: result.rows,rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool={ query,async connect() { return { query,release(e?: Error) { if(e) discarded=true; } }; } } as unknown as Pool;
function member(id=user,overrides: Partial<RaidMember>={}): RaidMember { return { id,name: `Member ${id}`,roles: [],joinedAt: new Date(Date.now()-60000).toISOString(),bot: false,owner: false,administrator: false,actorAbove: true,botAbove: true,...overrides }; }
const deps: RaidDependencies={ membersReady: true,botId: () => bot,readActor: async () => actorState,
 listMembers: async () => { await pageHook?.(); if(readFailure) throw new Error('network failed'); return page; },
 readMember: async (id) => { await memberHook?.(); return members.get(id) ?? null; },
 readInvite: async (code) => { await inviteHook?.(); if(readFailure) throw new Error('network failed'); const id=invites.get(code); return id?{ code,guildId: guild,channelId: id }:null; },
 canRevoke: async () => canRevoke,
 revokeInvite: async (code) => { assert.equal(transaction,false); assert.equal((await query('SELECT status FROM raid_invites WHERE run_id=$1 AND code=$2',[runId,code])).rows[0]?.status,'applying'); calls.push(`revoke:${code}`);
 if(revoke==='reject') throw Object.assign(new Error('forbidden'),{ status: 403 }); if(revoke==='lost-before') throw new Error('lost'); invites.delete(code); if(revoke==='lost-after') throw new Error('lost'); },
 readBan: async (id) => { if(readFailure) throw new Error('network failed'); return bans.get(id) ?? null; },
 ban: async (id,seconds,marker) => { assert.equal(transaction,false); const c=(await query('SELECT * FROM moderation_cases WHERE target_user_id=$1 ORDER BY case_number DESC LIMIT 1',[id])).rows[0] as WarningCase; assert.equal(c.action_status,'applying'); assert.equal(c.delete_message_seconds,seconds); calls.push(`ban:${id}`);
 if(native==='reject') throw Object.assign(new Error('forbidden'),{ status: 403 }); if(native==='lost-before') throw new Error('lost'); bans.set(id,{ reason: marker }); members.delete(id); if(native==='lost-after') throw new Error('lost'); },
};
const notifications: WarningDependencies={ readActorRoles: async () => actorState.roles,readContext: async () => { throw new Error('not used'); },readLogChannels: async () => [{ id: logs,name: 'logs',usable: true }],
 sendDM: async () => { throw new Error('Raid response must not send a DM'); },sendLog: async (_channel,body) => { sent.push(body); if(logFailure) throw new Error('lost'); return { id: '800000000000000001' }; } };
function input(overrides: Record<string,unknown>={}) { return { guildId: guild,actorId: actor,token,runId,revision: 1,mode: 'recent',minutes: '10',excludeCommunity: true,deleteSeconds: 86400,reason: 'Reviewed raid response',...overrides }; }
async function run() { return (await query('SELECT * FROM raid_runs WHERE guild_id=$1 AND run_id=$2',[guild,runId])).rows[0] as RaidRun; }
async function targets() { return (await query('SELECT * FROM raid_targets WHERE guild_id=$1 AND run_id=$2 ORDER BY user_id',[guild,runId])).rows as RaidTarget[]; }
async function preview() { await createRaidPreview(pool,input(),deps); await processRaidWork(pool,guild,deps); assert.equal((await run()).status,'ready'); }
async function confirm(ids=[user],codes=['designated']) { return confirmRaid(pool,{ guildId: guild,actorId: actor,token,runId,targets: ids,invites: codes,confirmation: `BAN ${ids.length} REVOKE ${codes.length}` },deps); }
async function retry() { await query('UPDATE raid_runs SET available_at=NOW()'); return processRaidWork(pool,guild,deps); }
async function complete() { for(let i=0;i<8 && (await run()).status==='executing';i++) await retry(); }
let base='',handler: ReturnType<typeof createDashboardHandler>;
const server=createServer((req,res) => { void handler(req,res); });
async function request(path='/raids',init: RequestInit={}) { return fetch(base+path,{ ...init,redirect: 'manual',headers: { connection: 'close',cookie: `maru_session=${token}`,...init.headers } }); }
async function post(path: string,body: URLSearchParams,headers: Record<string,string>={}) { return request(path,{ method: 'POST',body,headers: { origin: base,'content-type': 'application/x-www-form-urlencoded',...headers } }); }
function settingsForm(overrides: Record<string,string>={}) { return new URLSearchParams({ action: 'settings',csrf: raidProof(token,'settings','1'),revision: '1',enabled: 'true',codes: 'designated',reason: 'Configure raid tool',...overrides }); }
before(async () => {
 const dir=new URL('../migrations/',import.meta.url); for(const name of (await readdir(dir)).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort()) await db.exec(await readFile(new URL(name,dir),'utf8'));
 await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
 token=randomToken(); runId=randomUUID(); deps.membersReady=true; actorState={ roles: [admin],canBan: true,botCanBan: true,guildName: 'Development' };
 const m=member(); page=[m]; members=new Map([[user,m]]); bans=new Map(); invites=new Map([['designated',channel]]); calls=[]; sent=[]; canRevoke=true; transaction=false;
 failAudit=undefined; failOutcome=false; busy=false; failUnlock=false; discarded=false; native='ok'; revoke='ok'; readFailure=false; logFailure=false; pageHook=undefined; memberHook=undefined; inviteHook=undefined;
 await db.exec('TRUNCATE guild_settings CASCADE');
 await query('INSERT INTO guild_settings (guild_id,settings) VALUES ($1,$2::jsonb),($3,$2::jsonb)',[guild,JSON.stringify({ moderation_log_channel_id: logs }),foreign]);
 await query("INSERT INTO staff_roles (guild_id,role_id,access_level) VALUES ($1,$2,'admin'),($1,$3,'moderator')",[guild,admin,mod]);
 await query("INSERT INTO dashboard_sessions (guild_id,user_id,token_hash,display_name,expires_at) VALUES ($1,$2,$3,'Tester',NOW()+INTERVAL '1 hour')",[guild,actor,digest(token)]);
 await query('INSERT INTO raid_settings (guild_id,enabled,invite_codes,updated_by) VALUES ($1,true,$2,$3)',[guild,['designated'],actor]);
 await query('INSERT INTO community_settings (guild_id,community_role_id,updated_by) VALUES ($1,$2,$3)',[guild,community,actor]);
 handler=createDashboardHandler({ pool,guildId: guild,config: { origin: base,applicationId: bot,clientSecret: 'not-real',secure: false },isBotReady: () => true,readMemberRoles: async () => actorState.roles,raidDependencies: deps });
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await db.close(); });
test('default tool is Off; invite parser accepts designated links and rejects arbitrary URLs and oversized selections',async () => {
 await query('DELETE FROM raid_settings'); assert.equal((await readRaidSettings(pool,guild)).enabled,false);
 assert.deepEqual(parseRaidInvites('https://discord.gg/AbC, https://discord.com/invite/XYZ\nAbC'),['AbC','XYZ']);
 for(const text of ['https://evil.invalid/x','abc/path','abc?query','../x',Array.from({ length: 21 },(_,i) => `code${i}`).join(',')]) assert.throws(() => parseRaidInvites(text));
});
test('window fixes recent bounds and accepts exact offsets, rejecting ambiguity future dates inversion and oversized windows',() => {
 const now=new Date('2026-10-28T18:00:00Z'); const recent=raidWindow({ mode: 'recent',minutes: '10' },now); assert.equal(recent.start.toISOString(),'2026-10-28T17:50:00.000Z');
 assert.equal(raidWindow({ mode: 'exact',start: '2026-10-28T11:00:00-06:00',end: '2026-10-28T11:10:00-06:00' },now).start.toISOString(),'2026-10-28T17:00:00.000Z');
 for(const args of [{ mode: 'recent',minutes: '0' },{ mode: 'recent',minutes: '10081' },{ mode: 'exact',start: '2026-10-28T12:00',end: '2026-10-28T13:00' },{ mode: 'exact',start: '2026-02-30T12:00:00Z',end: '2026-03-01T12:00:00Z' },{ mode: 'exact',start: '2026-10-28T18:00:00Z',end: '2026-10-28T19:00:00Z' },{ mode: 'exact',start: '2026-10-28T18:00:00Z',end: '2026-10-28T17:00:00Z' }]) assert.throws(() => raidWindow(args,now));
});
test('settings require Admin and a current session and enablement requires member access',async () => {
 actorState.roles=[mod]; await assert.rejects(saveRaidSettings(pool,{ ...input(),enabled: true,codes: 'designated' },deps),/ACCESS_DENIED/);
 actorState.roles=[admin]; deps.membersReady=false; await assert.rejects(saveRaidSettings(pool,{ ...input(),enabled: true,codes: 'designated' },deps),/MEMBERS_DISABLED/);
 await saveRaidSettings(pool,{ ...input(),enabled: false,codes: 'designated' },deps); assert.equal((await readRaidSettings(pool,guild)).enabled,false);
});
test('settings are revisioned atomic and no-op changes do not duplicate audit',async () => {
 await saveRaidSettings(pool,{ ...input(),enabled: true,codes: 'designated' },deps); assert.equal((await query('SELECT * FROM audit_events')).rowCount,0);
 failAudit='RAID_SETTINGS_CHANGED'; await assert.rejects(saveRaidSettings(pool,{ ...input(),enabled: false,codes: '' },deps)); assert.equal((await readRaidSettings(pool,guild)).enabled,true);
 failAudit=undefined; await saveRaidSettings(pool,{ ...input(),enabled: false,codes: '' },deps); await assert.rejects(saveRaidSettings(pool,{ ...input(),enabled: true,codes: '' },deps),/STALE_SETTINGS/);
});
test('ordinary Mods with native Ban Members may prepare and execute, but cannot configure',async () => {
 actorState.roles=[mod]; await preview(); await confirm(); await complete(); assert.deepEqual(calls,['revoke:designated',`ban:${user}`]);
});
test('preview performs only reads and records all default exclusions clearly',async () => {
 const ids=Array.from({ length: 9 },(_,i) => String(500000000000000000n+BigInt(i)));
 page=[member(ids[0]),member(ids[1],{ bot: true }),member(ids[2],{ roles: [mod] }),member(ids[3],{ owner: true }),member(ids[4],{ administrator: true }),member(ids[5],{ actorAbove: false }),member(ids[6],{ roles: [community] }),member(ids[7]),member(ids[8],{ roles: [manager] })];
 await query("INSERT INTO community_members (guild_id,user_id,earned_at,earned_source) VALUES ($1,$2,NOW(),'existing_role')",[guild,ids[7]]);
 await query('INSERT INTO automod_settings (guild_id,exempt_role_ids,updated_by) VALUES ($1,$2,$3)',[guild,[manager],actor]);
 await preview(); const rows=await targets(); assert.equal(rows.filter((t) => t.eligible).length,1); assert.equal(rows.filter((t) => !t.eligible && t.exclusion).length,8); assert.deepEqual(calls,[]); assert.equal((await query('SELECT * FROM moderation_cases')).rowCount,0);
});
test('Community may be included only by the explicit per-preview option; staff and bots remain excluded',async () => {
 page=[member(user,{ roles: [community] }),member(peer,{ bot: true })]; await createRaidPreview(pool,input({ excludeCommunity: false }),deps); await retry();
 assert.equal((await targets()).find((t) => t.user_id===user)?.eligible,true); assert.equal((await targets()).find((t) => t.user_id===peer)?.eligible,false);
});
test('join bounds are inclusive and members outside them never enter the preview',async () => {
 const start=new Date(Date.now()-600000),end=new Date(Date.now()-1000);
 page=[member(user,{ joinedAt: start.toISOString() }),member(peer,{ joinedAt: end.toISOString() }),member(bot,{ joinedAt: new Date(start.getTime()-1).toISOString() })];
 await createRaidPreview(pool,input({ mode: 'exact',start: start.toISOString(),end: end.toISOString() }),deps); await retry(); assert.equal((await targets()).length,2);
});
test('preview refuses partial or oversized scans and never authorizes actions for an incomplete list',async () => {
 page=Array.from({ length: 501 },(_,i) => member(String(500000000000000000n+BigInt(i)))); await createRaidPreview(pool,input(),deps); await retry(); assert.equal((await run()).status,'failed'); assert.deepEqual(calls,[]); await assert.rejects(confirm(),/PREVIEW_EXPIRED/);
});
test('pagination persists cursor across restart and requires a complete scan before confirmation',async () => {
 page=Array.from({ length: 1000 },(_,i) => member(String(500000000000000000n+BigInt(i)),{ joinedAt: '2020-01-01T00:00:00Z' })); await createRaidPreview(pool,input(),deps); await retry(); assert.equal((await run()).status,'building'); assert.equal((await run()).scanned,1000); await assert.rejects(confirm(),/PREVIEW_EXPIRED/);
 page=[member('600000000000000001')]; await retry(); assert.equal((await run()).status,'ready'); assert.equal((await targets()).length,1);
});
test('duplicate or non-advancing member pages are rejected instead of producing an incomplete ready preview',async () => {
 page=[member(),member()]; await createRaidPreview(pool,input(),deps); await retry(); assert.equal((await run()).status,'failed'); assert.deepEqual(calls,[]);
});
test('confirmation requires creator, current authority, fresh session, exact counts and only preview rows',async () => {
 await preview(); await assert.rejects(confirmRaid(pool,{ guildId: guild,actorId: actor,token,runId,targets: [user],invites: ['designated'],confirmation: 'yes' },deps),/CONFIRM_REQUIRED/);
 await assert.rejects(confirm([peer]),/INVALID_SELECTION/); actorState.canBan=false; await assert.rejects(confirm(),/BAN_PERMISSION/); actorState.canBan=true;
 await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); await assert.rejects(confirm(),/SESSION_EXPIRED/); assert.deepEqual(calls,[]);
});
test('expired or changed-settings previews cannot execute',async () => {
 await preview(); await query("UPDATE raid_runs SET expires_at=NOW()-INTERVAL '1 second'"); await assert.rejects(confirm(),/PREVIEW_EXPIRED/);
 await query("UPDATE raid_runs SET expires_at=NOW()+INTERVAL '5 minutes'"); await query('UPDATE raid_settings SET revision=revision+1'); await assert.rejects(confirm(),/STALE_SETTINGS/);
});
test('confirmation audit failure rolls back every selected action and duplicate confirmation never replays',async () => {
 await preview(); failAudit='RAID_CONFIRMED'; await assert.rejects(confirm()); assert.equal((await run()).status,'ready'); assert.deepEqual(calls,[]);
 failAudit=undefined; await confirm(); await confirm(); await complete(); await confirm(); await retry(); assert.deepEqual(calls,['revoke:designated',`ban:${user}`]);
});
test('designated invite revocation happens before bans and each ban uses one shared case without DM',async () => {
 await preview(); await confirm(); await complete(); assert.deepEqual(calls,['revoke:designated',`ban:${user}`]); assert.equal((await run()).status,'complete');
 const c=(await query('SELECT * FROM moderation_cases')).rows[0] as WarningCase; assert.equal(c.origin,'raid'); assert.equal(c.dm_status,'skipped'); assert.equal(c.delete_message_seconds,86400); assert.equal(c.action_status,'applied'); assert.match(caseSummary(c),/No member DM is sent during raid response/); await deliverRaidLog(pool,guild,notifications); await deliverRaidLog(pool,guild,notifications); assert.equal(sent.length,1); assert.deepEqual(sent[0]?.allowed_mentions,{ parse: [] });
});
test('only selected frozen preview members and invites can execute; later joins are not added',async () => {
 const second=member(peer); page.push(second); members.set(peer,second); await preview(); await confirm([user],[]); await complete(); assert.deepEqual(calls,[`ban:${user}`]); assert.ok(members.has(peer)); assert.ok(invites.has('designated'));
});
test('departed members and returning memberships changed since preview are skipped without bans',async () => {
 await preview(); await confirm(); members.delete(user); await complete(); assert.deepEqual(calls,['revoke:designated']); assert.equal((await targets())[0]?.status,'skipped');
});
test('rejoining the same user after preview never matches the old membership timestamp',async () => {
 await preview(); await confirm(); members.get(user)!.joinedAt=new Date().toISOString(); await complete(); assert.deepEqual(calls,['revoke:designated']); assert.match((await targets())[0]!.note,/Membership changed/);
});
test('new staff role, native staff permission, or permanent Community award before dispatch protects the target',async () => {
 await preview(); await confirm(); await retry(); members.get(user)!.roles=[mod]; await retry(); assert.deepEqual(calls,['revoke:designated']); assert.equal((await targets())[0]?.status,'skipped');
});
test('fresh permanent award checks protect returning members even without their Community role',async () => {
 await preview(); await confirm(); await query("INSERT INTO community_members (guild_id,user_id,earned_at,earned_source) VALUES ($1,$2,NOW(),'messages')",[guild,user]); await complete(); assert.deepEqual(calls,['revoke:designated']); assert.equal((await targets())[0]?.status,'skipped');
});
test('preexisting bans are not overwritten and no additional message deletion is requested',async () => {
 await preview(); await confirm(); bans.set(user,{ reason: 'Other staff ban' }); await complete(); assert.deepEqual(calls,['revoke:designated']); assert.equal(bans.get(user)?.reason,'Other staff ban');
});
test('missing invite permissions stop before any ban and do not delete the invite',async () => {
 await preview(); await confirm(); canRevoke=false; await retry(); assert.equal((await run()).status,'stopped'); assert.deepEqual(calls,[]);
});
test('already absent designated invites do not authorize arbitrary replacements',async () => {
 invites.delete('designated'); await preview(); await assert.rejects(confirm(),/INVALID_SELECTION/); await confirm([user],[]); await complete(); assert.deepEqual(calls,[`ban:${user}`]);
});
test('a changed invite channel stops execution rather than revoking a different link target',async () => {
 await preview(); await confirm(); invites.set('designated',logs); await retry(); assert.equal((await run()).status,'stopped'); assert.deepEqual(calls,[]);
});
test('invite request audit failure prevents deletion and safe retry can dispatch after recovery',async () => {
 await preview(); await confirm(); failAudit='RAID_INVITE_CLAIMED'; await retry(); assert.deepEqual(calls,[]); failAudit=undefined; await complete(); assert.deepEqual(calls,['revoke:designated',`ban:${user}`]);
});
test('explicit invite rejection or lost response with invite still present stops bans without blind retry',async () => {
 await preview(); await confirm(); revoke='lost-before'; await retry(); await retry(); assert.deepEqual(calls,['revoke:designated']); assert.equal((await run()).status,'stopped');
});
test('lost successful invite response is reconciled by absence and permits reviewed bans',async () => {
 await preview(); await confirm(); revoke='lost-after'; await complete(); assert.deepEqual(calls,['revoke:designated',`ban:${user}`]); assert.equal((await run()).status,'complete');
});
test('interrupted invite claim checks absence without repeating DELETE',async () => {
 await preview(); await confirm(); await query("UPDATE raid_invites SET status='applying'"); await retry(); assert.deepEqual(calls,[]); assert.equal((await run()).status,'stopped');
});
test('an interrupted claimed invite deletion with no remaining invite can recover without DELETE',async () => {
 await preview(); await confirm(); await query("UPDATE raid_invites SET status='applying'"); invites.clear(); await complete(); assert.deepEqual(calls,[`ban:${user}`]);
});
test('ban intention audit failure prevents native dispatch and rolls back allocation',async () => {
 await preview(); await confirm([user],[]); failAudit='RAID_BAN_CLAIMED'; await retry(); assert.deepEqual(calls,[]); assert.equal((await query('SELECT * FROM moderation_cases')).rowCount,0); failAudit=undefined; await complete(); assert.deepEqual(calls,[`ban:${user}`]);
});
test('lost successful ban response is confirmed by its exact run/case reason without a second PUT',async () => {
 await preview(); await confirm([user],[]); native='lost-after'; await complete(); assert.deepEqual(calls,[`ban:${user}`]); assert.equal((await targets())[0]?.status,'applied');
});
test('lost unsuccessful ban response stops remaining members and is never automatically sent again',async () => {
 const m=member(peer); page.push(m); members.set(peer,m); await preview(); await confirm([user,peer],[]); native='lost-before'; await complete(); await retry(); assert.deepEqual(calls,[`ban:${user}`]); assert.equal((await run()).status,'stopped'); assert.equal((await targets()).find((t) => t.user_id===peer)?.status,'pending');
});
test('ban outcome write failure recovers by matching reason after restart without replay',async () => {
 await preview(); await confirm([user],[]); failOutcome=true; await retry(); assert.deepEqual(calls,[`ban:${user}`]); failOutcome=false; await complete(); assert.deepEqual(calls,[`ban:${user}`]); assert.equal((await targets())[0]?.status,'applied');
});
test('an interrupted ban claim whose action was not dispatched never repeats PUT',async () => {
 await preview(); await confirm([user],[]); failOutcome=true; native='lost-before'; await retry(); failOutcome=false; await retry(); assert.deepEqual(calls,[`ban:${user}`]); assert.equal((await targets())[0]?.status,'unconfirmed');
});
test('revoked staff access, expired session, disabled tool and changed settings halt remaining execution',async () => {
 await preview(); await confirm(); actorState.roles=[]; await retry(); assert.deepEqual(calls,[]); assert.equal((await run()).status,'stopped');
});
test('expiry after confirmation stops the response before further actions',async () => {
 await preview(); await confirm(); await query("UPDATE raid_runs SET execution_until=NOW()-INTERVAL '1 second'"); await retry(); assert.equal((await run()).status,'stopped'); assert.deepEqual(calls,[]);
});
test('explicit stop leaves applied actions recorded and prevents the remainder',async () => {
 await preview(); await confirm(); await retry(); await stopRaid(pool,{ guildId: guild,actorId: actor,token,runId },deps); await complete(); assert.deepEqual(calls,['revoke:designated']); assert.ok(members.has(user));
});
test('shared locks block overlap and failed unlock discards the connection',async () => {
 await createRaidPreview(pool,input(),deps); busy=true; assert.equal(await retry(),false); assert.deepEqual(calls,[]); busy=false; failUnlock=true; await retry(); assert.equal(discarded,true);
});
test('another server cannot view or process a response, and another staff member cannot confirm it',async () => {
 await preview(); assert.equal(await processRaidWork(pool,foreign,deps),false);
 const otherToken=randomToken(); await query("INSERT INTO dashboard_sessions (guild_id,user_id,token_hash,display_name,expires_at) VALUES ($1,$2,$3,'Other',NOW()+INTERVAL '1 hour')",[guild,otherActor,digest(otherToken)]);
 await assert.rejects(confirmRaid(pool,{ guildId: guild,actorId: otherActor,token: otherToken,runId,targets: [user],invites: [],confirmation: 'BAN 1 REVOKE 0' },deps),/ACCESS_DENIED/); assert.deepEqual(calls,[]);
});
test('log response loss is independent of the native ban and never repeats the log',async () => {
 await preview(); await confirm([user],[]); await complete(); logFailure=true; await deliverRaidLog(pool,guild,notifications); await deliverRaidLog(pool,guild,notifications); assert.equal(sent.length,1); assert.deepEqual(calls,[`ban:${user}`]);
});
test('HTTP requires authentication, uses GET/POST only, and keeps settings Admin-only while allowing Mod previews',async () => {
 assert.equal((await request('/raids',{ headers: { cookie: '' } })).status,303); assert.equal((await request('/raids',{ method: 'DELETE' })).status,405);
 actorState.roles=[mod]; const html=await (await request()).text(); assert.match(html,/fieldset disabled/); assert.equal((await post('/raids',settingsForm())).status,403);
});
test('HTTP rejects foreign/null origins unrelated proofs duplicate or oversized fields and preserves settings',async () => {
 for(const origin of ['null','https://other.invalid','']) assert.equal((await post('/raids',settingsForm(),{ origin })).status,403);
 assert.equal((await post('/raids',settingsForm({ csrf: settingsProof(token) }))).status,403);
 const duplicate=settingsForm(); duplicate.append('enabled','false'); assert.equal((await post('/raids',duplicate)).status,409);
 assert.equal((await post('/raids',settingsForm({ reason: 'x'.repeat(33000) }))).status,409); assert.equal((await readRaidSettings(pool,guild)).enabled,true);
});
test('HTTP preview then selection review performs no mutations and final proof is bound to the selected IDs',async () => {
 const p=new URLSearchParams({ action: 'preview',csrf: raidProof(token,'preview',runId),run_id: runId,revision: '1',mode: 'recent',minutes: '10',start: '',end: '',exclude_community: 'true',delete_history: '0',reason: 'Review candidates' });
 assert.equal((await post('/raids',p)).status,303); await retry(); assert.deepEqual(calls,[]);
 const review=new URLSearchParams({ action: 'review',csrf: raidProof(token,'review',runId),target: user }); const response=await post(`/raids/${runId}`,review); const html=await response.text(); assert.equal(response.status,200); assert.match(html,/BAN 1 REVOKE 0/); assert.deepEqual(calls,[]);
 const execution=new URLSearchParams({ action: 'execute',csrf: raidProof(token,'execute',raidSelectionKey(runId,[user],[])),target: user,confirmation: 'BAN 1 REVOKE 0' }); execution.set('target',peer); assert.equal((await post(`/raids/${runId}`,execution)).status,403);
 execution.set('target',user); assert.equal((await post(`/raids/${runId}`,execution)).status,303); await complete(); assert.deepEqual(calls,[`ban:${user}`]);
});
test('HTTP preview escapes names and reasons, shows exclusions, and rejects foreign run IDs',async () => {
 page=[member(user,{ name: '<script>bad</script>',roles: [community] })]; await createRaidPreview(pool,input({ reason: '<img src=x>' }),deps); await retry(); const html=await (await request(`/raids/${runId}`)).text(); assert.ok(html.includes('&lt;script&gt;bad')); assert.ok(html.includes('&lt;img')); assert.match(html,/Excluded:/); assert.match(html,/disabled/);
 assert.equal((await request(`/raids/${randomUUID()}`)).status,404); assert.equal((await request('/raids/not-a-uuid')).status,404);
});
test('adapter accepts actual REST 204 ban output and validates invite objects and unknown resource codes',async () => {
 const ops: { method: string; route: string; options: unknown }[]=[];
 const client={ user: { id: bot },guilds: { fetch: async () => ({ vanityURLCode: null }) } } as unknown as Client;
 let unknown=false;
 const rest={ get: async (route: string) => { if(unknown) throw { code: route.includes('/invites/')?10006:10026 }; if(route.includes('/invites/')) return { code: 'designated',guild: { id: guild },channel: { id: channel } }; return { user: { id: user },reason: 'marker' }; },put: async (route: string,options: unknown) => { ops.push({ method: 'put',route,options }); return new ArrayBuffer(0); },delete: async (route: string,options: unknown) => { ops.push({ method: 'delete',route,options }); return { code: 'designated',guild: { id: guild } }; } };
 const adapter=raidDependencies(client,guild,'test-token',true,rest as unknown as REST); await adapter.ban(user,86400,'marker'); assert.deepEqual((ops[0]?.options as { body: unknown }).body,{ delete_message_seconds: 86400 }); await adapter.revokeInvite('designated',runId,channel); assert.equal(ops[1]?.route,'/invites/designated'); unknown=true; assert.equal(await adapter.readInvite('designated'),null); assert.equal(await adapter.readBan(user),null);
});
test('adapter refuses foreign-server invites and malformed mutation output rather than claiming success',async () => {
 const client={ user: { id: bot } } as Client;
 const rest={ get: async () => ({ code: 'designated',guild: { id: foreign },channel: { id: channel } }),put: async () => new ArrayBuffer(1),delete: async () => null };
 const adapter=raidDependencies(client,guild,'test-token',true,rest as unknown as REST); await assert.rejects(adapter.readInvite('designated'),/FOREIGN_OR_INVALID/); await assert.rejects(adapter.ban(user,0,'marker'),/UNCONFIRMED/);
});
test('explicit invite rejection stops all bans and records the rejection once',async () => {
 await preview(); await confirm(); revoke='reject'; await complete(); assert.deepEqual(calls,['revoke:designated']); assert.equal((await run()).status,'stopped'); assert.equal((await query('SELECT status FROM raid_invites')).rows[0]?.status,'rejected');
});
test('explicit ban rejection saves a rejected case and stops the remaining targets',async () => {
 await preview(); await confirm([user],[]); native='reject'; await complete(); assert.equal((await targets())[0]?.status,'rejected'); assert.equal((await run()).status,'stopped'); assert.deepEqual(calls,[`ban:${user}`]);
});
test('tool disablement and settings changes after confirmation stop pending actions',async () => {
 await preview(); await confirm(); await query('UPDATE raid_settings SET enabled=false'); await retry(); assert.deepEqual(calls,[]); assert.equal((await run()).status,'stopped');
});
test('settings revision changes invalidate an executing response before its next native action',async () => {
 await preview(); await confirm(); await query('UPDATE raid_settings SET revision=revision+1'); await retry(); assert.deepEqual(calls,[]); assert.equal((await run()).status,'stopped');
});
test('logout or session expiry halts a confirmed response',async () => {
 await preview(); await confirm(); await query('DELETE FROM dashboard_sessions'); await retry(); assert.deepEqual(calls,[]); assert.equal((await run()).status,'stopped');
});
test('lost native Ban Members on either actor or bot prevents preparation and execution',async () => {
 actorState.botCanBan=false; await assert.rejects(createRaidPreview(pool,input(),deps),/BAN_PERMISSION/); actorState.botCanBan=true;
 await preview(); await confirm([user],[]); actorState.canBan=false; await retry(); assert.deepEqual(calls,[]); assert.equal((await run()).status,'stopped');
});
test('cancellation while a slow invite lookup is running is checked before claiming deletion',async () => {
 await preview(); await confirm(); inviteHook=async () => { await query("UPDATE raid_runs SET status='stopped' WHERE run_id=$1",[runId]); }; await retry(); assert.deepEqual(calls,[]); assert.equal((await run()).status,'stopped');
});
test('a native staff permission acquired after preview excludes the target',async () => {
 await preview(); await confirm([user],[]); members.get(user)!.staffPermissions=true; await complete(); assert.deepEqual(calls,[]); assert.match((await targets())[0]!.note,/Staff permissions/);
});
test('a global protected role added after preview excludes the target',async () => {
 await preview(); await confirm([user],[]); members.get(user)!.roles=[manager]; await query('INSERT INTO automod_settings (guild_id,exempt_role_ids,updated_by) VALUES ($1,$2,$3)',[guild,[manager],actor]); await complete(); assert.deepEqual(calls,[]); assert.equal((await targets())[0]?.status,'skipped');
});
test('a target above the actor or bot at dispatch is skipped without case allocation',async () => {
 await preview(); await confirm([user],[]); members.get(user)!.botAbove=false; await complete(); assert.deepEqual(calls,[]); assert.equal((await query('SELECT * FROM moderation_cases')).rowCount,0);
});
test('no request audit means no preview or external effects',async () => {
 failAudit='RAID_PREVIEW_REQUESTED'; await assert.rejects(createRaidPreview(pool,input(),deps)); assert.equal(await run(),undefined); assert.deepEqual(calls,[]);
});
test('temporary build failures preserve the cursor without authorizing partial actions',async () => {
 await createRaidPreview(pool,input(),deps); readFailure=true; await retry(); assert.equal((await run()).status,'building'); assert.deepEqual(calls,[]); readFailure=false; await retry(); assert.equal((await run()).status,'ready');
});
test('a missing moderation log destination prevents a new preview',async () => {
 await query("UPDATE guild_settings SET settings='{}' WHERE guild_id=$1",[guild]); await assert.rejects(createRaidPreview(pool,input(),deps),/LOG_REQUIRED/); assert.deepEqual(calls,[]);
});
test('raid cases retain the shared case sequence and enforce no DM at the database layer',async () => {
 await query('INSERT INTO guild_case_counters (guild_id,last_case_number) VALUES ($1,9)',[guild]); await preview(); await confirm([user],[]); await complete(); const c=(await query('SELECT * FROM moderation_cases')).rows[0] as WarningCase; assert.equal(c.case_number,10); await assert.rejects(query("UPDATE moderation_cases SET dm_status='pending'"));
});
test('failed outcome audit after confirmed native ban recovers once from the owned reason',async () => {
 await preview(); await confirm([user],[]); failAudit='RAID_BAN_RESULT'; await retry(); assert.deepEqual(calls,[`ban:${user}`]); failAudit=undefined; await complete(); assert.deepEqual(calls,[`ban:${user}`]); assert.equal((await targets())[0]?.status,'applied');
});
test('failed invite outcome audit recovers by absence without replaying the deletion',async () => {
 await preview(); await confirm(); failAudit='RAID_INVITE_RESULT'; await retry(); assert.deepEqual(calls,['revoke:designated']); failAudit=undefined; await complete(); assert.deepEqual(calls,['revoke:designated',`ban:${user}`]);
});
test('an interrupted ban with someone else\'s reason remains unconfirmed and is never overwritten',async () => {
 await preview(); await confirm([user],[]); native='lost-before'; failOutcome=true; await retry(); failOutcome=false; bans.set(user,{ reason: 'Separate moderator action' }); await retry(); assert.deepEqual(calls,[`ban:${user}`]); assert.equal((await targets())[0]?.status,'unconfirmed'); assert.equal(bans.get(user)?.reason,'Separate moderator action');
});
test('failed log outcome audit never repeats the already claimed notification',async () => {
 await preview(); await confirm([user],[]); await complete(); failAudit='BAN_LOG_SENT'; await deliverRaidLog(pool,guild,notifications); failAudit=undefined; await deliverRaidLog(pool,guild,notifications); assert.equal(sent.length,1);
});
test('Admin may stop another creator\'s response without native Ban Members permission',async () => {
 await preview(); const differentToken=randomToken(); await query("INSERT INTO dashboard_sessions (guild_id,user_id,token_hash,display_name,expires_at) VALUES ($1,$2,$3,'Other',NOW()+INTERVAL '1 hour')",[guild,otherActor,digest(differentToken)]); actorState.canBan=false;
 await stopRaid(pool,{ guildId: guild,actorId: otherActor,token: differentToken,runId },deps); assert.equal((await run()).status,'stopped'); assert.deepEqual(calls,[]);
});
test('HTTP rejects excluded target selection and cannot execute with a review proof',async () => {
 page=[member(user,{ bot: true })]; await preview(); const selection=new URLSearchParams({ action: 'review',csrf: raidProof(token,'review',runId),target: user }); assert.equal((await post(`/raids/${runId}`,selection)).status,409);
 selection.set('action','execute'); selection.append('confirmation','BAN 1 REVOKE 0'); assert.equal((await post(`/raids/${runId}`,selection)).status,403); assert.deepEqual(calls,[]);
});
test('case pages label raid origin and skipped DM honestly without a pre-ban notice claim',async () => {
 await preview(); await confirm([user],[]); await complete(); const html=await (await request('/cases/1')).text(); assert.match(html,/Origin: Manual raid response/); assert.match(html,/No pre-ban DM is sent for raid response/); assert.ok(!html.includes('Ban notices are attempted before the ban'));
});

test('only one saved preview can begin execution at a time',async () => {
 await preview(); const another=randomUUID(); await createRaidPreview(pool,input({ runId: another }),deps); await retry(); await confirm();
 await assert.rejects(confirmRaid(pool,{ guildId: guild,actorId: actor,token,runId: another,targets: [user],invites: [],confirmation: 'BAN 1 REVOKE 0' },deps),/BUSY/); assert.deepEqual(calls,[]);
});
test('adapter computes hierarchy and Administrator status from current roles and requires invite authority for both actor and bot',async () => {
 const makeRole=(id: string,position: number,bits=0n) => ({ id,position,permissions: new PermissionsBitField(bits),comparePositionTo(r: { position: number }) { return position-r.position; } });
 const everyone=makeRole(guild,0),targetRole=makeRole(community,1),staffRole=makeRole(mod,3),botRole=makeRole(admin,4);
 const roleMap=new Map([[guild,everyone],[community,targetRole],[mod,staffRole],[admin,botRole]]);
 const staff={ id: actor,roles: { highest: staffRole,cache: new Map([[mod,staffRole]]) },permissions: new PermissionsBitField(PermissionFlagsBits.BanMembers) };
 const me={ id: bot,roles: { highest: botRole },permissions: new PermissionsBitField(PermissionFlagsBits.BanMembers) };
 let botInvitePermission=true;
 const guildObject={ id: guild,name: 'Development',ownerId: otherActor,roles: { cache: roleMap,everyone,fetch: async () => roleMap },members: { fetch: async () => staff,fetchMe: async () => me },channels: { fetch: async () => ({ permissionsFor: (who: { id: string }) => new PermissionsBitField(who.id===bot && !botInvitePermission?0n:PermissionFlagsBits.ManageChannels) }) } };
 const client={ user: { id: bot },guilds: { fetch: async () => guildObject } } as unknown as Client;
 const raw={ user: { id: user,username: 'Tester' },roles: [community],joined_at: new Date().toISOString() };
 const rest={ get: async (route: string) => route.endsWith('/members')?[raw]:raw,put: async () => null,delete: async () => null };
 const adapter=raidDependencies(client,guild,'test-token',true,rest as unknown as REST);
 assert.equal((await adapter.readActor(actor)).canBan,true); const target=await adapter.readMember(user,actor); assert.equal(target?.actorAbove,true); assert.equal(target?.botAbove,true); assert.equal(target?.administrator,false);
 targetRole.permissions.add(PermissionFlagsBits.Administrator); assert.equal((await adapter.listMembers('0',actor))[0]?.administrator,true);
 assert.equal(await adapter.canRevoke(actor,channel),true); botInvitePermission=false; assert.equal(await adapter.canRevoke(actor,channel),false);
});
test('vanity links cannot be revoked through the ordinary designated-invite adapter',async () => {
 const client={ user: { id: bot },guilds: { fetch: async () => ({ vanityURLCode: 'designated' }) } } as unknown as Client;
 const rest={ get: async () => ({ code: 'designated',guild: { id: guild },channel: { id: channel } }),put: async () => null,delete: async () => { throw new Error('must not delete'); } };
 const adapter=raidDependencies(client,guild,'test-token',true,rest as unknown as REST); await assert.rejects(adapter.readInvite('designated'),/VANITY_UNSUPPORTED/);
});
