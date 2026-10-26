import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { APIUser, APIMessage, Client, REST, RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { enqueueStarboardEvent, parseStarboardEvent, processStarboardJob, sweepStarboards } from '../src/starboard-worker.js';
import { chooseBoards, highlightBody, StarboardRuntimeError } from '../src/starboard-engine.js';
import type { StarboardDependencies, StarboardSource, StarboardPost } from '../src/starboard-engine.js';
import { countReactionVotes, reactionKey, starboardRuntimeDependencies } from '../src/starboard-runtime-discord.js';
import type { StarboardBoard } from '../src/starboard-settings.js';

const db = new PGlite();
const guild = '100000000000000001', otherGuild = '100000000000000002';
const sourceChannel = '500000000000000001', destination = '500000000000000002', otherDestination = '500000000000000003';
const sourceId = '600000000000000001', bot = '700000000000000001', author = '300000000000000001';
const user1 = '300000000000000002', user2 = '300000000000000003', user3 = '300000000000000004';
const boardId = '11111111-1111-4111-8111-111111111111', board2 = '22222222-2222-4222-8222-222222222222';
let busy = false, failRequestAudit = false, failResultAudit = false, failUnlock = false, discarded = false, transaction = false;
async function query(sql: string,values?: unknown[]) {
  if (busy && sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }],rowCount: 1 };
  if (failUnlock && sql.includes('pg_advisory_unlock(')) throw new Error('unlock lost');
  if (failRequestAudit && sql.includes("'STARBOARD_CREATE_REQUESTED'")) throw new Error('private audit diagnostic');
  if (failResultAudit && values?.[2] === 'STARBOARD_POST_CREATED') throw new Error('private result diagnostic');
  const result = await db.query(sql,values);
  if (sql === 'BEGIN') transaction = true; if (['COMMIT','ROLLBACK'].includes(sql)) transaction = false;
  return { rows: result.rows,rowCount: result.rows.length || result.affectedRows || 0 };
}
const pool = { query,async connect() { return { query,release(error?: Error) { if (error) discarded = true; } }; } } as unknown as Pool;
let source: StarboardSource | null;
let sourceFailure = false, destinationFailure = false, deleteFailure = false, editFailure = false;
let createFailure: 'before'|'after'|'forbidden'|'invalid'|undefined;
let calls: { create: number; edit: number; delete: number; find: number; read: number };
let nextPost = 800000000000000000n;
let posts = new Map<string,{ channel: string; body: RESTPostAPIChannelMessageJSONBody }>();
let votes: Record<string,APIUser[]>;
let onCreate: (() => Promise<void>) | undefined;
const deps: StarboardDependencies = {
  botId: () => bot,
  readSource: async () => { calls.read++; if (sourceFailure) throw Object.assign(new Error('private lookup'),{ status: 403 }); return source; },
  countVotes: async (message,key) => countReactionVotes(message,key,async (_emoji,type) => votes[`${key}:${type}`] ?? []),
  validateDestination: async () => { if (destinationFailure) throw new StarboardRuntimeError('DESTINATION_UNAVAILABLE'); },
  inspectPost: async (entry) => posts.has(entry.post_message_id!),
  findCreated: async (entry) => { calls.find++; return [...posts.entries()].find(([,post]) => post.channel === entry.destination_channel_id && post.body.embeds?.[0]?.footer?.text === entry.marker)?.[0] ?? null; },
  createPost: async (channel,body) => {
    assert.equal(transaction,false,'create intent commits before any Discord message POST');
    const claimed = (await query("SELECT * FROM starboard_posts WHERE state='creating'")).rows;
    assert.ok(claimed.length); calls.create++; await onCreate?.();
    if (createFailure === 'before') throw new Error('private network failure');
    if (createFailure === 'forbidden') throw Object.assign(new Error('private Discord response'),{ status: 403 });
    if (createFailure === 'invalid') return 'invalid';
    const id = String(++nextPost); posts.set(id,{ channel,body });
    if (createFailure === 'after') throw new Error('response lost after creation'); return id;
  },
  editPost: async (entry,body) => { calls.edit++; if (editFailure) throw new Error('edit response lost'); posts.set(entry.post_message_id!,{ channel: entry.destination_channel_id,body }); },
  deletePost: async (entry) => { calls.delete++; posts.delete(entry.post_message_id!); if (deleteFailure) throw new Error('delete response lost'); },
};
function board(overrides: Record<string,unknown> = {}): StarboardBoard {
  return { guild_id: guild,board_id: boardId,name: 'Highlights',destination_channel_id: destination,emoji: '⭐',emoji_key: 'u:⭐',threshold: 2,
    source_channel_ids: [sourceChannel],allow_crosspost: false,enabled: true,revision: 0,created_by: author,updated_by: author,created_at: new Date(),updated_at: new Date(),...overrides };
}
async function addBoard(overrides: Record<string,unknown> = {}) {
  const value = board(overrides);
  await query(`INSERT INTO starboard_boards (guild_id,board_id,name,destination_channel_id,emoji,emoji_key,threshold,source_channel_ids,allow_crosspost,enabled,created_by,updated_by,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)`,[value.guild_id,value.board_id,value.name,value.destination_channel_id,value.emoji,value.emoji_key,value.threshold,value.source_channel_ids,value.allow_crosspost,value.enabled,author,value.created_at]);
}
async function enqueue(deleted = false,channelId = sourceChannel,messageIds = [sourceId]) {
  await enqueueStarboardEvent(pool,{ guildId: guild,channelId,messageIds,deleted });
}
async function work() { return processStarboardJob(pool,guild,deps); }
async function retry() { await query("UPDATE starboard_jobs SET available_at=NOW()-INTERVAL '1 second'"); return work(); }
async function rows() { return (await query('SELECT * FROM starboard_posts ORDER BY board_id')).rows as StarboardPost[]; }
async function jobRows() { return (await query('SELECT * FROM starboard_jobs')).rows as Record<string,unknown>[]; }
function setVotes(ids: string[],key = 'u:⭐') { votes[`${key}:0`] = ids.map((id) => ({ id,username: 'human',discriminator: '0',avatar: null })); }
before(async () => {
  for (const name of ['001_foundation.sql','002_dashboard_auth.sql','007_starboard_settings.sql','008_starboard_reactions.sql']) await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
});
beforeEach(async () => {
  busy = failRequestAudit = failResultAudit = failUnlock = discarded = transaction = false;
  sourceFailure = destinationFailure = deleteFailure = editFailure = false; createFailure = undefined; onCreate = undefined;
  calls = { create: 0,edit: 0,delete: 0,find: 0,read: 0 }; posts = new Map(); votes = {};
  source = { id: sourceId,channelId: sourceChannel,authorId: author,authorName: 'Artist',content: 'A community highlight',timestamp: new Date().toISOString(),attachments: [],
    reactions: [{ key: 'u:⭐',apiEmoji: '⭐',normal: 2,burst: 0 }] }; setVotes([user1,user2]);
  await db.exec('SELECT pg_advisory_unlock_all()');
  await db.exec('TRUNCATE starboard_jobs,starboard_posts,starboard_boards,dashboard_login_attempts,dashboard_sessions,audit_events,staff_access_grants,staff_roles,guild_settings RESTART IDENTITY');
  await query('INSERT INTO guild_settings (guild_id) VALUES ($1),($2)',[guild,otherGuild]); await addBoard();
});
after(async () => { await db.close(); });

test('threshold creates one persisted bot highlight and no duplicate on repeated events', async () => {
  await enqueue(); assert.equal(await work(),true); assert.equal(posts.size,1); assert.equal((await rows())[0]!.state,'posted');
  await enqueue(); await enqueue(); await work(); assert.equal(calls.create,1); assert.equal(calls.edit,0);
  assert.equal((await jobRows())[0]!.version,(await jobRows())[0]!.processed_version);
});
test('author self-votes and bot votes cannot reach the threshold', async () => {
  setVotes([author,user1]); votes['u:⭐:0']!.push({ id: bot,bot: true } as APIUser);
  await enqueue(); await work(); assert.equal(calls.create,0);
  setVotes([author,user1,user2]); await enqueue(); await work(); assert.equal(calls.create,1);
});
test('normal and super reactions from the same member count once', async () => {
  source!.reactions[0]!.burst = 2; setVotes([user1]); votes['u:⭐:1'] = [{ id: user1 },{ id: user2 }] as APIUser[];
  await enqueue(); await work(); const body = [...posts.values()][0]!.body; assert.match(body.content!,/\*\*2\*\*/);
});
test('dropping below threshold removes highlight and qualifying again uses a new generation', async () => {
  await enqueue(); await work(); const first = (await rows())[0]!.post_message_id;
  setVotes([user1]); await enqueue(); await work(); assert.equal(posts.size,0); assert.equal((await rows())[0]!.state,'absent');
  setVotes([user1,user2]); await enqueue(); await work(); const entry = (await rows())[0]!;
  assert.equal(entry.generation,2); assert.notEqual(entry.post_message_id,first); assert.equal(calls.create,2);
});
test('removing every reaction also removes the managed highlight', async () => {
  await enqueue(); await work(); source!.reactions = []; await enqueue(); await work(); assert.equal(posts.size,0);
});
test('source deletion removes the highlight without trying to fetch missing source data', async () => {
  await enqueue(); await work(); const reads = calls.read; await enqueue(true); await work(); assert.equal(posts.size,0); assert.equal(calls.read,reads);
  assert.equal((await jobRows())[0]!.source_deleted,true);
});
test('late reaction events cannot resurrect a deleted source tombstone', async () => {
  await enqueue(true); await work(); await enqueue(); await work(); assert.equal(calls.create,0); assert.equal(calls.read,0);
});
test('missed deletion while offline is recovered from a fresh missing-source response', async () => {
  await enqueue(); await work(); source = null; await enqueue(); await work(); assert.equal(posts.size,0); assert.equal((await jobRows())[0]!.source_deleted,true);
});
test('temporary source access failure never masquerades as source deletion', async () => {
  await enqueue(); await work(); sourceFailure = true; await enqueue(); assert.equal(await work(),false);
  assert.equal(posts.size,1); assert.equal((await jobRows())[0]!.source_deleted,false);
});
test('highlight count and edited source content update the existing post without another POST', async () => {
  await enqueue(); await work(); setVotes([user1,user2,user3]); source!.content = 'Updated art description'; await enqueue(); await work();
  assert.equal(calls.create,1); assert.equal(calls.edit,1); const body = [...posts.values()][0]!.body;
  assert.match(body.content!,/\*\*3\*\*/); assert.equal(body.embeds![0]!.description,'Updated art description');
});
test('pausing a board removes only its managed highlights', async () => {
  await enqueue(); await work(); posts.set('900000000000000001',{ channel: destination,body: { content: 'Old Dyno post' } });
  await query('UPDATE starboard_boards SET enabled=FALSE'); await enqueue(); await work(); assert.equal(posts.size,1); assert.equal([...posts.values()][0]!.body.content,'Old Dyno post');
});
test('disabled and ineligible boards do not watch unrelated messages', async () => {
  await query('UPDATE starboard_boards SET enabled=FALSE'); await enqueue(); assert.equal((await jobRows()).length,0);
  await query('UPDATE starboard_boards SET enabled=TRUE'); await enqueue(false,otherDestination); assert.equal((await jobRows()).length,0);
});
test('cross-posting on every participating board permits multiple highlights', async () => {
  await query('UPDATE starboard_boards SET allow_crosspost=TRUE'); await addBoard({ board_id: board2,name: 'Second',destination_channel_id: otherDestination,allow_crosspost: true });
  await enqueue(); await work(); assert.equal(posts.size,2);
});
test('earlier-created board wins an exclusive conflict and later board can qualify when it stops qualifying', async () => {
  await addBoard({ board_id: board2,name: 'Second',destination_channel_id: otherDestination,emoji: '🌟',emoji_key: 'u:🌟',allow_crosspost: true });
  source!.reactions.push({ key: 'u:🌟',apiEmoji: '🌟',normal: 2,burst: 0 }); setVotes([user1,user2],'u:🌟');
  await enqueue(); await work(); assert.equal(posts.size,1); assert.equal((await rows())[0]!.board_id,boardId);
  setVotes([]); await enqueue(); await work(); assert.equal(posts.size,1); assert.equal([...posts.values()][0]!.channel,otherDestination);
});
test('changing source eligibility removes a previously managed highlight', async () => {
  await enqueue(); await work(); await query('UPDATE starboard_boards SET source_channel_ids=ARRAY[$1]',[otherDestination]);
  await enqueue(); await work(); assert.equal(posts.size,0);
});
test('moving a destination confirms removal before creating the replacement', async () => {
  await enqueue(); await work(); await query('UPDATE starboard_boards SET destination_channel_id=$1',[otherDestination]); await enqueue(); await work();
  assert.equal(posts.size,1); assert.equal(calls.delete,1); assert.equal(calls.create,2); assert.equal([...posts.values()][0]!.channel,otherDestination);
});
test('lost create response is recovered by marker without resending the message', async () => {
  createFailure = 'after'; await enqueue(); assert.equal(await work(),false); assert.equal(posts.size,1); assert.equal((await rows())[0]!.state,'creating');
  createFailure = undefined; await retry(); assert.equal(calls.create,1); assert.equal((await rows())[0]!.state,'posted'); assert.equal(calls.find,1);
});
test('unconfirmed create with no located copy never automatically issues another POST', async () => {
  createFailure = 'before'; await enqueue(); await work(); createFailure = undefined;
  await retry(); await retry(); assert.equal(calls.create,1); assert.equal(posts.size,0); assert.equal((await rows())[0]!.state,'creating');
  assert.equal((await jobRows())[0]!.last_error,'DELIVERY_UNCONFIRMED');
});
test('invalid creation response remains uncertain and is not retried as another create', async () => {
  createFailure = 'invalid'; await enqueue(); await work(); await retry(); assert.equal(calls.create,1); assert.equal((await rows())[0]!.state,'creating');
});
test('explicit Discord rejection allows a later fresh attempt after access is restored', async () => {
  createFailure = 'forbidden'; await enqueue(); await work(); assert.equal((await rows())[0]!.state,'absent');
  createFailure = undefined; await retry(); assert.equal(posts.size,1); assert.equal(calls.create,2);
});
test('create intent audit failure prevents the external POST', async () => {
  failRequestAudit = true; await enqueue(); await work(); assert.equal(calls.create,0); assert.equal((await rows()).length,0);
  failRequestAudit = false; await retry(); assert.equal(calls.create,1);
});
test('database failure recording create success recovers the existing post after restart', async () => {
  failResultAudit = true; await enqueue(); await work(); assert.equal(posts.size,1); assert.equal((await rows())[0]!.state,'creating');
  failResultAudit = false; await retry(); assert.equal(calls.create,1); assert.equal((await rows())[0]!.state,'posted');
});
test('lost delete response is confirmed absent before any repost', async () => {
  await enqueue(); await work(); setVotes([]); deleteFailure = true; await enqueue(); await work(); assert.equal(posts.size,0); assert.equal((await rows())[0]!.state,'deleting');
  deleteFailure = false; await retry(); assert.equal((await rows())[0]!.state,'absent'); assert.equal(calls.delete,1);
});
test('source deleted after an uncertain create is recovered and its copy is removed', async () => {
  createFailure = 'after'; await enqueue(); await work(); createFailure = undefined; await enqueue(true); await work();
  assert.equal(posts.size,0); assert.equal(calls.create,1); assert.equal((await rows())[0]!.state,'absent');
});
test('manual deletion of a managed copy queues the original and creates one replacement', async () => {
  await enqueue(); await work(); const entry = (await rows())[0]!; posts.delete(entry.post_message_id!);
  await enqueue(true,destination,[entry.post_message_id!]); await work(); assert.equal(posts.size,1); assert.equal(calls.create,2);
  assert.equal((await jobRows()).find((job) => job.source_message_id === sourceId)!.source_deleted,false);
});
test('worker ignores Maru-authored source messages to prevent board loops', async () => {
  source!.authorId = bot; await enqueue(); await work(); assert.equal(calls.create,0);
});
test('queue preserves an event that arrives during processing for another fresh reconciliation', async () => {
  onCreate = async () => { await enqueue(); }; await enqueue(); await work(); const pending = (await jobRows())[0]!;
  assert.notEqual(pending.version,pending.processed_version); onCreate = undefined; await work(); assert.equal(calls.create,1);
});
test('restart sweep schedules tracked sources, without importing untracked channel history', async () => {
  await enqueue(); await work(); await query("UPDATE starboard_jobs SET checked_at=NOW()-INTERVAL '11 minutes'"); await sweepStarboards(pool,guild);
  const pending = (await jobRows())[0]!; assert.notEqual(pending.version,pending.processed_version); assert.equal((await jobRows()).length,1);
});
test('server-scoped queue cannot process another server’s work', async () => {
  await enqueue(); assert.equal(await processStarboardJob(pool,otherGuild,deps),false); assert.equal(calls.create,0); await work(); assert.equal(calls.create,1);
});
test('advisory lock contention prevents parallel worker actions', async () => {
  await enqueue(); busy = true; assert.equal(await work(),false); assert.equal(calls.create,0); busy = false; await work(); assert.equal(calls.create,1);
});
test('failed unlock discards the connection instead of returning a held lock to the pool', async () => {
  await enqueue(); failUnlock = true; await work(); assert.equal(discarded,true); failUnlock = false; await db.exec('SELECT pg_advisory_unlock_all()');
});
test('blocked destination performs no POST and can recover after permissions are repaired', async () => {
  destinationFailure = true; await enqueue(); await work(); assert.equal(calls.create,0); assert.equal((await rows())[0]!.state,'absent');
  destinationFailure = false; await retry(); assert.equal(calls.create,1);
});
test('lost edit response only retries the same message edit', async () => {
  await enqueue(); await work(); source!.content = 'Edit'; editFailure = true; await enqueue(); await work();
  editFailure = false; await retry(); assert.equal(calls.create,1); assert.equal(calls.edit,2);
});
test('invalid counts do not remove an existing highlight', async () => {
  await enqueue(); await work(); await enqueue(); const bad = { ...deps,countVotes: async () => NaN };
  assert.equal(await processStarboardJob(pool,guild,bad),false); assert.equal(posts.size,1);
});
test('event parser handles uncached reaction add/remove/clear, edits and bulk deletion', () => {
  for (const t of ['MESSAGE_REACTION_ADD','MESSAGE_REACTION_REMOVE','MESSAGE_REACTION_REMOVE_EMOJI','MESSAGE_REACTION_REMOVE_ALL']) {
    const result = parseStarboardEvent({ t,d: { guild_id: guild,channel_id: sourceChannel,message_id: sourceId,emoji: { name: '❤️' } } },guild)!;
    assert.deepEqual(result.messageIds,[sourceId]); assert.equal(result.deleted,false); assert.equal(result.emojiKey,'u:❤');
  }
  assert.equal(parseStarboardEvent({ t: 'MESSAGE_DELETE',d: { guild_id: guild,channel_id: sourceChannel,id: sourceId } },guild)!.deleted,true);
  assert.deepEqual(parseStarboardEvent({ t: 'MESSAGE_DELETE_BULK',d: { guild_id: guild,channel_id: sourceChannel,ids: [sourceId,sourceId] } },guild)!.messageIds,[sourceId]);
  assert.ok(parseStarboardEvent({ t: 'MESSAGE_UPDATE',d: { guild_id: guild,channel_id: sourceChannel,id: sourceId } },guild));
});
test('foreign malformed and unsupported events never enter the queue', () => {
  for (const packet of [{ t: 'TYPING_START',d: {} },{ t: 'MESSAGE_DELETE',d: { guild_id: otherGuild,channel_id: sourceChannel,id: sourceId } },
    { t: 'MESSAGE_DELETE',d: { guild_id: guild,channel_id: 'bad',id: sourceId } },{ t: 'MESSAGE_DELETE_BULK',d: { guild_id: guild,channel_id: sourceChannel,ids: [] } }]) assert.equal(parseStarboardEvent(packet,guild),undefined);
});
test('reaction key compares Unicode presentation variants and stable custom emoji IDs', () => {
  assert.equal(reactionKey({ name: '❤️' }),reactionKey({ name: '❤' })); assert.equal(reactionKey({ id: sourceId,name: 'renamed' }),`c:${sourceId}`);
});
test('voter pagination is complete across normal and super types and excludes duplicates', async () => {
  const first = Array.from({ length: 100 },(_,index) => ({ id: String(310000000000000000n+BigInt(index)),bot: false })) as APIUser[];
  source!.reactions[0]!.burst = 1; const cursors: (string|undefined)[] = [];
  const count = await countReactionVotes(source!,'u:⭐',async (_emoji,type,after) => { cursors.push(after); return type === 1 ? [first[0]!] : after ? [{ id: author } as APIUser] : first; });
  assert.equal(count,100); assert.equal(cursors[1],first[99]!.id);
});
test('invalid voter responses or non-advancing cursors fail rather than miscounting', async () => {
  await assert.rejects(countReactionVotes(source!,'u:⭐',async () => [{ id: 'bad' }] as APIUser[]),/INVALID_REACTION_RESPONSE/);
  const repeat = Array(100).fill({ id: user1 }) as APIUser[];
  await assert.rejects(countReactionVotes(source!,'u:⭐',async () => repeat),/INVALID_REACTION_CURSOR/);
});
test('highlight payload preserves original link, suppresses mentions and does not expose spoiler attachments', () => {
  const entry = { marker: 'stable marker' } as StarboardPost;
  source!.content = '@everyone '+ 'x'.repeat(5000);
  source!.attachments = [{ name: 'SPOILER_secret.png',url: 'https://cdn.discordapp.com/secret.png',image: true,spoiler: true },
    { name: 'art.png',url: 'https://cdn.discordapp.com/art.png',image: true,spoiler: false }];
  const body = highlightBody(board(),source!,2,entry); assert.deepEqual(body.allowed_mentions,{ parse: [] }); assert.equal(body.enforce_nonce,true);
  assert.ok(body.embeds![0]!.description!.length <= 3000); assert.equal(body.embeds![0]!.image!.url,'https://cdn.discordapp.com/art.png');
  assert.ok(!JSON.stringify(body).includes('secret.png')); assert.match(JSON.stringify(body),new RegExp(`channels/${guild}/${sourceChannel}/${sourceId}`));
});
test('deterministic selection requires every participating board to allow sharing', () => {
  const choices = [board({ allow_crosspost: true }),board({ board_id: board2,allow_crosspost: false }),board({ board_id: 'third',allow_crosspost: true })];
  assert.deepEqual(chooseBoards(choices,source!,new Map([['u:⭐',3]])).map((b) => b.board_id),[boardId,'third']);
});

function wireMessage(id: string,channelId: string,marker: string,authorId = bot): APIMessage {
  return { id,channel_id: channelId,author: { id: authorId },embeds: [{ footer: { text: marker } }] } as APIMessage;
}
function runtimeAdapter(writer: Record<string,unknown>) {
  return starboardRuntimeDependencies({ user: { id: bot } } as Client,guild,'test-token',writer as unknown as Pick<REST,'post'|'patch'|'delete'|'get'>);
}
test('Discord adapter creates and edits only the expected bot-owned marked message', async () => {
  const entry = { destination_channel_id: destination,post_message_id: '800000000000000001',marker: 'identity' } as StarboardPost;
  const body = highlightBody(board(),source!,2,entry); const sent: unknown[] = [];
  const adapter = runtimeAdapter({
    post: async (route: string,options: { body: RESTPostAPIChannelMessageJSONBody; signal: AbortSignal }) => {
      sent.push({ route,options }); return wireMessage(entry.post_message_id!,destination,options.body.embeds![0]!.footer!.text);
    },patch: async (route: string,options: { body: Record<string,unknown>; signal: AbortSignal }) => {
      sent.push({ route,options }); assert.ok(!('nonce' in options.body)); assert.ok(!('enforce_nonce' in options.body)); return wireMessage(entry.post_message_id!,destination,entry.marker);
    },
  });
  assert.equal(await adapter.createPost(destination,body),entry.post_message_id); await adapter.editPost(entry,body);
  assert.equal(sent.length,2); assert.ok((sent[0] as { options: { signal: unknown } }).options.signal instanceof AbortSignal);
});
test('Discord adapter rejects an invalid or foreign create response instead of saving a guessed ID', async () => {
  const entry = { marker: 'identity' } as StarboardPost; const body = highlightBody(board(),source!,2,entry);
  for (const result of [{},wireMessage('800000000000000001',destination,'wrong marker'),wireMessage('800000000000000001',destination,'identity',author)]) {
    await assert.rejects(runtimeAdapter({ post: async () => result }).createPost(destination,body));
  }
});
test('Discord delete adapter accepts the actual empty-204 REST parser result', async () => {
  const { parseResponse } = await import('@discordjs/rest');
  const entry = { destination_channel_id: destination,post_message_id: '800000000000000001' } as StarboardPost;
  const adapter = runtimeAdapter({ delete: async () => parseResponse(new Response(null,{ status: 204 })) });
  await adapter.deletePost(entry);
});
test('Discord lookup treats explicit missing messages as absent and permission errors as unknown', async () => {
  const entry = { destination_channel_id: destination,post_message_id: '800000000000000001',marker: 'identity' } as StarboardPost;
  assert.equal(await runtimeAdapter({ get: async () => { throw { code: 10008 }; } }).inspectPost(entry),false);
  await assert.rejects(runtimeAdapter({ get: async () => { throw Object.assign(new Error('private permission diagnostic'),{ status: 403 }); } }).inspectPost(entry));
  await assert.rejects(runtimeAdapter({ get: async () => wireMessage(entry.post_message_id!,destination,entry.marker,author) }).inspectPost(entry),/POST_OWNERSHIP_MISMATCH/);
});
test('history recovery matches both bot ownership and generation marker', async () => {
  const entry = { destination_channel_id: destination,marker: 'stable identity',attempted_at: new Date() } as StarboardPost;
  const adapter = runtimeAdapter({ get: async () => [wireMessage('800000000000000001',destination,'stable identity',author),
    wireMessage('800000000000000002',destination,'other generation'),wireMessage('800000000000000003',destination,'stable identity')] });
  assert.equal(await adapter.findCreated(entry),'800000000000000003');
  assert.equal(await runtimeAdapter({ get: async () => [] }).findCreated(entry),null);
});
test('recovery never adopts a webhook message with a copied marker', async () => {
  const entry = { destination_channel_id: destination,marker: 'identity',attempted_at: new Date() } as StarboardPost;
  const webhook = { ...wireMessage('800000000000000001',destination,entry.marker),webhook_id: author };
  assert.equal(await runtimeAdapter({ get: async () => [webhook] }).findCreated(entry),null);
});
test('duplicate marked history or deleted destination requires safe reconciliation', async () => {
  const entry = { destination_channel_id: destination,marker: 'identity',attempted_at: new Date() } as StarboardPost;
  await assert.rejects(runtimeAdapter({ get: async () => [wireMessage('800000000000000001',destination,entry.marker),wireMessage('800000000000000002',destination,entry.marker)] }).findCreated(entry),/DUPLICATE_HIGHLIGHT_REVIEW/);
  await assert.rejects(runtimeAdapter({ get: async () => { throw { code: 10003 }; } }).findCreated(entry),/DESTINATION_DELETED/);
});
test('source adapter fetches fresh permissions and reaction metadata for an uncached message', async () => {
  const calls: unknown[] = [];
  const raw = { id: sourceId,channel_id: sourceChannel,author: { id: author,username: 'artist' },content: 'Work in progress',timestamp: new Date().toISOString(),attachments: [],
    reactions: [{ emoji: { name: '❤️',id: null },count: 3,count_details: { normal: 2,burst: 1 } }] };
  const chan = { type: 0,permissionsFor: () => ({ has: () => true }) };
  const fakeGuild = { roles: { fetch: async () => { calls.push('roles'); } },members: { fetchMe: async (o: unknown) => { calls.push(o); return {}; } },channels: { fetch: async () => chan } };
  const client = { user: { id: bot },guilds: { fetch: async (o: unknown) => { calls.push(o); return fakeGuild; } } } as unknown as Client;
  const writer = { get: async () => raw } as unknown as Pick<REST,'post'|'patch'|'delete'|'get'>;
  const result = await starboardRuntimeDependencies(client,guild,'test-token',writer).readSource(sourceChannel,sourceId);
  assert.equal(result!.content,'Work in progress'); assert.deepEqual(result!.reactions,[{ key: 'u:❤',apiEmoji: '❤️',normal: 2,burst: 1 }]);
  assert.deepEqual(calls,[{ guild,force: true },'roles',{ force: true }]);
});
test('raw reaction count requests use encoded emoji and explicit normal/super pagination parameters', async () => {
  const queries: URLSearchParams[] = []; const routes: string[] = [];
  source!.reactions[0]!.burst = 1;
  const adapter = runtimeAdapter({ get: async (route: string,options: { query: URLSearchParams }) => { routes.push(route); queries.push(options.query); return [{ id: user1 }]; } });
  assert.equal(await adapter.countVotes(source!,'u:⭐'),1);
  assert.ok(routes.every((route) => route.endsWith(encodeURIComponent('⭐')))); assert.deepEqual(queries.map((q) => q.get('type')),['0','1']);
  assert.ok(queries.every((q) => q.get('limit') === '100'));
});

test('a new delete event bypasses backoff from a lost create response', async () => {
  onCreate = async () => { await enqueue(true); }; createFailure = 'after'; await enqueue(); await work();
  onCreate = undefined; createFailure = undefined;
  assert.equal(await work(),true); assert.equal(posts.size,0); assert.equal(calls.create,1);
});
