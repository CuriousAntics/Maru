import assert from 'node:assert/strict';
import { test, before, beforeEach, after } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { Client, REST } from 'discord.js';
import { chatClearDependencies } from '../src/chat-clear-discord.js';
import { readChatClearSettings, saveChatClearSettings } from '../src/chat-clear-settings.js';
import { clearCutoff, processChatClear } from '../src/chat-clear-engine.js';
import type { ChatClearDependencies, ClearMessage } from '../src/chat-clear-engine.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { chatClearProof, digest, randomToken } from '../src/web-security.js';
const db = new PGlite();
const guild = '100000000000000001', actor = '200000000000000001', admin = '300000000000000001', mod = '300000000000000002';
const voice = '400000000000000001', other = '400000000000000002', bot = '500000000000000001';
let roles: string[] | null, usable: boolean, token: string, failAudit: string | undefined, failProgress: boolean;
let messages: Map<string, ClearMessage>, removed: string[], notices: number[], failDelete: string | undefined, loseNotice: boolean;
let readHook: ((id: string) => void) | undefined, listHook: (() => void) | undefined;
const resources = () => Promise.resolve({ channels: [{ id: voice, name: '<Voice chat>', usable }] });
async function query(sql: string, values?: unknown[]) {
  if (failAudit && sql.includes(failAudit)) throw new Error('audit unavailable');
  if (failProgress && sql.includes('SET cursor_id=$2')) { failProgress = false; throw new Error('progress unavailable'); }
  const r = await db.query(sql, values); return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
}
const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
const deps: ChatClearDependencies = {
  botId: () => bot, canClear: async id => id === voice && usable,
  list: async (_c, before) => {
    listHook?.();
    return [...messages.values()].filter(m => BigInt(m.id) < BigInt(before)).sort((a,b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0,100).map(m => ({ ...m }));
  },
  read: async (_c, id) => { readHook?.(id); return messages.get(id) ? { ...messages.get(id)! } : null; },
  remove: async (_c, id) => { assert.notEqual(id, failDelete); messages.delete(id); removed.push(id); },
  notify: async (_c, seconds) => { notices.push(seconds); if (loseNotice) throw new Error('lost response'); return '600000000000000001'; },
};
function input(overrides = {}) { return { guildId: guild, actorId: actor, token, revision: 0, enabled: true, channelId: voice, intervalHours: 6,
  reason: 'Configure scheduled cleanup', readRoles: async () => roles, readResources: resources, ...overrides }; }
const at = () => Date.now();
const idAt = (ms: number, n = 0) => (BigInt(clearCutoff(ms)) + BigInt(n)).toString();
function add(ms: number, pinned = false, type = 0, n = 0) { const id = idAt(ms, n); messages.set(id, { id, pinned, type }); return id; }
async function scheduleDue(now: number) {
  await saveChatClearSettings(pool, input());
  await query('UPDATE chat_clear_settings SET next_run_at=$2 WHERE guild_id=$1', [guild, new Date(now)]);
  await query("INSERT INTO chat_clear_notices (guild_id,revision,scheduled_at,seconds_before,status) VALUES ($1,1,$2,300,'sent')", [guild, new Date(now)]);
}
async function runRow() { return (await query('SELECT * FROM chat_clear_runs ORDER BY run_id DESC LIMIT 1')).rows[0] as Record<string, any>; }
let base: string, handler: ReturnType<typeof createDashboardHandler>;
const server = createServer((req,res) => { void handler(req,res); });
async function request(init: RequestInit = {}) { return fetch(base + '/chat-clear', { ...init, redirect: 'manual', headers: { cookie: `maru_session=${token}`, connection: 'close', ...init.headers } }); }
const form = () => new URLSearchParams({ csrf: chatClearProof(token,0), revision: '0', enabled: 'true', channel: voice, hours: '6', reason: 'Enable timed cleanup' });
before(async () => {
  // Apply the complete migration chain to catch deployment/schema integration errors.
  const names = (await readdir(new URL('../migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort();
  for (const name of names) await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  failAudit = undefined; failProgress = false; roles = [admin]; usable = true; token = randomToken();
  messages = new Map(); removed = []; notices = []; failDelete = undefined; loseNotice = false; readHook = undefined; listHook = undefined;
  await db.exec('TRUNCATE guild_settings CASCADE');
  await query('INSERT INTO guild_settings(guild_id) VALUES ($1)', [guild]);
  await query("INSERT INTO staff_roles(guild_id,role_id,access_level) VALUES ($1,$2,'admin'),($1,$3,'moderator')", [guild,admin,mod]);
  await query("INSERT INTO dashboard_sessions(token_hash,guild_id,user_id,display_name,expires_at) VALUES ($1,$2,$3,'Tester',NOW()+INTERVAL '1 hour')", [digest(token),guild,actor]);
  handler = createDashboardHandler({ pool,guildId: guild, config: { origin: base, applicationId: bot, clientSecret: 'fake', secure: false },
    isBotReady: () => true, readMemberRoles: async () => roles, readChatClearResources: resources });
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); });
test('defaults Off, six hours; enabling starts a full interval; unchanged save does not postpone', async () => {
  const defaults = await readChatClearSettings(pool,guild); assert.equal(defaults.enabled,false); assert.equal(defaults.interval_hours,6);
  const now = at(); await saveChatClearSettings(pool,input()); const s = await readChatClearSettings(pool,guild);
  assert.ok(new Date(s.next_run_at!).getTime() >= now + 6*3600000 - 1000);
  await saveChatClearSettings(pool,input({ revision: 1 })); assert.deepEqual(await readChatClearSettings(pool,guild),s);
  assert.equal((await query("SELECT * FROM audit_events WHERE event_type='CHAT_CLEAR_SETTINGS_CHANGED'")).rowCount,1);
});
test('current admin or full-access Mod required; revoked/expired session rejected', async () => {
  for (const rs of [null,[],[mod]]) { roles = rs; await assert.rejects(saveChatClearSettings(pool,input()),/ADMIN_REQUIRED/); }
  roles = [mod]; await query('INSERT INTO staff_access_grants(guild_id,user_id,granted_by) VALUES ($1,$2,$2)',[guild,actor]);
  await saveChatClearSettings(pool,input());
  await query('DELETE FROM dashboard_sessions'); await assert.rejects(saveChatClearSettings(pool,input({ revision: 1 })),/SESSION_EXPIRED/);
});
test('invalid interval/channel/reason/stale saves fail and cannot enable without permissions', async () => {
  for (const patch of [{intervalHours:0},{intervalHours:721},{intervalHours:1.5},{channelId:'bad'},{reason:''},{revision:1}])
    await assert.rejects(saveChatClearSettings(pool,input(patch)));
  await assert.rejects(saveChatClearSettings(pool,input({channelId:other})),/CHANNEL_UNAVAILABLE/);
  usable = false; await assert.rejects(saveChatClearSettings(pool,input()),/CHANNEL_UNAVAILABLE/);
});
test('audit failure rolls back settings', async () => {
  failAudit = 'CHAT_CLEAR_SETTINGS_CHANGED'; await assert.rejects(saveChatClearSettings(pool,input()));
  assert.equal((await readChatClearSettings(pool,guild)).enabled,false);
});
test('Off switch works after channel disappears and cancels the active sweep', async () => {
  const now = at(); await scheduleDue(now); await processChatClear(pool,guild,deps,now);
  usable = false; await saveChatClearSettings(pool,input({revision:1,enabled:false}));
  assert.equal((await runRow()).status,'cancelled'); assert.equal((await readChatClearSettings(pool,guild)).next_run_at,null);
  assert.equal(await processChatClear(pool,guild,deps,now+10000),false); assert.deepEqual(removed,[]);
});
test('no deletion before deadline or while Off', async () => {
  const now = at(); add(now-1000); assert.equal(await processChatClear(pool,guild,deps,now),false);
  await saveChatClearSettings(pool,input()); assert.equal(await processChatClear(pool,guild,deps,now),false); assert.deepEqual(removed,[]);
});
test('countdown sends 5m, 1m and 10s once each; deletes only after deadline', async () => {
  const now = at(), due = now + 300000; await saveChatClearSettings(pool,input());
  await query('UPDATE chat_clear_settings SET next_run_at=$2 WHERE guild_id=$1',[guild,new Date(due)]);
  await processChatClear(pool,guild,deps,now); await processChatClear(pool,guild,deps,now+1000);
  await processChatClear(pool,guild,deps,due-60000); await processChatClear(pool,guild,deps,due-50000);
  await processChatClear(pool,guild,deps,due-10000); await processChatClear(pool,guild,deps,due-1000);
  assert.deepEqual(notices,[300,60,10]); assert.equal(await runRow(),undefined);
  await processChatClear(pool,guild,deps,due); assert.equal((await runRow()).status,'running');
});
test('overdue without a warning gets a fresh five minutes after restart', async () => {
  const now = at(); await saveChatClearSettings(pool,input()); await query('UPDATE chat_clear_settings SET next_run_at=$2 WHERE guild_id=$1',[guild,new Date(now-3600000)]);
  await processChatClear(pool,guild,deps,now); assert.deepEqual(notices,[300]); assert.equal(await runRow(),undefined);
  assert.equal(new Date((await readChatClearSettings(pool,guild)).next_run_at!).getTime(),now+300000);
  await processChatClear(pool,guild,deps,now+299999); assert.deepEqual(removed,[]);
});
test('unconfirmed first notice never auto-replays or authorizes deletion; reset is required', async () => {
  const now = at(); await saveChatClearSettings(pool,input()); await query('UPDATE chat_clear_settings SET next_run_at=$2 WHERE guild_id=$1',[guild,new Date(now)]);
  loseNotice = true; await processChatClear(pool,guild,deps,now); loseNotice = false;
  await processChatClear(pool,guild,deps,now+400000); assert.deepEqual(notices,[300]); assert.equal(await runRow(),undefined);
  assert.equal((await query('SELECT status FROM chat_clear_notices')).rows[0]?.status,'unconfirmed');
});
test('run intent is committed before deleting; audit failure creates no run or side effect', async () => {
  const now = at(); await scheduleDue(now); add(now-1000); failAudit = 'CHAT_CLEAR_STARTED';
  await assert.rejects(processChatClear(pool,guild,deps,now)); assert.equal(await runRow(),undefined); assert.deepEqual(removed,[]);
});
test('clears old and recent unpinned messages, preserving pins and concurrent posts', async () => {
  const now = at(); await scheduleDue(now);
  const old = add(now-30*86400000), recent = add(now-1000), pin = add(now-2000,true), newMessage = add(now+1000);
  await processChatClear(pool,guild,deps,now); assert.deepEqual(removed,[]);
  await processChatClear(pool,guild,deps,now+1000); await processChatClear(pool,guild,deps,now+2000);
  assert.deepEqual(new Set(removed),new Set([old,recent])); assert.ok(messages.has(pin)); assert.ok(messages.has(newMessage));
  assert.equal((await runRow()).status,'completed'); assert.equal((await runRow()).preserved,1);
});
test('pinning between page fetch and deletion is respected; unsupported system types preserved', async () => {
  const now = at(); await scheduleDue(now); const pin = add(now-1000), system = add(now-2000,false,21);
  readHook = id => { if (id===pin) messages.get(id)!.pinned = true; };
  await processChatClear(pool,guild,deps,now); await processChatClear(pool,guild,deps,now+1000);
  assert.deepEqual(removed,[]); assert.ok(messages.has(system)); assert.equal((await runRow()).preserved,2);
});
test('pagination survives worker restarts without touching new messages or counting pins twice', async () => {
  const now = at(); await scheduleDue(now); for (let i=0;i<125;i++) add(now-1000-i,i%25===0);
  await processChatClear(pool,guild,deps,now);
  for (let i=1;i<=15;i++) await processChatClear(pool,guild,{...deps},now+i*1000);
  const r = await runRow(); assert.equal(r.status,'completed'); assert.equal(r.removed_or_absent,120); assert.equal(r.preserved,5);
  assert.equal(messages.size,5);
});
test('permission loss pauses; restoring permission resumes same fixed sweep', async () => {
  const now = at(); await scheduleDue(now); const id = add(now-1000); await processChatClear(pool,guild,deps,now);
  usable = false; await processChatClear(pool,guild,deps,now+1000); assert.deepEqual(removed,[]); assert.match((await runRow()).note,/Paused/);
  usable = true; await processChatClear(pool,guild,deps,now+61001); assert.deepEqual(removed,[id]);
});
test('lost deletion response resumes safely, rechecking pins without expanding the cutoff', async () => {
  const now = at(); await scheduleDue(now); const id = add(now-1000), next = add(now+1000);
  await processChatClear(pool,guild,deps,now);
  const lost = { ...deps, remove: async (_c: string, mid: string) => { messages.delete(mid); throw new Error('lost'); } };
  await processChatClear(pool,guild,lost,now+1000); assert.match((await runRow()).note,/Paused/);
  await processChatClear(pool,guild,deps,now+62000); assert.ok(messages.has(next)); assert.ok(!messages.has(id));
  assert.equal((await runRow()).status,'completed');
});
test('failed outcome save retries IDs safely; completed audit failure rolls back completion', async () => {
  const now = at(); await scheduleDue(now); add(now-1000); await processChatClear(pool,guild,deps,now);
  // A JavaScript injected failure (not a PostgreSQL failure) still saves recovery progress in the error path.
  failProgress = true; await processChatClear(pool,guild,deps,now+1000);
  failAudit = 'CHAT_CLEAR_COMPLETED'; await assert.rejects(processChatClear(pool,guild,deps,now+62000));
  assert.equal((await runRow()).status,'running'); failAudit = undefined;
  await processChatClear(pool,guild,deps,now+63000); assert.equal((await runRow()).status,'completed');
});
test('malformed/foreign/future page results fail closed without deleting anything', async () => {
  const now = at(); await scheduleDue(now); await processChatClear(pool,guild,deps,now);
  await processChatClear(pool,guild,{...deps,list:async()=>[{id:idAt(now+1000),pinned:false,type:0}]},now+1000);
  assert.deepEqual(removed,[]); assert.match((await runRow()).note,/Paused/);
});
test('HTTP form enforces CSRF, origin, duplicate fields and current Admin access', async () => {
  let p = form(); p.set('csrf','wrong'); assert.equal((await request({method:'POST',body:p,headers:{origin:base}})).status,403);
  assert.equal((await request({method:'POST',body:form(),headers:{origin:'https://elsewhere.invalid'}})).status,403);
  p = form(); p.append('hours','1'); assert.equal((await request({method:'POST',body:p,headers:{origin:base}})).status,409);
  roles=[mod]; assert.equal((await request({method:'POST',body:form(),headers:{origin:base}})).status,403);
  roles=[admin]; const res=await request({method:'POST',body:form(),headers:{origin:base}}); assert.equal(res.status,303); assert.equal(res.headers.get('location'),'/chat-clear');
});
test('dashboard renders schedule, escaped channel name, countdown and run history', async () => {
  const text = await (await request()).text(); assert.match(text,/6 hours/); assert.match(text,/&lt;Voice chat&gt;/); assert.match(text,/Pinned messages are preserved/); assert.match(text,/5 minutes/);
  roles=[mod]; assert.match(await (await request()).text(),/fieldset disabled/);
});
test('Discord adapter validates source channel, reads pins fresh, uses individual DELETE and quiet countdown', async () => {
  const now = at(), id=idAt(now-1000), calls: any[]=[];
  const rest={get:async(route:string)=>{calls.push(route);return route.endsWith('/'+id)?{id,channel_id:voice,pinned:true,type:0}:[{id,channel_id:voice,pinned:false,type:0}];},
    delete:async(route:string)=>{calls.push(route);},post:async(route:string,options:any)=>{calls.push(options.body);return{id:'600000000000000001',channel_id:voice};}} as unknown as REST;
  const d=chatClearDependencies({user:{id:bot}} as unknown as Client,guild,'fake',rest);
  assert.equal((await d.read(voice,id))?.pinned,true); assert.equal((await d.list(voice,idAt(now))).length,1);
  await d.remove(voice,id); await d.notify(voice,60);
  assert.ok(calls.includes(`/channels/${voice}/messages/${id}`)); assert.deepEqual(calls.at(-1).allowed_mentions,{parse:[]}); assert.match(calls.at(-1).content,/1 minute/);
  const bad={...rest,get:async()=>({id,channel_id:other,pinned:false,type:0})} as unknown as REST;
  await assert.rejects(chatClearDependencies({} as Client,guild,'fake',bad).read(voice,id),/INVALID_MESSAGE/);
});
