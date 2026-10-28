import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import type { Client, REST } from 'discord.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { readCommunitySettings, saveCommunitySettings, requestCommunityCapture } from '../src/community-settings.js';
import type { CommunityResources } from '../src/community-settings.js';
import { ingestCommunity, communityTotals, rememberCommunity, processCommunityRole, processCommunityCapture } from '../src/community-engine.js';
import type { CommunityInput, CommunityMember, CommunityDependencies } from '../src/community-engine.js';
import { parseCommunityPacket } from '../src/community-worker.js';
import { eligibleCommunityVoice, createCommunityVoiceClock } from '../src/community-voice.js';
import type { CommunityVoiceState } from '../src/community-voice.js';
import { communityDependencies, communityResources } from '../src/community-discord.js';
import { digest, randomToken, communityProof, honeypotProof } from '../src/web-security.js';
const db=new PGlite();
const guild='100000000000000001',foreign='100000000000000002',admin='200000000000000001',mod='200000000000000002',nomad='200000000000000003',community='200000000000000004';
const actor='300000000000000001',user='300000000000000002',bot='300000000000000003',peer='300000000000000004';
const channel='400000000000000001',ignored='400000000000000002',voice='400000000000000003',afk='400000000000000004';
let token=randomToken(),roles: string[] | null,resources: CommunityResources;
let members: Map<string,CommunityMember>,calls: string[],usable: boolean;
let failAudit: string | undefined,failOutcome=false,transaction=false,busy=false,failUnlock=false,discarded=false;
let native: 'ok'|'lost-before'|'lost-after',contextHook: (() => Promise<void>) | undefined;
let page: CommunityMember[],pageHook: (() => Promise<void>) | undefined;
async function query(sql: string,values?: unknown[]) {
 if(busy && sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }],rowCount: 1 };
 if(failUnlock && sql.includes('pg_advisory_unlock')) throw new Error('unlock failed');
 if(failAudit && (sql.includes(`'${failAudit}'`) || values?.[2]===failAudit)) throw new Error('private audit failure');
 if(failOutcome && sql.includes('SET processed_version=')) throw new Error('outcome failed');
 const result=await db.query(sql,values); if(sql==='BEGIN') transaction=true; if(['COMMIT','ROLLBACK'].includes(sql)) transaction=false;
 return { rows: result.rows,rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool={ query,async connect() { return { query,release(error?: Error) { if(error) discarded=true; } }; } } as unknown as Pool;
const deps: CommunityDependencies={ botId: () => bot,readMember: async (id) => { await contextHook?.(); const m=members.get(id); return m?{ ...m,roles: [...m.roles] }:null; },roleUsable: async () => usable,
 addRole: async (id,role) => { assert.equal(transaction,false); calls.push(`add:${role}`); if(native==='lost-before') throw new Error('lost'); members.get(id)!.roles.push(role); if(native==='lost-after') throw new Error('lost'); },
 removeRole: async (id,role) => { assert.equal(transaction,false); assert.ok(members.get(id)!.roles.includes(community)); calls.push(`remove:${role}`); if(native==='lost-before') throw new Error('lost'); members.get(id)!.roles=members.get(id)!.roles.filter((r) => r!==role); if(native==='lost-after') throw new Error('lost'); },
 listMembers: async () => { await pageHook?.(); return page; },
};
function input(overrides: Record<string,unknown>={}) { return { guildId: guild,actorId: actor,token,revision: 1,tracking: true,assignRoles: true,nomad,community,excluded: [ignored],afk: [afk],messages: 30,voiceSeconds: 6000,days: 30,reason: 'Configure roles',readRoles: async () => roles,readResources: async () => resources,...overrides }; }
let sequence=600000000000000000n;
function message(overrides: Record<string,unknown>={}): CommunityInput { return { kind: 'message',userId: user,channelId: channel,messageId: String(++sequence),at: new Date(),revision: 1,...overrides } as CommunityInput; }
function interval(seconds: number,end=new Date(),overrides: Record<string,unknown>={}): CommunityInput { return { kind: 'voice',userId: user,channelId: voice,start: new Date(end.getTime()-seconds*1000),end,revision: 1,...overrides } as CommunityInput; }
async function ingest(events: CommunityInput[]) { return ingestCommunity(pool,guild,events,bot); }
async function earned(id=user) { return (await query('SELECT * FROM community_members WHERE guild_id=$1 AND user_id=$2',[guild,id])).rows[0] as { earned_at: Date | null; earned_source: string } | undefined; }
async function job() { await query('INSERT INTO community_role_jobs (guild_id,user_id) VALUES ($1,$2) ON CONFLICT (guild_id,user_id) DO UPDATE SET version=community_role_jobs.version+1,available_at=NOW()',[guild,user]); }
async function retry() { await query('UPDATE community_role_jobs SET available_at=NOW()'); return processCommunityRole(pool,guild,deps); }
let base='',handler: ReturnType<typeof createDashboardHandler>;
const server=createServer((req,res) => { void handler(req,res); });
async function request(path='/community',init: RequestInit={}) { return fetch(base+path,{ ...init,redirect: 'manual',headers: { connection: 'close',cookie: `maru_session=${token}`,...init.headers } }); }
function form(overrides: Record<string,string>={}) { return new URLSearchParams({ action: 'save',csrf: communityProof(token,1,'save'),revision: '1',tracking: 'true',roles: 'true',nomad,community,messages: '30',voice_minutes: '100',days: '30',excluded: ignored,afk,reason: 'Configure roles',...overrides }); }
async function post(body=form(),headers: Record<string,string>={}) { return request('/community',{ method: 'POST',body,headers: { origin: base,'content-type': 'application/x-www-form-urlencoded',...headers } }); }
before(async () => {
 for(const name of ['001_foundation.sql','002_dashboard_auth.sql','015_community_roles.sql']) await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
 await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
 failAudit=undefined; failOutcome=false; transaction=false; busy=false; failUnlock=false; discarded=false; native='ok'; contextHook=undefined; pageHook=undefined;
 token=randomToken(); roles=[admin]; resources={ eventsReady: true,roles: [{ id: nomad,name: 'Nomad',usable: true },{ id: community,name: 'Community',usable: true }],channels: [{ id: ignored,name: 'finished-work' }],voiceChannels: [{ id: afk,name: 'AFK' }] };
 members=new Map([[user,{ id: user,roles: [],bot: false }]]); calls=[]; usable=true; page=[];
 await db.exec('TRUNCATE guild_settings CASCADE');
 await query('INSERT INTO guild_settings (guild_id) VALUES ($1),($2)',[guild,foreign]);
 await query("INSERT INTO staff_roles (guild_id,role_id,access_level) VALUES ($1,$2,'admin'),($1,$3,'moderator')",[guild,admin,mod]);
 await query("INSERT INTO dashboard_sessions (guild_id,user_id,token_hash,display_name,expires_at) VALUES ($1,$2,$3,'Tester',NOW()+INTERVAL '1 hour')",[guild,actor,digest(token)]);
 await query(`INSERT INTO community_settings (guild_id,tracking_enabled,roles_enabled,nomad_role_id,community_role_id,excluded_channel_ids,afk_channel_ids,updated_by,updated_at)
 VALUES ($1,true,true,$2,$3,$4,$5,$6,NOW()-INTERVAL '1 day')`,[guild,nomad,community,[ignored],[afk],actor]);
 handler=createDashboardHandler({ pool,guildId: guild,config: { origin: base,applicationId: bot,clientSecret: 'not-real',secure: false },isBotReady: () => true,readMemberRoles: async () => roles,readCommunityResources: async () => resources });
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await db.close(); });
test('defaults preserve 30 messages OR 100 minutes over 30 days with both switches Off',async () => {
 await query('DELETE FROM community_settings'); const s=await readCommunitySettings(pool,guild); assert.equal(s.tracking_enabled,false); assert.equal(s.roles_enabled,false); assert.equal(s.message_threshold,30); assert.equal(s.voice_seconds,6000); assert.equal(s.window_days,30);
});
test('settings save requires current Admin, session, exact revision, bounded limits and reason',async () => {
 for(const r of [null,[],[mod]]) { roles=r; await assert.rejects(saveCommunitySettings(pool,input()),/ADMIN_REQUIRED/); } roles=[admin];
 await assert.rejects(saveCommunitySettings(pool,input({ revision: 0 })),/STALE_SETTINGS/);
 for(const change of [{ days: 0 },{ messages: 0 },{ voiceSeconds: 0 },{ excluded: [ignored,ignored] },{ nomad: community }]) await assert.rejects(saveCommunitySettings(pool,input(change)));
 await assert.rejects(saveCommunitySettings(pool,input({ reason: '' })),/INVALID_REASON/);
 await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); await assert.rejects(saveCommunitySettings(pool,input()),/SESSION_EXPIRED/);
});
test('settings cannot enable without event intake or usable distinct member roles, including staff mappings without native permissions',async () => {
 resources.eventsReady=false; await assert.rejects(saveCommunitySettings(pool,input()),/EVENTS_DISABLED/); resources.eventsReady=true;
 resources.roles[0]!.usable=false; await assert.rejects(saveCommunitySettings(pool,input()),/INVALID_ROLES/); resources.roles[0]!.usable=true;
 await query("INSERT INTO staff_roles (guild_id,role_id,access_level) VALUES ($1,$2,'moderator')",[guild,community]); await assert.rejects(saveCommunitySettings(pool,input()),/INVALID_ROLES/);
});
test('full-access Mod may save only while current Mod role is retained',async () => {
 roles=[mod]; await query('INSERT INTO staff_access_grants (guild_id,user_id,granted_by) VALUES ($1,$2,$2)',[guild,actor]); await saveCommunitySettings(pool,input({ tracking: false })); roles=[];
 await assert.rejects(saveCommunitySettings(pool,input({ revision: 2 })),/ADMIN_REQUIRED/);
});
test('configuration is atomic, leaves other server settings intact, and no-op saves do not duplicate audit',async () => {
 await saveCommunitySettings(pool,input()); assert.equal((await query('SELECT * FROM audit_events')).rowCount,0);
 failAudit='COMMUNITY_SETTINGS_CHANGED'; await assert.rejects(saveCommunitySettings(pool,input({ messages: 40 }))); assert.equal((await readCommunitySettings(pool,guild)).message_threshold,30);
 failAudit=undefined; await saveCommunitySettings(pool,input({ messages: 40 })); assert.equal((await readCommunitySettings(pool,guild)).revision,2); assert.equal((await readCommunitySettings(pool,foreign)).revision,0);
});
test('turning both switches Off works after roles and channels are deleted',async () => {
 resources.roles=[]; resources.channels=[]; resources.voiceChannels=[]; resources.eventsReady=false;
 await saveCommunitySettings(pool,input({ tracking: false,assignRoles: false })); assert.equal((await readCommunitySettings(pool,guild)).roles_enabled,false);
});
test('parser observes only human creates and current-server member updates, never edits bots or webhooks',() => {
 const raw={ t: 'MESSAGE_CREATE',d: { guild_id: guild,id: String(++sequence),channel_id: channel,author: { id: user },timestamp: new Date().toISOString() } };
 assert.equal(parseCommunityPacket(raw,guild,1)?.kind,'message');
 for(const packet of [{ ...raw,t: 'MESSAGE_UPDATE' },{ ...raw,d: { ...raw.d,guild_id: foreign } },{ ...raw,d: { ...raw.d,webhook_id: bot } },{ ...raw,d: { ...raw.d,author: { id: bot,bot: true } } },{ ...raw,d: { ...raw.d,timestamp: 'bad' } }]) assert.equal(parseCommunityPacket(packet,guild,1),undefined);
 assert.equal(parseCommunityPacket({ t: 'GUILD_MEMBER_ADD',d: { guild_id: guild,user: { id: user } } },guild,1)?.kind,'member');
});
test('thirty distinct creates earn permanent Community without requiring any voice activity',async () => {
 await ingest(Array.from({ length: 29 },() => message())); assert.equal((await earned())?.earned_at,null);
 await ingest([message()]); assert.equal((await earned())?.earned_source,'messages'); assert.ok((await earned())?.earned_at);
 assert.equal((await query("SELECT * FROM audit_events WHERE event_type='COMMUNITY_EARNED'")).rowCount,1);
});
test('duplicate messages cannot inflate progress or duplicate permanent awards',async () => {
 const m=message(); await ingest([m,m]); await ingest([m]); const totals=await communityTotals(pool,guild,user,await readCommunitySettings(pool,guild)); assert.equal(totals.messages,1);
});
test('excluded channels and their threads do not count, and members have independent counters',async () => {
 await ingest([message({ channelId: ignored }),message({ parentId: ignored }),message({ userId: peer }),message()]);
 assert.equal((await communityTotals(pool,guild,user,await readCommunitySettings(pool,guild))).messages,1); assert.equal((await communityTotals(pool,guild,peer,await readCommunitySettings(pool,guild))).messages,1);
});
test('Off, old revision, pre-settings, old replayed and future activity do not count',async () => {
 await ingest([message({ revision: 0 }),message({ at: new Date(Date.now()-180000) }),message({ at: new Date(Date.now()+60000) })]); assert.equal((await query('SELECT * FROM community_messages')).rowCount,0);
 await query('UPDATE community_settings SET tracking_enabled=false'); await ingest([message()]); assert.equal((await query('SELECT * FROM community_messages')).rowCount,0);
});
test('rolling window excludes the exact left boundary and clips voice intervals crossing it',async () => {
 const now=new Date(),left=new Date(now.getTime()-30*86400000);
 await query('INSERT INTO community_messages (guild_id,message_id,user_id,channel_id,occurred_at) VALUES ($1,$2,$3,$4,$5)',[guild,String(++sequence),user,channel,left]);
 await query('INSERT INTO community_voice (guild_id,user_id,channel_id,started_at,ended_at) VALUES ($1,$2,$3,$4,$5)',[guild,user,voice,new Date(left.getTime()-10000),new Date(left.getTime()+10000)]);
 const total=await communityTotals(pool,guild,user,await readCommunitySettings(pool,guild),now); assert.equal(total.messages,0); assert.equal(total.voiceSeconds,10);
});
test('one hundred voice minutes qualify independently from messages',async () => {
 await query('UPDATE community_settings SET updated_at=NOW()-INTERVAL \'1 day\'');
 const end=Date.now(),events=Array.from({ length: 200 },(_,i) => interval(30,new Date(end-(199-i)*30000)));
 await ingest(events); assert.equal((await earned())?.earned_source,'voice'); assert.equal((await query('SELECT * FROM community_messages')).rowCount,0);
});
test('overlapping samples, duplicates and another worker cannot double-credit voice',async () => {
 const end=new Date(); const first=interval(20,new Date(end.getTime()-10000)); await ingest([first,first]); await ingest([interval(20,end)]);
 assert.equal((await communityTotals(pool,guild,user,await readCommunitySettings(pool,guild))).voiceSeconds,30);
});
test('AFK and long unexplained gaps never receive voice credit',async () => {
 await ingest([interval(20,new Date(),{ channelId: afk }),interval(31)]); assert.equal((await query('SELECT * FROM community_voice')).rowCount,0);
});
test('voice needs two humans; bots and unknown members cannot satisfy the peer requirement',() => {
 const state: CommunityVoiceState={ userId: user,channelId: voice,bot: false,muted: false,deafened: false,suppressed: false };
 assert.deepEqual(eligibleCommunityVoice([state],[]),[]); assert.deepEqual(eligibleCommunityVoice([state,{ ...state,userId: bot,bot: true }],[]),[]); assert.deepEqual(eligibleCommunityVoice([state,{ ...state,userId: peer,bot: null }],[]),[]);
 assert.equal(eligibleCommunityVoice([state,{ ...state,userId: peer }],[]).length,2);
});
test('mute deafening suppression and AFK exclude credit; a muted human is still present as a peer',() => {
 const s: CommunityVoiceState={ userId: user,channelId: voice,bot: false,muted: false,deafened: false,suppressed: false };
 for(const change of [{ muted: true },{ deafened: true },{ suppressed: true }]) assert.deepEqual(eligibleCommunityVoice([s,{ ...s,userId: peer,...change }],[]).map((m) => m.userId),[user]);
 assert.deepEqual(eligibleCommunityVoice([s,{ ...s,userId: peer }],[voice]),[]);
});
test('voice transitions close old participation precisely, reset on revision and never backfill disconnects',() => {
 const clock=createCommunityVoiceClock(),start=new Date(100000),states=[{ userId: user,channelId: voice }];
 assert.deepEqual(clock.sample(states,1,start),[]); const closed=clock.sample([],1,new Date(110000)); assert.equal(closed.length,1); assert.equal((closed[0] as { end: Date }).end.getTime(),110000);
 assert.deepEqual(clock.sample(states,2,new Date(120000)),[]); clock.reset(); assert.deepEqual(clock.sample(states,2,new Date(180000)),[]);
 assert.deepEqual(clock.sample(states,2,new Date(240000)),[]);
});
test('Nomad is assigned on observed joining without changing unrelated roles',async () => {
 members.get(user)!.roles=[mod]; await ingest([{ kind: 'member',userId: user,at: new Date(),revision: 1 }]); await processCommunityRole(pool,guild,deps); assert.deepEqual(calls,[`add:${nomad}`]); assert.deepEqual(members.get(user)!.roles,[mod,nomad]);
});
test('promotion adds and confirms Community before removing Nomad',async () => {
 members.get(user)!.roles=[nomad,mod]; await rememberCommunity(pool,guild,user,'messages',bot); await job(); await processCommunityRole(pool,guild,deps);
 assert.deepEqual(calls,[`add:${community}`,`remove:${nomad}`]); assert.deepEqual(members.get(user)!.roles,[mod,community]);
});
test('permanent Community survives inactivity, leaving, rejoining and restart',async () => {
 await rememberCommunity(pool,guild,user,'messages',bot); await query('DELETE FROM community_messages'); members.delete(user); await job(); await processCommunityRole(pool,guild,deps); assert.deepEqual(calls,[]);
 members.set(user,{ id: user,roles: [],bot: false }); await job(); await processCommunityRole(pool,guild,deps); assert.deepEqual(calls,[`add:${community}`]);
 await assert.rejects(query('UPDATE community_members SET earned_at=NULL,earned_source=NULL'));
});
test('existing Community role holders are adopted permanently without needing activity',async () => {
 members.get(user)!.roles=[community,nomad]; await job(); await processCommunityRole(pool,guild,deps); assert.equal((await earned())?.earned_source,'existing_role'); assert.deepEqual(calls,[`remove:${nomad}`]);
});
test('role changes Off preserves progress and existing earned state without native mutations',async () => {
 await query('UPDATE community_settings SET roles_enabled=false'); await ingest(Array.from({ length: 30 },() => message())); await processCommunityRole(pool,guild,deps); assert.ok((await earned())?.earned_at); assert.deepEqual(calls,[]);
});
test('saved role work obeys current Off state instead of an old form or event',async () => {
 await job(); await query('UPDATE community_settings SET roles_enabled=false'); await processCommunityRole(pool,guild,deps); assert.deepEqual(calls,[]);
});
test('role permission or staff-mapping changes block delivery even after configuration',async () => {
 await job(); usable=false; await processCommunityRole(pool,guild,deps); assert.deepEqual(calls,[]); usable=true;
 await query("INSERT INTO staff_roles (guild_id,role_id,access_level) VALUES ($1,$2,'moderator')",[guild,nomad]); await retry(); assert.deepEqual(calls,[]);
});
test('a failed Community add never removes Nomad; fresh state allows safe retry',async () => {
 members.get(user)!.roles=[nomad]; await rememberCommunity(pool,guild,user,'messages',bot); await job(); native='lost-before'; await processCommunityRole(pool,guild,deps); assert.deepEqual(calls,[`add:${community}`]); assert.deepEqual(members.get(user)!.roles,[nomad]);
 native='ok'; await retry(); assert.deepEqual(calls,[`add:${community}`,`add:${community}`,`remove:${nomad}`]);
});
test('a lost successful response is reconciled from current state without duplicate role writes',async () => {
 native='lost-after'; await job(); await processCommunityRole(pool,guild,deps); await retry(); assert.deepEqual(calls,[`add:${nomad}`]);
});
test('role request audit failure prevents every mutation; outcome failure is idempotent after restart',async () => {
 await job(); failAudit='COMMUNITY_ROLE_REQUESTED'; await processCommunityRole(pool,guild,deps); assert.deepEqual(calls,[]);
 failAudit=undefined; failOutcome=true; await retry(); assert.deepEqual(calls,[`add:${nomad}`]); failOutcome=false; await retry(); assert.deepEqual(calls,[`add:${nomad}`]);
});
test('earning audit failure rolls back activity and award before any role work',async () => {
 failAudit='COMMUNITY_EARNED'; await assert.rejects(ingest(Array.from({ length: 30 },() => message()))); assert.equal((await query('SELECT * FROM community_messages')).rowCount,0); assert.equal(await earned(),undefined); assert.deepEqual(calls,[]);
});
test('bots and departed members receive no roles; member lookup errors do not imply departure',async () => {
 members.get(user)!.bot=true; await job(); await processCommunityRole(pool,guild,deps); assert.deepEqual(calls,[]);
 members.get(user)!.bot=false; contextHook=async () => { throw new Error('lookup unavailable'); }; await job(); await processCommunityRole(pool,guild,deps); assert.deepEqual(calls,[]); contextHook=undefined; await retry(); assert.deepEqual(calls,[`add:${nomad}`]);
});
test('shared member mutex blocks overlap and unsafe unlock discards the connection',async () => {
 await job(); busy=true; await processCommunityRole(pool,guild,deps); assert.deepEqual(calls,[]); busy=false; failUnlock=true; await processCommunityRole(pool,guild,deps); assert.equal(discarded,true);
});
test('capture requires current Admin and a distinct CSRF-protected request and can run with both switches Off',async () => {
 await query('UPDATE community_settings SET roles_enabled=false,tracking_enabled=false'); roles=[mod]; await assert.rejects(requestCommunityCapture(pool,input()),/ADMIN_REQUIRED/); roles=[admin];
 await requestCommunityCapture(pool,input()); page=[{ id: user,roles: [community],bot: false },{ id: bot,roles: [community],bot: true },{ id: peer,roles: [],bot: false }];
 await processCommunityCapture(pool,guild,deps); assert.equal((await earned())?.earned_source,'existing_role'); assert.equal(await earned(bot),undefined); assert.equal(await earned(peer),undefined); assert.deepEqual(calls,[]);
 assert.equal((await query('SELECT status FROM community_capture')).rows[0]?.status,'complete');
});
test('capture resumes by cursor, detects changed selected role and rolls back failed award audits',async () => {
 await requestCommunityCapture(pool,input()); page=[{ id: user,roles: [community],bot: false }]; failAudit='COMMUNITY_EARNED'; await processCommunityCapture(pool,guild,deps); assert.equal(await earned(),undefined);
 failAudit=undefined; await query('UPDATE community_settings SET community_role_id=$1',[mod]); await processCommunityCapture(pool,guild,deps); assert.equal((await query('SELECT status FROM community_capture')).rows[0]?.status,'cancelled');
});
test('another server cannot see activity roles earned state or capture jobs',async () => {
 await ingest([message()]); await job(); assert.equal(await processCommunityRole(pool,foreign,deps),false); assert.equal((await communityTotals(pool,foreign,user,await readCommunitySettings(pool,foreign))).messages,0); assert.deepEqual(calls,[]);
});
test('HTTP requires authentication, allows GET and POST only, and renders separate switches and defaults',async () => {
 assert.equal((await request('/community',{ headers: { cookie: '' } })).status,303); assert.equal((await request('/community',{ method: 'DELETE' })).status,405);
 const response=await request(); assert.equal(response.status,200); const html=await response.text(); assert.match(html,/name="messages"[^>]+value="30"/); assert.match(html,/name="voice_minutes"[^>]+value="100"/);
});
test('ordinary Mods may look up member progress but cannot save or capture',async () => {
 roles=[mod]; const html=await (await request(`/community?member=${user}`)).text(); assert.match(html,/fieldset disabled/); assert.match(html,/0 messages/); assert.equal((await post()).status,403);
});
test('HTTP saves atomically and rejects stale forms, foreign origins, null origins, unrelated proofs and duplicate fields',async () => {
 assert.equal((await post(form({ messages: '40' }))).status,303); assert.equal((await readCommunitySettings(pool,guild)).message_threshold,40);
 assert.equal((await post()).status,409);
 for(const origin of ['null','https://other.invalid','']) assert.equal((await post(form(),{ origin })).status,403);
 assert.equal((await post(form({ csrf: honeypotProof(token,1) }))).status,403);
 const duplicate=form(); duplicate.append('messages','1'); assert.equal((await post(duplicate)).status,409);
});
test('HTTP capture has its own proof, refuses injected fields, and does not change settings',async () => {
 const data=new URLSearchParams({ action: 'capture',revision: '1',reason: 'Preserve holders',csrf: communityProof(token,1,'capture') });
 assert.equal((await post(data)).status,303); assert.equal((await readCommunitySettings(pool,guild)).revision,1);
 data.append('roles','false'); assert.equal((await post(data)).status,409);
});
test('HTTP expires sessions, bounds requests and escapes names and member lookup input',async () => {
 resources.roles[0]!.name='<script>bad</script>'; assert.ok((await (await request()).text()).includes('&lt;script&gt;bad'));
 assert.equal((await post(form({ reason: 'x'.repeat(17000) }))).status,409); assert.equal((await request('/community?member=<script>')).status,400);
 await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); assert.equal((await post()).status,303);
});
test('adapter uses individual role PUT and DELETE with bounded requests and accepts actual empty REST output',async () => {
 const ops: { method: string; route: string; options: unknown }[]=[];
 const rest={ get: async (route: string) => { if(route.endsWith('/members')) return [{ user: { id: user },roles: [] }]; return { user: { id: user },roles: [] }; },
 put: async (route: string,options: unknown) => { ops.push({ method: 'put',route,options }); return new ArrayBuffer(0); },delete: async (route: string,options: unknown) => { ops.push({ method: 'delete',route,options }); return new ArrayBuffer(0); } };
 const adapter=communityDependencies({ user: { id: bot } } as Client,guild,'test-token',rest as unknown as REST);
 await adapter.addRole(user,community); await adapter.removeRole(user,nomad); assert.equal(ops[0]?.route,`/guilds/${guild}/members/${user}/roles/${community}`); assert.ok((ops[0]?.options as { signal: unknown }).signal); assert.equal((await adapter.listMembers('0'))[0]?.id,user);
});
test('adapter distinguishes unknown member from permission failure and malformed native replies',async () => {
 let code=10007; const rest={ get: async () => { throw { code }; },put: async () => new ArrayBuffer(1),delete: async () => null };
 const adapter=communityDependencies({ user: { id: bot } } as Client,guild,'test-token',rest as unknown as REST);
 assert.equal(await adapter.readMember(user),null); code=50013; await assert.rejects(adapter.readMember(user)); await assert.rejects(adapter.addRole(user,nomad),/UNCONFIRMED/);
});

test('role resources reject managed, higher, everyone and staff-permission roles',async () => {
 const entries=new Map([
 [guild,{ id: guild,name: '@everyone',managed: false,permissions: new PermissionsBitField() }],
 [nomad,{ id: nomad,name: 'Nomad',managed: false,permissions: new PermissionsBitField() }],
 [community,{ id: community,name: 'Community',managed: false,permissions: new PermissionsBitField(PermissionFlagsBits.MoveMembers) }],
 [admin,{ id: admin,name: 'Managed',managed: true,permissions: new PermissionsBitField() }],
 [mod,{ id: mod,name: 'Higher',managed: false,permissions: new PermissionsBitField() }],
 ]);
 const me={ permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),roles: { highest: { comparePositionTo: (r: { id: string }) => r.id===mod?-1:1 } } };
 const client={ guilds: { fetch: async () => ({ roles: { fetch: async () => entries },members: { fetchMe: async () => me },channels: { fetch: async () => new Map() } }) } } as unknown as Client;
 const result=await communityResources(client,guild,true)(); assert.equal(result.roles.find((r) => r.id===nomad)?.usable,true);
 for(const id of [community,admin,mod]) assert.equal(result.roles.find((r) => r.id===id)?.usable,false);
 assert.equal(result.roles.some((r) => r.id===guild),false);
});
test('eligibility is not revoked by higher thresholds or a shorter activity window',async () => {
 await rememberCommunity(pool,guild,user,'messages',bot); const before=(await earned())!.earned_at;
 await saveCommunitySettings(pool,input({ messages: 1000,days: 1 })); await processCommunityRole(pool,guild,deps);
 assert.deepEqual((await earned())!.earned_at,before); assert.deepEqual(calls,[`add:${community}`]);
});
test('capture pages commit their cursor and can finish after a handler restart',async () => {
 await requestCommunityCapture(pool,input());
 page=Array.from({ length: 1000 },(_,i) => ({ id: String(700000000000000000n+BigInt(i)),roles: [],bot: false }));
 await processCommunityCapture(pool,guild,deps); const current=(await query('SELECT cursor_id,status FROM community_capture')).rows[0] as { cursor_id: string; status: string };
 assert.equal(current.status,'running'); assert.equal(current.cursor_id,page[999]!.id);
 page=[]; await processCommunityCapture(pool,guild,deps); assert.equal((await query('SELECT status FROM community_capture')).rows[0]?.status,'complete');
});
test('an expired or role-revoked capture request cannot be accepted',async () => {
 await assert.rejects(requestCommunityCapture(pool,input({ readRoles: async () => [] })),/ADMIN_REQUIRED/);
 await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); await assert.rejects(requestCommunityCapture(pool,input()),/SESSION_EXPIRED/);
});
