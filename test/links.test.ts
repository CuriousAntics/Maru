import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { messageLinks, normalizedDomain, parseDomainList } from '../src/message-links.js';
import { readLinkSettings, saveLinkSection } from '../src/link-settings.js';
import { readAutoModSettings, saveAutoModSettings, autoModExempt } from '../src/automod-settings.js';
import type { AutoModResources } from '../src/automod-settings.js';
import { enqueueAutoModCandidates, processAutoModJob } from '../src/automod-worker.js';
import type { AutoModMessage, AutoModContext, AutoModDependencies } from '../src/automod-engine.js';
import { createScamFeed, scamFeedSource } from '../src/scam-feed.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { digest, randomToken, linkSettingsProof, settingsProof } from '../src/web-security.js';
import type { WarningCase } from '../src/warnings.js';
const db=new PGlite();
const guild='100000000000000001',foreign='100000000000000002',admin='200000000000000001',mod='200000000000000002';
const actor='300000000000000001',member='300000000000000002',bot='300000000000000003',peer='300000000000000004',channel='400000000000000001',logs='400000000000000002',ignored='400000000000000003';
let token=randomToken(),roles: string[] | null,resources: AutoModResources,context: AutoModContext,messages: Map<string,AutoModMessage>;
let actions: { until: string; id: string }[],deletes: string[],sent: RESTPostAPIChannelMessageJSONBody[],blocked: Set<string>;
let failAudit: string | undefined,transaction=false,busy=false,failUnlock=false,discarded=false,native: 'ok'|'before'|'after'|'reject',logFailure=false;
let contextHook: (() => Promise<void>) | undefined,checks: string[][],feedUnknown=false;
async function query(sql: string,values?: unknown[]) {
 if(busy && sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }],rowCount: 1 };
 if(failUnlock && sql.includes('pg_advisory_unlock')) throw new Error('unlock failed');
 if(failAudit && (sql.includes(`'${failAudit}'`) || values?.[2]===failAudit)) throw new Error('private diagnostic');
 const r=await db.query(sql,values); if(sql==='BEGIN') transaction=true; if(['COMMIT','ROLLBACK'].includes(sql)) transaction=false;
 return { rows: r.rows,rowCount: r.rows.length || r.affectedRows || 0 };
}
const pool={ query,async connect() { return { query,release(e?: Error) { if(e) discarded=true; } }; } } as unknown as Pool;
const deps: AutoModDependencies={ botId: () => bot,readMessage: async (_channel,id) => messages.get(id) ?? null,readContext: async () => { await contextHook?.(); return { ...context }; },
 deleteMessage: async (_channel,id) => { assert.equal(transaction,false); deletes.push(id); messages.delete(id); },
 applyTimeout: async (id,until) => { assert.equal(transaction,false); actions.push({ id,until }); if(native==='reject') throw { status: 403 }; if(native==='before') throw new Error('lost'); context.timeoutUntil=until; if(native==='after') throw new Error('lost'); return { targetId: id,until }; },
 sendLog: async (_channel,body) => { sent.push(body); if(logFailure) throw new Error('lost'); return '800000000000000001'; },
 checkScamDomains: async (domains) => { checks.push(domains); return { blocked: feedUnknown?[]:domains.filter((d) => blocked.has(d)),unknown: domains.filter((d) => feedUnknown || !blocked.has(d)),note: feedUnknown?'Feed unavailable':'Not listed; not verified safe' }; },
};
function settings(section: 'cooldown'|'scam'='cooldown',overrides: Record<string,unknown>={}) { return { guildId: guild,actorId: actor,token,section,revision: 0,sharedRevision: 1,enabled: true,limit: 3,window: 30,timeout: section==='cooldown'?43200:600,enforcedRoles: [],enforcedChannels: [],blocked: '',allowed: '',reason: 'Configure links',readRoles: async () => roles,readResources: async () => resources,...overrides }; }
async function save(section: 'cooldown'|'scam'='cooldown',overrides: Record<string,unknown>={}) { const s=await readLinkSettings(pool,guild); return saveLinkSection(pool,settings(section,{ revision: s.link_revision,...overrides })); }
let sequence=600000000000000000n;
function message(content='https://example.com/page',userId=member,channelId=channel): AutoModMessage { const m={ id: String(++sequence),channelId,userId,content,bot: false,webhook: false }; messages.set(m.id,m); return m; }
async function enqueue(m: AutoModMessage,isCreate=true,at=new Date()) { await enqueueAutoModCandidates(pool,guild,[{ messageId: m.id,channelId: m.channelId,content: m.content,eventAt: at,isCreate,createdAt: isCreate?at:undefined }]); }
async function run(m=message(),isCreate=true) { await enqueue(m,isCreate); await processAutoModJob(pool,guild,deps); return m; }
async function retry() { await query('UPDATE automod_jobs SET available_at=NOW()'); return processAutoModJob(pool,guild,deps); }
async function violations(rule?: string) { return (await query('SELECT * FROM automod_violations WHERE ($1::text IS NULL OR rule_key=$1) ORDER BY message_id',[rule ?? null])).rows as { rule_key: string; violation_count: number; timeout_note: string }[]; }
let base='',handler: ReturnType<typeof createDashboardHandler>;
const server=createServer((req,res) => { void handler(req,res); });
async function request(path='/links',init: RequestInit={}) { return fetch(base+path,{ ...init,redirect: 'manual',headers: { connection: 'close',cookie: `maru_session=${token}`,...init.headers } }); }
function form(section='cooldown',revision=0,overrides: Record<string,string>={}) { return new URLSearchParams({ section,revision: String(revision),shared_revision: '1',csrf: linkSettingsProof(token,section,revision,1),enabled: 'true',timeout: section==='cooldown'?'12h':'10m',reason: 'Configure links',...(section==='cooldown'?{ limit: '3',window: '30' }:{ blocked: '',allowed: '' }),...overrides }); }
async function post(body=form(),headers: Record<string,string>={}) { return request('/links',{ method: 'POST',body,headers: { origin: base,'content-type': 'application/x-www-form-urlencoded',...headers } }); }
before(async () => {
 const dir=new URL('../migrations/',import.meta.url); for(const name of (await readdir(dir)).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort()) await db.exec(await readFile(new URL(name,dir),'utf8'));
 await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
 token=randomToken(); roles=[admin]; resources={ roles: [{ id: admin,name: 'Admin' },{ id: mod,name: 'Mods' }],channels: [{ id: ignored,name: 'Ignored' }],canDelete: true,canTimeout: true };
 context={ guildName: 'Development',roleIds: [],parentId: null,owner: false,canDelete: true,canTimeout: true,timeoutUntil: null }; messages=new Map(); blocked=new Set(['bad.example']); actions=[]; deletes=[]; sent=[]; checks=[];
 failAudit=undefined; transaction=false; busy=false; failUnlock=false; discarded=false; native='ok'; logFailure=false; contextHook=undefined; feedUnknown=false;
 await db.exec('TRUNCATE guild_settings CASCADE; DELETE FROM scam_feed_snapshot');
 await query('INSERT INTO guild_settings(guild_id,settings) VALUES ($1,$2::jsonb),($3,$2::jsonb)',[guild,JSON.stringify({ moderation_log_channel_id: logs }),foreign]);
 await query("INSERT INTO staff_roles(guild_id,role_id,access_level) VALUES ($1,$2,'admin'),($1,$3,'moderator')",[guild,admin,mod]);
 await query("INSERT INTO dashboard_sessions(guild_id,user_id,token_hash,display_name,expires_at) VALUES ($1,$2,$3,'Tester',NOW()+INTERVAL '1 hour')",[guild,actor,digest(token)]);
 await query('INSERT INTO automod_settings(guild_id,exempt_role_ids,ignored_channel_ids,updated_by) VALUES ($1,$2,$3,$4)',[guild,[admin,mod],[ignored],actor]);
 handler=createDashboardHandler({ pool,guildId: guild,config: { origin: base,applicationId: bot,clientSecret: 'not-real',secure: false },isBotReady: () => true,readMemberRoles: async () => roles,readAutoModResources: async () => resources });
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await db.close(); });
test('URL identities ignore captions, credentials and fragments while preserving meaningful paths and queries',() => {
 const a=messageLinks('one https://user:secret@EXAMPLE.com:443/page?q=1#one')[0]!;
 assert.equal(a.key,messageLinks('different https://example.com/page?q=1#two')[0]?.key); assert.equal(a.domain,'example.com');
 assert.notEqual(a.key,messageLinks('https://example.com/page?q=2')[0]?.key); assert.notEqual(a.key,messageLinks('https://example.com/other?q=1')[0]?.key);
 assert.equal(messageLinks('https://example.com/x https://example.com/x#fragment').length,1); assert.equal(messageLinks('not a link image.png ftp://example.com').length,0);
});
test('parser handles Markdown, www, Unicode hostnames, case and trailing punctuation without fetching anything',() => {
 assert.equal(messageLinks('[title](https://example.com/a(b))')[0]?.key,messageLinks('https://example.com/a(b)')[0]?.key);
 assert.equal(messageLinks('<https://example.com/page>.')[0]?.domain,'example.com'); assert.equal(messageLinks('www.example.com')[0]?.domain,'www.example.com');
 assert.equal(messageLinks('https://bücher.example/x')[0]?.domain,'xn--bcher-kva.example'); assert.equal(normalizedDomain('Example.COM.'),'example.com');
 assert.deepEqual(parseDomainList('bad.example, BAD.example\nother.example'),['bad.example','other.example']); for(const text of ['https://bad.example','bad.example/path','*.bad.example','bad.example:443','127.0.0.1']) assert.throws(() => parseDomainList(text));
});
test('both rules default Off with third-in-30s repetition and configurable 12-hour timeout',async () => {
 const s=await readLinkSettings(pool,guild); assert.equal(s.link_enabled,false); assert.equal(s.scam_enabled,false); assert.equal(s.link_limit,3); assert.equal(s.link_window_seconds,30); assert.equal(s.link_timeout_seconds,43200);
});
test('link settings require Admin session, current revisions, valid limits and a reason',async () => {
 roles=[mod]; await assert.rejects(save(),/ADMIN_REQUIRED/); roles=[admin];
 for(const change of [{ limit: 1 },{ window: 301 },{ timeout: 0 },{ reason: '' },{ revision: -1 }]) await assert.rejects(save('cooldown',change));
 await assert.rejects(save('cooldown',{ sharedRevision: 0 }),/STALE_SETTINGS/); await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); await assert.rejects(save(),/SESSION_EXPIRED/);
});
test('full-access Mod may save only while their configured Mod role is current',async () => {
 roles=[mod]; await query('INSERT INTO staff_access_grants(guild_id,user_id,granted_by) VALUES ($1,$2,$2)',[guild,actor]); await save(); roles=[]; await assert.rejects(save(),/ADMIN_REQUIRED/);
});
test('sections save independently, audit atomically and reject old forms',async () => {
 await save(); const first=await readLinkSettings(pool,guild); await save('scam',{ blocked: 'manual.example' }); const next=await readLinkSettings(pool,guild); assert.equal(next.link_limit,first.link_limit); assert.equal(next.link_enabled,true); assert.equal(next.scam_enabled,true);
 await assert.rejects(save('cooldown',{ revision: 0 }),/STALE_SETTINGS/); failAudit='LINK_SETTINGS_CHANGED'; await assert.rejects(save('cooldown',{ limit: 4 })); assert.equal((await readLinkSettings(pool,guild)).link_limit,3);
});
test('enabling needs permissions and logging; Off can be saved after channel resources disappear',async () => {
 resources.canTimeout=false; await assert.rejects(save(),/PERMISSIONS_OR_LOG/); resources.canTimeout=true; await save(); resources.roles=[]; resources.channels=[]; resources.canDelete=false; await save('cooldown',{ enabled: false }); assert.equal((await readLinkSettings(pool,guild)).link_enabled,false);
});
test('normalizations catch the third URL even when the surrounding message changes',async () => {
 await save(); await run(message('one https://example.com/a')); await run(message('two https://example.com/a')); const third=await run(message('three https://example.com/a'));
 assert.deepEqual(deletes,[third.id]); assert.equal((await violations('link_cooldown')).length,1); assert.equal(actions.length,0);
});
test('repetition counts span eligible channels, stay per member, and deduplicate URLs within a message',async () => {
 await save(); await run(message('https://example.com/a https://example.com/a#x')); await run(message('https://example.com/a',peer)); await run(message('https://example.com/a',member,logs)); assert.equal(deletes.length,0); await run(message('https://example.com/a')); assert.equal(deletes.length,1);
});
test('duplicate creates and edits cannot inflate link traffic or repeat deletion',async () => {
 await save(); const first=await run(); await enqueue(first); await retry(); first.content='changed https://example.com/a'; await run(first,false); assert.equal((await query('SELECT * FROM automod_link_activity')).rowCount,1); assert.equal(deletes.length,0);
});
test('a quiet rolling window and separate destination paths avoid false repeated-link matches',async () => {
 await save('cooldown',{ window: 1 }); await run(); await query("UPDATE automod_link_activity SET occurred_at=NOW()-INTERVAL '2 seconds'"); await run(); await run(message('https://example.com/other')); assert.equal(deletes.length,0);
});
test('fifth distinct repeated-link violation applies the configured 12-hour timeout and resets only its own counter',async () => {
 await save(); const before=Date.now(); for(let i=0;i<7;i++) await run(); assert.equal(actions.length,1); assert.ok(Math.abs(Date.parse(actions[0]!.until)-before-43200000)<10000);
 const c=(await query('SELECT * FROM moderation_cases')).rows[0] as WarningCase; assert.equal(c.duration_seconds,43200); assert.match(c.request_id,/^link:/); assert.equal(c.origin,'automod');
 assert.equal((await violations('link_cooldown')).at(-1)?.violation_count,5);
});
test('source edited before deletion is rechecked against the originally matching URL fingerprint',async () => {
 await save(); await run(); await run(); const third=message(); await enqueue(third); let reads=0; contextHook=async () => { reads++; if(reads===2) third.content='https://different.example'; }; await retry(); assert.ok(messages.has(third.id)); assert.equal(deletes.length,0);
});
test('ignored channels, their threads, protected roles, bots and webhooks do not build repetition history',async () => {
 await save(); context.roleIds=[mod]; await run(); context.roleIds=[]; context.parentId=ignored; await run(); context.parentId=null;
 await run(message('https://example.com',member,ignored)); const m=message(); m.bot=true; await run(m); const w=message(); w.webhook=true; await run(w);
 assert.equal((await query('SELECT * FROM automod_link_activity')).rowCount,0); assert.equal(deletes.length,0);
});
test('per-rule role overrides cannot bypass ignored channels and do not change blocked-word exemptions',async () => {
 await save('cooldown',{ enforcedRoles: [mod] }); context.roleIds=[mod]; for(let i=0;i<3;i++) await run(); assert.equal(deletes.length,1);
 const s=await readAutoModSettings(pool,guild); assert.equal(autoModExempt(s,[mod],channel,null,'blocked_words'),true); assert.equal(autoModExempt(s,[mod],ignored,null,'link_cooldown'),true);
});
test('known exact scam domains are removed without visiting the URL or copying private URL components',async () => {
 await save('scam'); const m=await run(message('https://user:secret@bad.example/private?token=hidden#one')); assert.deepEqual(deletes,[m.id]); assert.ok(checks.every((domains) => domains.every((d) => !d.includes('/') && !d.includes('?'))));
 assert.ok(!JSON.stringify(sent).includes('hidden')); assert.ok(!JSON.stringify((await query('SELECT * FROM audit_events')).rows).includes('secret'));
});
test('unverified links are left and logged with no violation, case or counter',async () => {
 await save('scam'); const m=await run(); assert.ok(messages.has(m.id)); assert.equal(deletes.length,0); assert.equal((await violations()).length,0); assert.equal((await query('SELECT * FROM moderation_cases')).rowCount,0); assert.equal((await query('SELECT * FROM automod_counters')).rowCount,0); assert.equal(sent.length,1); assert.deepEqual(sent[0]?.allowed_mentions,{ parse: [] });
});
test('repeated unknown reviews keep individual records but share a notification per member/domain set',async () => {
 await save('scam'); await run(); await run(); await run(message('https://example.com/path',peer)); assert.equal((await query('SELECT * FROM automod_link_reviews')).rowCount,3); assert.equal(sent.length,2); assert.equal((await query("SELECT * FROM automod_link_reviews WHERE log_status='suppressed'")).rowCount,1);
});
test('unknown review edits and duplicate events never resend; a later known-scam edit can be moderated',async () => {
 await save('scam'); const m=await run(); await run(m,false); assert.equal(sent.length,1); m.content='https://bad.example'; await run(m,false); assert.equal(deletes.length,1); assert.equal((await violations('scam_links')).length,1);
});
test('a confirmed scam link is sufficient when another link in the message is unverified',async () => {
 await save('scam'); await run(message('https://bad.example https://unknown.example')); assert.equal(deletes.length,1); assert.equal((await query('SELECT * FROM automod_link_reviews')).rowCount,0);
});
test('feed outages leave links for review while explicit manual blocks still work',async () => {
 feedUnknown=true; await save('scam',{ blocked: 'manual.example' }); const m=await run(message('https://bad.example')); assert.ok(messages.has(m.id)); await run(message('https://manual.example')); assert.equal(deletes.length,1); assert.equal((await violations('scam_links')).length,1);
});
test('allowed-domain overrides stop feed deletion and are not blanket parent-domain safelists',async () => {
 await save('scam',{ allowed: 'bad.example' }); await run(message('https://bad.example')); assert.equal(deletes.length,0); assert.equal(sent.length,0); blocked.add('sub.bad.example'); await run(message('https://sub.bad.example')); assert.equal(deletes.length,1);
});
test('scam checks respect exemptions before checking or logging and have independent override lists',async () => {
 await save('scam'); context.roleIds=[mod]; await run(message('https://bad.example')); assert.equal(checks.length,0); assert.equal(sent.length,0); context.roleIds=[]; context.parentId=ignored; await run(message('https://bad.example')); assert.equal(checks.length,0);
});
test('five confirmed scam messages escalate only the scam counter and never escalate unknown reviews',async () => {
 await save('scam'); for(let i=0;i<5;i++) await run(message('https://bad.example')); assert.equal(actions.length,1); const c=(await query('SELECT * FROM moderation_cases')).rows[0] as WarningCase; assert.match(c.request_id,/^scam:/); assert.equal(c.duration_seconds,600);
});
test('old link observations and undispatched matches are cancelled after configuration changes or disabling',async () => {
 await save(); await run(); await run(); const third=message(); await enqueue(third); await save('cooldown',{ limit: 4 }); await retry(); assert.equal(deletes.length,0);
 await save('cooldown',{ enabled: false }); await run(); assert.equal(deletes.length,0);
});
test('messages queued while scam protection was Off cannot become violations merely by enabling it',async () => {
 await save(); const m=message('https://bad.example'); await enqueue(m); await save('scam'); await retry(); assert.equal(deletes.length,0); assert.ok(messages.has(m.id));
});
test('shared exemption removal prunes overrides atomically and invalidates open link forms',async () => {
 await save('cooldown',{ enforcedRoles: [mod] }); const s=await readAutoModSettings(pool,guild);
 await saveAutoModSettings(pool,{ guildId: guild,actorId: actor,token,revision: 1,enabled: false,words: '',timeoutSeconds: 600,exemptRoles: [admin],ignoredChannels: [ignored],enforcedRoles: [],enforcedChannels: [],reason: 'Remove Mod exemption',readRoles: async () => roles,readResources: async () => resources });
 assert.deepEqual((await readLinkSettings(pool,guild)).link_enforced_role_ids,[]); await assert.rejects(saveLinkSection(pool,settings('cooldown',{ revision: s.link_revision })),/STALE_SETTINGS/);
});
test('detection or timeout intention audit failures prevent their corresponding external actions',async () => {
 await save('scam'); failAudit='AUTOMOD_SCAM_LINK'; const m=await run(message('https://bad.example')); assert.equal(deletes.length,0); assert.ok(messages.has(m.id)); failAudit=undefined; await retry(); assert.equal(deletes.length,1);
});
test('lost timeout responses stay unconfirmed and are not blindly repeated',async () => {
 await save(); native='before'; for(let i=0;i<8;i++) await run(); assert.equal(actions.length,1); assert.equal((await query('SELECT action_status FROM moderation_cases')).rows[0]?.action_status,'unconfirmed');
});
test('review request audit failure prevents the review send, and lost log responses never resend',async () => {
 await save('scam'); failAudit='AUTOMOD_LINK_REVIEW'; await run(); assert.equal(sent.length,0); failAudit=undefined; logFailure=true; await retry(); await retry(); assert.equal(sent.length,1);
});
test('activity and configuration stay server-scoped; unsafe unlock discards its pooled connection',async () => {
 await save(); assert.equal((await readLinkSettings(pool,foreign)).link_enabled,false); failUnlock=true; await run(); assert.equal(discarded,true);
});
test('HTTP authenticates, renders two independent saves, and allows ordinary Mods to view only',async () => {
 assert.equal((await request('/links',{ headers: { cookie: '' } })).status,303); const html=await (await request()).text(); assert.match(html,/Save link cooldown/); assert.match(html,/Save scam protection/); roles=[mod]; assert.match(await (await request()).text(),/fieldset disabled/); assert.equal((await post()).status,403);
});
test('HTTP separate save proofs reject cross-section injection, stale shared revisions, duplicates and foreign origins',async () => {
 const good=form(); assert.equal((await post(good)).status,303); const injected=form('scam',1); injected.append('limit','1'); assert.equal((await post(injected)).status,409);
 assert.equal((await post(form('scam',1),{ origin: 'null' })).status,403); assert.equal((await post(form('scam',1,{ csrf: settingsProof(token) }))).status,403);
 const dup=form('scam',1); dup.append('enabled','false'); assert.equal((await post(dup)).status,409);
});
test('HTTP rejects expired sessions oversized bodies and invalid domain entries without saved changes',async () => {
 assert.equal((await post(form('scam',0,{ blocked: '*.bad.example' }))).status,409); assert.equal((await post(form('scam',0,{ reason: 'x'.repeat(132000) }))).status,409);
 await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); assert.equal((await post()).status,303);
});
test('feed client uses only fixed provider endpoints, validates health and serves exact-host matches without parent expansion',async () => {
 const urls: string[]=[]; const now=Date.now();
 const fetcher=(async (url: string) => { urls.push(url); return Response.json(url.endsWith('/health')?{ status: 'ok',db: 'ok',sync_age_seconds: 10 }:{ list: 'primary',count: 1,updated_at: new Date(now).toISOString(),domains: ['bad.example'] }); }) as typeof fetch;
 const feed=createScamFeed(pool,fetcher); await feed.refresh(); assert.deepEqual(urls,['https://api.destroy.tools/v1/health',scamFeedSource]); assert.equal(feed.status().available,true);
 const result=feed.check(['bad.example','www.bad.example','tenant.bad.example']); assert.deepEqual(result.blocked,['bad.example','www.bad.example']); assert.deepEqual(result.unknown,['tenant.bad.example']); assert.equal(urls.length,2);
});
test('feed errors, unhealthy data, malformed responses and stale data never become deletion verdicts',async () => {
 let clock=Date.now(),mode='ok'; const fetcher=(async (url: string) => { if(mode==='error') throw new Error('private network'); if(mode==='bad-json') return Response.json({ invalid: true }); return Response.json(url.endsWith('/health')?{ status: mode==='unhealthy'?'degraded':'ok',db: 'ok',sync_age_seconds: 10 }:{ list: 'primary',count: 1,updated_at: new Date(clock).toISOString(),domains: ['bad.example'] }); }) as typeof fetch;
 const feed=createScamFeed(pool,fetcher,() => clock); await feed.refresh(); assert.equal(feed.status().available,true); clock+=3600001; assert.deepEqual(feed.check(['bad.example']).blocked,[]);
 for(const value of ['error','unhealthy','bad-json']) { mode=value; await feed.refresh(); assert.deepEqual(feed.check(['bad.example']).blocked,[]); }
});
test('feed redirects non-JSON and oversized bodies are rejected, with concurrent refreshes sharing one request chain',async () => {
 let calls=0; const fetcher=(async (url: string,init: RequestInit) => { calls++; assert.equal(init.redirect,'error'); return Response.json(url.endsWith('/health')?{ status: 'ok',db: 'ok',sync_age_seconds: 1 }:{ list: 'primary',count: 1,updated_at: new Date().toISOString(),domains: ['bad.example'] }); }) as typeof fetch;
 const feed=createScamFeed(pool,fetcher); await Promise.all([feed.refresh(),feed.refresh()]); assert.equal(calls,2);
 const bad=createScamFeed(pool,(async () => new Response('x'.repeat(17000),{ headers: { 'content-type': 'application/json' } })) as typeof fetch); await bad.refresh(); assert.equal(bad.status().available,false);
});
test('no-op saves do not duplicate settings audit, and one section cannot replace another section\'s lists',async () => {
 await save('scam',{ blocked: 'manual.example',allowed: 'trusted.example' }); const count=(await query("SELECT * FROM audit_events WHERE event_type='LINK_SETTINGS_CHANGED'")).rowCount;
 await save('scam',{ blocked: 'manual.example',allowed: 'trusted.example' }); assert.equal((await query("SELECT * FROM audit_events WHERE event_type='LINK_SETTINGS_CHANGED'")).rowCount,count);
 await save(); assert.deepEqual((await readLinkSettings(pool,guild)).scam_allowed_domains,['trusted.example']);
});
test('a shared-settings audit failure rolls back both shared exemptions and override pruning',async () => {
 await save('cooldown',{ enforcedRoles: [mod] }); failAudit='AUTOMOD_SETTINGS_CHANGED';
 await assert.rejects(saveAutoModSettings(pool,{ guildId: guild,actorId: actor,token,revision: 1,enabled: false,words: '',timeoutSeconds: 600,exemptRoles: [admin],ignoredChannels: [ignored],enforcedRoles: [],enforcedChannels: [],reason: 'Change exemptions',readRoles: async () => roles,readResources: async () => resources }));
 assert.deepEqual((await readLinkSettings(pool,guild)).link_enforced_role_ids,[mod]);
});
test('messages observed before an enable save do not gain retroactive link credit or scam punishment during delayed intake',async () => {
 const at=new Date(Date.now()-1000),m=message('https://bad.example'); await save('scam'); await enqueue(m,true,at); await retry(); assert.equal(deletes.length,0); assert.ok(messages.has(m.id));
});
test('private URLs and unverified review records store no credentials paths fragments or query secrets',async () => {
 await save('scam'); await run(message('https://person:password@unknown.example/private?access=secret#private'));
 const stored=JSON.stringify((await query('SELECT * FROM automod_link_reviews')).rows); assert.ok(stored.includes('unknown.example')); assert.ok(!stored.includes('password')); assert.ok(!stored.includes('/private')); assert.ok(!stored.includes('access='));
});
test('timeout intention audit failure prevents native timeout allocation while preserving already removed messages',async () => {
 await save(); failAudit='AUTOMOD_TIMEOUT_REQUESTED'; for(let i=0;i<7;i++) await run(); assert.equal(actions.length,0); assert.equal((await query('SELECT * FROM moderation_cases')).rowCount,0);
});
test('missing deletion permissions defer a known scam without a violation count or native punishment',async () => {
 await save('scam'); context.canDelete=false; const m=await run(message('https://bad.example')); assert.ok(messages.has(m.id)); assert.equal(deletes.length,0); assert.equal(actions.length,0);
});
test('a lost successful timeout response is never resent and a later violation can verify its exact end',async () => {
 await save(); native='after'; for(let i=0;i<8;i++) await run(); assert.equal(actions.length,1);
 assert.equal((await query('SELECT action_status FROM moderation_cases')).rows[0]?.action_status,'applied');
});
test('link and scam counters remain independent without extending an existing native timeout',async () => {
 await save(); await save('scam'); for(let i=0;i<7;i++) await run(message('https://bad.example'));
 assert.equal(actions.length,1); assert.equal((await violations('scam_links')).length,7); assert.equal((await violations('link_cooldown')).length,5);
});
test('an unavailable or malformed reputation result is reviewed rather than assumed safe or malicious',async () => {
 await save('scam'); await run(message('https://bad.example')); // known result first, then an independent message with an invalid checker
 const custom={ ...deps,checkScamDomains: async () => null as never }; const m=message('https://unknown.example'); await enqueue(m); await processAutoModJob(pool,guild,custom); assert.ok(messages.has(m.id)); assert.equal((await query('SELECT * FROM automod_link_reviews')).rowCount,1);
});
test('review outcome audit failure preserves its claim and cannot cause notification replay',async () => {
 await save('scam'); failAudit='AUTOMOD_LINK_REVIEW_LOG'; const m=await run(); assert.equal(sent.length,1); failAudit=undefined; await retry(); await run(m,false); assert.equal(sent.length,1);
});
test('read-only review pages escape hostnames and configuration names and show current settings after restart',async () => {
 resources.roles[0]!.name='<script>role</script>'; const html=await (await request()).text(); assert.ok(html.includes('&lt;script&gt;role'));
 await save('scam',{ blocked: 'manual.example' }); roles=[mod]; assert.match(await (await request()).text(),/manual.example/);
});
test('body proofs require the current shared revision and freshly authorized roles',async () => {
 const stale=form(); await query('UPDATE automod_settings SET revision=2'); assert.equal((await post(stale)).status,409);
 roles=[]; assert.equal((await post(stale)).status,403);
});
