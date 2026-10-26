import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { ChannelType, PermissionFlagsBits, Collection } from 'discord.js';
import type { Client } from 'discord.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { digest, randomToken, starboardProof, settingsProof } from '../src/web-security.js';
import { saveStarboard, loadStarboards, resolveBoardEmoji, StarboardSettingsError } from '../src/starboard-settings.js';
import type { StarboardResources } from '../src/starboard-settings.js';
import { deleteStarboard, loadBoardDeletions } from '../src/starboard-delete.js';
import { starboardResources } from '../src/starboard-discord.js';

const db = new PGlite();
const guild = '100000000000000001', otherGuild = '100000000000000002';
const actor = '300000000000000001', adminRole = '200000000000000001', modRole = '200000000000000002';
const destination = '500000000000000001', source = '500000000000000002', source2 = '500000000000000003';
const emojiId = '600000000000000001';
const boardId = '11111111-1111-4111-8111-111111111111', secondId = '22222222-2222-4222-8222-222222222222';
let sessionToken = randomToken(), roles: string[] | null;
let failAudit = false, failResources = false, botReady = true;
let roleHook: (() => Promise<void>) | undefined;
let resources: StarboardResources;
async function query(sql: string, values?: unknown[]) {
  if (failAudit && (String(values?.[2]).startsWith('STARBOARD_') || sql.includes("'STARBOARD_DELETED'"))) throw new Error('test audit failure');
  const result = await db.query(sql,values); return { rows: result.rows,rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool = { query,async connect() { return { query,release() {} }; } } as unknown as Pool;
const readRoles = async () => { await roleHook?.(); return roles; };
const readResources = async () => { if (failResources) throw new Error('provider unavailable'); return resources; };
function input(overrides: Record<string,unknown> = {}) {
  return { guildId: guild,actorId: actor,sessionToken,boardId,action: 'create' as 'create' | 'save',revision: 0,name: 'Community highlights',
    destinationId: destination,emoji: '⭐',threshold: 3,sourceIds: [source],allowCrosspost: false,reason: 'Initial setup',
    readMemberRoles: readRoles,readResources,...overrides };
}
async function save(overrides: Record<string,unknown> = {}) { return saveStarboard(pool,input(overrides)); }
async function code(overrides: Record<string,unknown>, expected: string) {
  await assert.rejects(save(overrides),(e: unknown) => e instanceof StarboardSettingsError && e.code === expected);
}
async function events() { return (await db.query<{ event_type: string; details: Record<string,unknown> }>('SELECT event_type,details FROM audit_events ORDER BY event_id')).rows; }
let base = '';
let handler: ReturnType<typeof createDashboardHandler>;
const server = createServer((req,res) => { void handler(req,res); });
function makeHandler() {
  return createDashboardHandler({ pool,guildId: guild,config: { origin: base,secure: false,applicationId: '400000000000000001',clientSecret: 'test-only' },
    isBotReady: () => botReady,readMemberRoles: readRoles,readStarboardResources: readResources });
}
async function request(path: string,init: RequestInit = {}) {
  return fetch(base+path,{ ...init,redirect: 'manual',headers: { cookie: `maru_session=${sessionToken}`,...init.headers } });
}
function form(overrides: Record<string,string> = {}, id = boardId, revision = 0, action: 'create' | 'save' = 'create') {
  return new URLSearchParams({ csrf: starboardProof(sessionToken,id,revision,action),revision: String(revision),name: 'Community highlights',
    destination_id: destination,emoji: '⭐',threshold: '3',source_id: source,allow_crosspost: 'false',enabled: 'false',reason: 'Initial setup',...overrides });
}
async function post(body: URLSearchParams | string = form(),id = boardId,action = 'create',headers: Record<string,string> = {}) {
  return request(`/starboards/${id}/${action}`,{ method: 'POST',headers: { origin: base,'content-type': 'application/x-www-form-urlencoded',...headers },body });
}
before(async () => {
  for (const name of ['001_foundation.sql','002_dashboard_auth.sql','007_starboard_settings.sql','008_starboard_reactions.sql','009_starboard_deletion.sql']) await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  failAudit = failResources = false; botReady = true; roleHook = undefined; roles = [adminRole]; sessionToken = randomToken();
  resources = { channels: [
    { id: destination,name: 'starboard',sourceUsable: true,destinationUsable: true },
    { id: source,name: 'general',sourceUsable: true,destinationUsable: false },
    { id: source2,name: 'artwork',sourceUsable: true,destinationUsable: true },
  ],emojis: [{ id: emojiId,name: 'marustar',animated: false,usable: true }] };
  await db.exec('TRUNCATE starboard_jobs,starboard_posts,starboard_boards,dashboard_login_attempts,dashboard_sessions,audit_events,staff_access_grants,staff_roles,guild_settings RESTART IDENTITY');
  await query('INSERT INTO guild_settings (guild_id,settings) VALUES ($1,$3::jsonb),($2,$3::jsonb)',[guild,otherGuild,JSON.stringify({ moderation_log_channel_id: source2,other: 'keep' })]);
  await query("INSERT INTO staff_roles (guild_id,role_id,access_level) VALUES ($1,$3,'admin'),($1,$4,'moderator'),($2,$3,'admin')",[guild,otherGuild,adminRole,modRole]);
  await query("INSERT INTO dashboard_sessions (token_hash,guild_id,user_id,display_name,expires_at) VALUES ($1,$2,$3,'Test staff',NOW()+INTERVAL '8 hours')",[digest(sessionToken),guild,actor]);
  handler = makeHandler();
});
after(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); await db.close(); });

test('Admin creates a paused board and full settings audit atomically', async () => {
  assert.equal(await save(),'changed'); const board = (await loadStarboards(pool,guild))[0]!;
  assert.equal(board.name,'Community highlights'); assert.equal(board.threshold,3); assert.equal(board.enabled,false); assert.equal(board.emoji_key,'u:⭐'); assert.equal(board.revision,0);
  assert.deepEqual(board.source_channel_ids,[source]); assert.equal(board.created_by,actor);
  const audit = (await events())[0]!; assert.equal(audit.event_type,'STARBOARD_CREATED'); assert.equal(audit.details.before,null);
  assert.deepEqual(audit.details.after,{ name: board.name,destination_channel_id: destination,emoji: '⭐',emoji_key: 'u:⭐',threshold: 3,source_channel_ids: [source],allow_crosspost: false,enabled: false });
});
test('ordinary Mods can create and edit boards without a full access grant', async () => {
  roles = [modRole]; await save(); await save({ action: 'save',threshold: 5,allowCrosspost: true });
  const board = (await loadStarboards(pool,guild))[0]!; assert.equal(board.threshold,5); assert.equal(board.allow_crosspost,true); assert.equal(board.revision,1);
});
test('separate boards can share a destination and have independent emoji and cross-post preferences', async () => {
  await save(); await save({ boardId: secondId,name: 'Artwork',emoji: '🌟',threshold: 8,allowCrosspost: true,sourceIds: [source2] });
  const boards = await loadStarboards(pool,guild); assert.equal(boards.length,2); assert.notEqual(boards[0]!.allow_crosspost,boards[1]!.allow_crosspost);
});
test('editing records full before and after settings without changing unrelated server settings', async () => {
  await save(); await save({ action: 'save',name: 'New name',threshold: 10,sourceIds: [source2,source],reason: 'Revised setup' });
  const audit = (await events())[1]!; assert.equal(audit.event_type,'STARBOARD_UPDATED'); assert.equal((audit.details.before as Record<string,unknown>).threshold,3);
  assert.equal((audit.details.after as Record<string,unknown>).threshold,10); assert.equal(audit.details.reason,'Revised setup');
  const settings = (await db.query<{ settings: unknown }>('SELECT settings FROM guild_settings WHERE guild_id=$1',[guild])).rows[0]!.settings;
  assert.deepEqual(settings,{ moderation_log_channel_id: source2,other: 'keep' });
});
test('no-op saves and repeated creates do not duplicate audit events', async () => {
  await save(); assert.equal(await save(),'unchanged'); assert.equal(await save({ action: 'save' }),'unchanged'); assert.equal((await events()).length,1);
});
test('source channel order does not create a spurious revision', async () => {
  await save({ sourceIds: [source2,source] }); assert.equal(await save({ action: 'save',sourceIds: [source,source2] }),'unchanged');
});
test('stale forms and replayed create forms cannot overwrite later settings', async () => {
  await save(); await save({ action: 'save',threshold: 7 }); await code({ action: 'save',threshold: 9 },'STALE_BOARD'); await code({},'STALE_BOARD');
  assert.equal((await loadStarboards(pool,guild))[0]!.threshold,7); assert.equal((await events()).length,2);
});
test('names are unique per server ignoring case and outside spaces', async () => {
  await save(); await code({ boardId: secondId,name: ' community HIGHLIGHTS ' },'DUPLICATE_NAME');
});
test('name reason threshold IDs and source selection are bounded', async () => {
  for (const name of [' ','x'.repeat(61)]) await code({ name },'INVALID_NAME');
  for (const reason of [' ','x'.repeat(501)]) await code({ reason },'INVALID_REASON');
  for (const threshold of [0,1001,1.5,NaN]) await code({ threshold },'INVALID_THRESHOLD');
  await code({ boardId: 'invalid' },'INVALID_INPUT'); await code({ destinationId: 'bad' },'INVALID_INPUT');
  await code({ revision: -1 },'INVALID_INPUT'); await code({ allowCrosspost: 'true' },'INVALID_INPUT');
  for (const sourceIds of [[],[source,source],[destination],['bad'],Array(101).fill(source)]) await code({ sourceIds },'INVALID_SOURCES');
  assert.equal((await events()).length,0);
});
test('a deleted foreign unreadable source or unusable destination is rejected', async () => {
  await code({ sourceIds: ['500000000000000099'] },'CHANNEL_UNAVAILABLE');
  resources.channels[1]!.sourceUsable = false; await code({},'CHANNEL_UNAVAILABLE'); resources.channels[1]!.sourceUsable = true;
  resources.channels[0]!.destinationUsable = false; await code({},'CHANNEL_UNAVAILABLE'); assert.equal((await events()).length,0);
});
test('emoji parser supports Unicode sequences and canonical server custom IDs', () => {
  for (const emoji of ['⭐','🌟','❤️','👍🏽','👨‍👩‍👧‍👦','🇺🇸','1️⃣']) assert.ok(resolveBoardEmoji(emoji,[]).emoji_key.startsWith('u:'));
  assert.equal(resolveBoardEmoji('❤️',[]).emoji_key,'u:❤');
  assert.deepEqual(resolveBoardEmoji(`<:oldname:${emojiId}>`,resources.emojis),{ emoji: `<:marustar:${emojiId}>`,emoji_key: `c:${emojiId}` });
  resources.emojis[0]!.animated = true; assert.equal(resolveBoardEmoji(emojiId,resources.emojis).emoji,`<a:marustar:${emojiId}>`);
  for (const text of ['plain text','⭐🌟',':star:','123','<script>','']) assert.throws(() => resolveBoardEmoji(text,[]),/INVALID_EMOJI/);
});
test('foreign deleted or role-restricted custom emojis cannot be saved', async () => {
  await code({ emoji: '<:other:600000000000000099>' },'EMOJI_UNAVAILABLE'); resources.emojis[0]!.usable = false;
  await code({ emoji: emojiId },'EMOJI_UNAVAILABLE'); assert.equal((await events()).length,0);
});
test('session and fresh configured staff access are required inside the write transaction', async () => {
  roles = []; await code({},'STAFF_REQUIRED'); roles = null; await code({},'STAFF_REQUIRED'); roles = [adminRole];
  await code({ sessionToken: randomToken() },'SESSION_EXPIRED');
  await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); await code({},'SESSION_EXPIRED'); assert.equal((await events()).length,0);
});
test('session and board IDs cannot cross server boundaries', async () => {
  await save(); await code({ guildId: otherGuild,action: 'save' },'SESSION_EXPIRED');
  assert.deepEqual(await loadStarboards(pool,otherGuild),[]);
});
test('missing board is never silently created by an edit', async () => { await code({ action: 'save' },'BOARD_NOT_FOUND'); });
test('resource lookup failure rolls back without creating a board', async () => {
  failResources = true; await assert.rejects(save(),/provider unavailable/); assert.equal((await loadStarboards(pool,guild)).length,0);
});
test('audit failure rolls back both creation and edits', async () => {
  failAudit = true; await assert.rejects(save(),/test audit failure/); assert.equal((await loadStarboards(pool,guild)).length,0);
  failAudit = false; await save(); failAudit = true; await assert.rejects(save({ action: 'save',threshold: 9 }),/test audit failure/);
  assert.equal((await loadStarboards(pool,guild))[0]!.threshold,3); assert.equal((await events()).length,1);
});
test('25 board limit is checked under the shared guild lock', async () => {
  await save();
  await db.query(`INSERT INTO starboard_boards (guild_id,board_id,name,destination_channel_id,emoji,emoji_key,threshold,source_channel_ids,created_by,updated_by)
    SELECT $1,('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(n::text,12,'0'))::uuid,'Board '||n,$2,'⭐','u:⭐',3,ARRAY[$3],$4,$4 FROM generate_series(1,24) n`,[guild,destination,source,actor]);
  await code({ boardId: secondId,name: 'Beyond limit' },'BOARD_LIMIT');
});
test('HTTP list and forms require authentication; missing routes and wrong methods are rejected', async () => {
  const noSession = await request('/starboards',{ headers: { cookie: '' } }); assert.equal(noSession.status,303);
  assert.equal((await request(`/starboards/${boardId}`)).status,404);
  assert.equal((await request(`/starboards/${boardId}/create`)).status,405);
  assert.equal((await request('/starboards',{ method: 'POST' })).status,405);
});
test('ordinary Mod can create a board through a protected form and refresh without writing again', async () => {
  roles = [modRole]; const page = await request('/starboards/new'); const html = await page.text();
  assert.match(html,/Reaction posting/); assert.match(html,/Posting|posting/); assert.equal(page.headers.get('referrer-policy'),'same-origin');
  const result = await post(); assert.equal(result.status,303); assert.equal(result.headers.get('location'),`/starboards/${boardId}`);
  const edit = await request(result.headers.get('location')!); assert.equal(edit.status,200); assert.match(await edit.text(),/Save board/);
  await request(`/starboards/${boardId}`); assert.equal((await events()).length,1);
});
test('HTTP origin content type and purpose/action/board/revision CSRF binding are enforced', async () => {
  for (const origin of ['https://elsewhere.test','null','']) assert.equal((await post(form(),boardId,'create',{ origin })).status,403);
  assert.equal((await post(form(),boardId,'create',{ 'content-type': 'application/json' })).status,403);
  for (const csrf of [settingsProof(sessionToken),starboardProof(sessionToken,secondId,0,'create'),starboardProof(sessionToken,boardId,0,'save'),starboardProof(sessionToken,boardId,1,'create')]) {
    assert.equal((await post(form({ csrf }))).status,403);
  }
  assert.equal((await events()).length,0);
});
test('HTTP duplicate unknown malformed and oversized fields are rejected', async () => {
  const duplicate = form(); duplicate.append('threshold','5'); assert.equal((await post(duplicate)).status,400);
  const unknown = form(); unknown.append('guild_id',otherGuild); assert.equal((await post(unknown)).status,400);
  assert.equal((await post(form({ threshold: '1.5' }))).status,400); assert.equal((await post(form({ revision: '01' }))).status,400);
  assert.equal((await post(form({ allow_crosspost: 'maybe' }))).status,400);
  assert.equal((await post('x'.repeat(32769))).status,413); assert.equal((await events()).length,0);
});
test('HTTP source checkboxes permit repeated keys only for distinct eligible channels', async () => {
  const multiple = form(); multiple.append('source_id',source2); assert.equal((await post(multiple)).status,303);
  assert.deepEqual((await loadStarboards(pool,guild))[0]!.source_channel_ids,[source,source2]);
  const duplicate = form({},secondId); duplicate.set('name','Second board'); duplicate.append('source_id',source);
  assert.equal((await post(duplicate,secondId)).status,400);
});
test('HTTP role loss between page guard and write authorization prevents saving', async () => {
  let reads = 0; roleHook = async () => { if (++reads === 2) roles = []; };
  assert.equal((await post()).status,403); assert.equal((await loadStarboards(pool,guild)).length,0);
});
test('HTTP expired sessions and reconnecting bot cannot change boards', async () => {
  botReady = false; assert.equal((await post()).status,503); botReady = true;
  await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); assert.equal((await post()).status,303); assert.equal((await events()).length,0);
});
test('HTTP stale edit cannot overwrite another staff edit', async () => {
  await save(); const old = form({ threshold: '9' },boardId,0,'save'); await save({ action: 'save',threshold: 7 });
  assert.equal((await post(old,boardId,'save')).status,409); assert.equal((await loadStarboards(pool,guild))[0]!.threshold,7);
});
test('HTTP audit and Discord lookup failures return unavailable without a partial write', async () => {
  failAudit = true; assert.equal((await post()).status,503); failAudit = false; failResources = true; assert.equal((await post()).status,503);
  assert.equal((await loadStarboards(pool,guild)).length,0);
});
test('stored boards survive handler restart and do not require sending any Discord messages', async () => {
  await save(); handler = makeHandler(); const response = await request('/starboards'); assert.equal(response.status,200);
  assert.match(await response.text(),/Community highlights/); assert.equal((await events()).length,1);
});
test('UI escapes board and channel names and preserves missing channel selections honestly', async () => {
  await save({ name: '<script>alert(1)</script>' }); resources.channels[1]!.name = '<img src=x onerror=alert(1)>';
  let html = await (await request(`/starboards/${boardId}`)).text(); assert.match(html,/&lt;script&gt;/); assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<img src=x')); assert.match(html,/&lt;img/);
  resources.channels = []; html = await (await request(`/starboards/${boardId}`)).text(); assert.match(html,/Unavailable channel/);
  assert.match(html,new RegExp(`value="${source}" checked`));
});
test('foreign boards return 404 and are never visible in list', async () => {
  await query('INSERT INTO dashboard_sessions (token_hash,guild_id,user_id,display_name,expires_at) VALUES ($1,$2,$3,$4,NOW()+INTERVAL \'1 hour\')',[digest('other-session'),otherGuild,actor,'Other']);
  await save({ guildId: otherGuild,sessionToken: 'other-session',name: 'Foreign board secret' });
  assert.equal((await request(`/starboards/${boardId}`)).status,404); const html = await (await request('/starboards')).text(); assert.ok(!html.includes('Foreign board secret'));
});
test('Discord adapter distinguishes source read access from destination send access and filters channel types', async () => {
  const calls: unknown[] = [];
  const me = { roles: { cache: new Map([[adminRole,{}]]) } };
  const makeChannel = (id: string,type: ChannelType,granted: bigint[]) => ({ id,type,name: 'channel',permissionsFor: () => ({ has: (bits: bigint[]) => bits.every((bit) => granted.includes(bit)) }) });
  const read = [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory];
  const fakeGuild = { roles: { fetch: async () => { calls.push('roles'); } },members: { fetchMe: async (opts: unknown) => { calls.push(opts); return me; } },
    channels: { fetch: async () => new Map([
      [source,makeChannel(source,ChannelType.GuildText,read)],
      [destination,makeChannel(destination,ChannelType.GuildAnnouncement,[...read,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks])],
      [source2,makeChannel(source2,ChannelType.GuildVoice,read)],
    ]) },emojis: { fetch: async () => new Map([[emojiId,{ id: emojiId,name: 'restricted',animated: true,available: true,
      roles: { cache: new Collection([['no-access',{ id: 'no-access' }]]) } }]]) } };
  const client = { guilds: { fetch: async (opts: unknown) => { calls.push(opts); return fakeGuild; } } } as unknown as Client;
  const result = await starboardResources(client,guild)(); assert.equal(result.channels.length,2);
  assert.equal(result.channels.find((c) => c.id === source)!.sourceUsable,true); assert.equal(result.channels.find((c) => c.id === source)!.destinationUsable,false);
  assert.equal(result.channels.find((c) => c.id === destination)!.destinationUsable,true); assert.equal(result.emojis[0]!.usable,false);
  assert.deepEqual(calls,[{ guild,force: true },'roles',{ force: true }]);
});


test('rendered new-board form has a usable proof bound to its generated board ID', async () => {
  const html = await (await request('/starboards/new')).text();
  const id = /action="\/starboards\/([0-9a-f-]{36})\/create"/.exec(html)![1]!;
  const formProofs = [...html.matchAll(/name="csrf" value="([A-Za-z0-9_-]{43})"/g)].map((match) => match[1]);
  const csrf = formProofs.find((proof) => proof === starboardProof(sessionToken,id,0,'create'))!;
  assert.ok(csrf); assert.match(html,/value="3"/);
  assert.equal((await post(form({ csrf },id),id)).status,303);
  assert.equal((await loadStarboards(pool,guild))[0]!.board_id,id);
});
test('HTTP edit saves checked sources and cross-post choice and links the audit to the board', async () => {
  await save(); const body = form({ threshold: '8',allow_crosspost: 'true',reason: 'Community event' },boardId,0,'save');
  body.append('source_id',source2); assert.equal((await post(body,boardId,'save')).status,303);
  const html = await (await request(`/starboards/${boardId}`)).text();
  assert.match(html,/value="8"/); assert.match(html,/value="true" selected/); assert.match(html,/Saved configuration · Revision 1/);
  assert.match(html,new RegExp(`value="${source2}" checked`));
  const overview = await (await request('/dashboard')).text(); assert.ok(overview.includes(`href="/starboards/${boardId}"`));
});

test('board enable and disable choices persist with a complete audit trail', async () => {
  await save({ enabled: true }); assert.equal((await loadStarboards(pool,guild))[0]!.enabled,true);
  await save({ action: 'save',enabled: false,reason: 'Pause posting' });
  assert.equal((await loadStarboards(pool,guild))[0]!.enabled,false);
  const last = (await events())[1]!.details; assert.equal((last.before as Record<string,unknown>).enabled,true); assert.equal((last.after as Record<string,unknown>).enabled,false);
});
test('HTTP form requires an explicit posting choice and persists On', async () => {
  const missing = form(); missing.delete('enabled'); assert.equal((await post(missing)).status,400);
  assert.equal((await post(form({ enabled: 'true' }))).status,303);
  const html = await (await request(`/starboards/${boardId}`)).text(); assert.match(html,/value="true" selected>On/);
});
test('configuration changes queue already observed sources for reevaluation', async () => {
  await save(); await query(`INSERT INTO starboard_jobs (guild_id,source_channel_id,source_message_id,version,processed_version) VALUES ($1,$2,$3,1,1)`,[guild,source,'900000000000000001']);
  await save({ action: 'save',threshold: 7 });
  const job = (await db.query<{ version: string; processed_version: string }>('SELECT version,processed_version FROM starboard_jobs')).rows[0]!;
  assert.notEqual(job.version,job.processed_version);
});
test('unconfirmed deliveries are visible after a page refresh', async () => {
  await save(); await query(`INSERT INTO starboard_posts (guild_id,board_id,source_channel_id,source_message_id,destination_channel_id,state,marker)
    VALUES ($1,$2,$3,$4,$5,'creating','uncertain test')`,[guild,boardId,source,'900000000000000001',destination]);
  const html = await (await request('/starboards')).text(); assert.match(html,/delivery needs review/);
});

test('authorized staff can switch posting off even if saved channel resources are unavailable', async () => {
  await save({ enabled: true }); failResources = true;
  await save({ action: 'save',enabled: false });
  assert.equal((await loadStarboards(pool,guild))[0]!.enabled,false);
});


function deleteInput(overrides: Record<string,unknown> = {}) {
  return { guildId: guild,actorId: actor,sessionToken,boardId,revision: 0,confirmation: 'Community highlights',
    removeHighlights: false,reason: 'Remove test board',readMemberRoles: readRoles,...overrides };
}
function deleteForm(overrides: Record<string,string> = {}) {
  return new URLSearchParams({ csrf: starboardProof(sessionToken,boardId,0,'delete'),revision: '0',confirmation: 'Community highlights',reason: 'Remove test board',...overrides });
}
async function postDelete(body: URLSearchParams | string = deleteForm(),headers: Record<string,string> = {}) {
  return request(`/starboards/${boardId}/delete`,{ method: 'POST',headers: { origin: base,'content-type': 'application/x-www-form-urlencoded',...headers },body });
}
async function seedPosted() {
  await query(`INSERT INTO starboard_posts (guild_id,board_id,source_channel_id,source_message_id,destination_channel_id,state,marker,post_message_id)
    VALUES ($1,$2,$3,$4,$5,'posted','managed highlight',$6)`,[guild,boardId,source,'900000000000000001',destination,'800000000000000001']);
}
test('delete keeps highlights by default, hides the board and preserves an immutable audit record', async () => {
  await save({ enabled: true }); await seedPosted();
  assert.equal(await deleteStarboard(pool,deleteInput()),'changed'); assert.deepEqual(await loadStarboards(pool,guild),[]);
  const record = (await db.query<{ state: string; post_message_id: string | null; retained_post_message_id: string }>('SELECT * FROM starboard_posts')).rows[0]!;
  assert.equal(record.state,'absent'); assert.equal(record.post_message_id,null); assert.equal(record.retained_post_message_id,'800000000000000001');
  const audit = (await events())[1]!; assert.equal(audit.event_type,'STARBOARD_DELETED'); assert.equal(audit.details.remove_highlights,false);
  assert.equal(audit.details.known_highlights,1); assert.equal((audit.details.before as Record<string,unknown>).enabled,true);
});
test('deletion with cleanup preserves live post ownership and exposes pending removal', async () => {
  await save({ enabled: true }); await seedPosted();
  await deleteStarboard(pool,deleteInput({ removeHighlights: true }));
  assert.equal((await db.query<{ state: string }>('SELECT state FROM starboard_posts')).rows[0]!.state,'posted');
  const pending = await loadBoardDeletions(pool,guild); assert.equal(pending[0]!.pending_count,1);
  const html = await (await request('/starboards')).text(); assert.match(html,/awaiting removal/); assert.ok(!html.includes('Edit board'));
});
test('repeated deletion is idempotent and cannot change the original keep/remove choice', async () => {
  await save(); const data = deleteInput(); await deleteStarboard(pool,data); assert.equal(await deleteStarboard(pool,data),'unchanged');
  await assert.rejects(deleteStarboard(pool,{ ...data,removeHighlights: true }),/STALE_BOARD/); assert.equal((await events()).length,2);
});
test('confirmation and stale revisions prevent unintended deletion', async () => {
  await save(); await assert.rejects(deleteStarboard(pool,deleteInput({ confirmation: 'Wrong board' })),/CONFIRM_REQUIRED/);
  await save({ action: 'save',threshold: 8 }); await assert.rejects(deleteStarboard(pool,deleteInput()),/STALE_BOARD/);
  assert.equal((await loadStarboards(pool,guild)).length,1);
});
test('ordinary Mods can delete boards without a full access grant', async () => {
  await save(); roles = [modRole]; await deleteStarboard(pool,deleteInput()); assert.equal((await loadStarboards(pool,guild)).length,0);
});
test('deleted names can be reused and stale edit forms cannot resurrect a deleted board', async () => {
  await save(); await deleteStarboard(pool,deleteInput()); await code({ action: 'save' },'BOARD_NOT_FOUND');
  await save({ boardId: secondId }); assert.equal((await loadStarboards(pool,guild))[0]!.board_id,secondId);
  await assert.rejects(query('UPDATE starboard_boards SET enabled=TRUE WHERE board_id=$1',[boardId]),/STARBOARD_DELETED_READ_ONLY/);
});
test('deletion needs a current session and current staff roles inside the transaction', async () => {
  await save(); roles = []; await assert.rejects(deleteStarboard(pool,deleteInput()),/STAFF_REQUIRED/); roles = [adminRole];
  await assert.rejects(deleteStarboard(pool,deleteInput({ sessionToken: randomToken() })),/SESSION_EXPIRED/);
  await assert.rejects(deleteStarboard(pool,deleteInput({ guildId: otherGuild })),/SESSION_EXPIRED/);
  assert.equal((await loadStarboards(pool,guild)).length,1);
});
test('delete requires a bounded reason, valid inputs and an existing board', async () => {
  await assert.rejects(deleteStarboard(pool,deleteInput()),/BOARD_NOT_FOUND/);
  await save(); for (const reason of [' ','x'.repeat(501)]) await assert.rejects(deleteStarboard(pool,deleteInput({ reason })),/INVALID_REASON/);
  await assert.rejects(deleteStarboard(pool,deleteInput({ revision: -1 })),/INVALID_INPUT/);
  await assert.rejects(deleteStarboard(pool,deleteInput({ removeHighlights: 'true' })),/INVALID_INPUT/);
});
test('audit failure rolls back board deletion, ownership changes and queue writes together', async () => {
  await save({ enabled: true }); await seedPosted(); failAudit = true;
  await assert.rejects(deleteStarboard(pool,deleteInput()),/test audit failure/);
  assert.equal((await loadStarboards(pool,guild))[0]!.enabled,true);
  assert.equal((await db.query<{ state: string }>('SELECT state FROM starboard_posts')).rows[0]!.state,'posted');
  assert.equal((await events()).length,1); assert.equal((await db.query('SELECT * FROM starboard_jobs')).rows.length,0);
});
test('board deletion does not depend on available Discord channel resources', async () => {
  await save(); failResources = true;
  assert.equal((await request(`/starboards/${boardId}/delete-confirm`)).status,200);
  assert.equal((await postDelete()).status,303); assert.equal((await loadStarboards(pool,guild)).length,0);
});
test('delete page offers an unchecked cleanup checkbox and escapes the displayed name', async () => {
  await save({ name: '<b>Highlights</b>' });
  const html = await (await request(`/starboards/${boardId}/delete-confirm`)).text();
  assert.match(html,/&lt;b&gt;Highlights&lt;\/b&gt;/); assert.ok(!html.includes('<b>Highlights</b>'));
  assert.match(html,/name="remove_highlights" value="true">/); assert.ok(!html.includes('value="true" checked'));
  assert.match(html,/unmanaged snapshots/); assert.match(html,/Original source messages/);
});
test('HTTP deletion checks method origin content type and purpose-bound CSRF', async () => {
  await save(); assert.equal((await request(`/starboards/${boardId}/delete`)).status,405);
  for (const origin of ['https://elsewhere.test','null','']) assert.equal((await postDelete(deleteForm(),{ origin })).status,403);
  assert.equal((await postDelete(deleteForm(),{ 'content-type': 'application/json' })).status,403);
  for (const csrf of [settingsProof(sessionToken),starboardProof(sessionToken,boardId,0,'save'),starboardProof(sessionToken,secondId,0,'delete'),starboardProof(sessionToken,boardId,1,'delete')]) {
    assert.equal((await postDelete(deleteForm({ csrf }))).status,403);
  }
  assert.equal((await loadStarboards(pool,guild)).length,1);
});
test('HTTP delete rejects missing duplicate unknown oversized and malformed fields', async () => {
  await save(); const duplicate = deleteForm(); duplicate.append('remove_highlights','true'); duplicate.append('remove_highlights','true');
  assert.equal((await postDelete(duplicate)).status,400);
  const unknown = deleteForm(); unknown.append('guild_id',otherGuild); assert.equal((await postDelete(unknown)).status,400);
  const missing = deleteForm(); missing.delete('reason'); assert.equal((await postDelete(missing)).status,400);
  assert.equal((await postDelete(deleteForm({ remove_highlights: 'false' }))).status,400);
  assert.equal((await postDelete(deleteForm({ revision: '01' }))).status,400); assert.equal((await postDelete('x'.repeat(8193))).status,413);
});
test('HTTP delete keeps messages by default and refreshing its result never repeats the mutation', async () => {
  await save(); const result = await postDelete(); assert.equal(result.status,303);
  const html = await (await request(result.headers.get('location')!)).text(); assert.match(html,/Existing highlights were kept/);
  await request(result.headers.get('location')!); assert.equal((await events()).length,2);
  assert.equal((await request(`/starboards/${boardId}`)).status,404);
});
test('HTTP deletion rechecks current roles and rejects an expired session', async () => {
  await save(); let calls = 0; roleHook = async () => { if (++calls === 2) roles = []; };
  assert.equal((await postDelete()).status,403); roleHook = undefined; roles = [adminRole];
  await query("UPDATE dashboard_sessions SET expires_at=NOW()-INTERVAL '1 second'"); assert.equal((await postDelete()).status,303);
  assert.equal((await loadStarboards(pool,guild)).length,1);
});
test('deleted boards stop counting against the 25-board limit', async () => {
  await save(); await deleteStarboard(pool,deleteInput());
  await db.query(`INSERT INTO starboard_boards (guild_id,board_id,name,destination_channel_id,emoji,emoji_key,threshold,source_channel_ids,created_by,updated_by)
    SELECT $1,('aaaaaaaa-aaaa-4aaa-8aaa-' || lpad(n::text,12,'0'))::uuid,'Board '||n,$2,'⭐','u:⭐',3,ARRAY[$3],$4,$4 FROM generate_series(1,24) n`,[guild,destination,source,actor]);
  await save({ boardId: secondId,name: 'Last active board' }); assert.equal((await loadStarboards(pool,guild)).length,25);
});
