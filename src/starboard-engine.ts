import type { PoolClient } from 'pg';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { escapeMarkdown } from 'discord.js';
import { digest } from './web-security.js';
import type { StarboardBoard } from './starboard-settings.js';

export type StarboardSource = {
  id: string; channelId: string; authorId: string; authorName: string; content: string; timestamp: string;
  attachments: { name: string; url: string; image: boolean; spoiler: boolean }[];
  reactions: { key: string; apiEmoji: string; normal: number; burst: number }[];
};
export type StarboardPost = {
  guild_id: string; board_id: string; source_channel_id: string; source_message_id: string;
  destination_channel_id: string; post_message_id: string | null; state: 'absent' | 'creating' | 'posted' | 'deleting';
  generation: number; marker: string; body_hash: string | null; attempted_at: Date;
};
export type StarboardJob = { guild_id: string; source_channel_id: string; source_message_id: string; source_deleted: boolean; version: string; attempts: number };
export type StarboardDependencies = {
  botId: () => string;
  readSource: (channelId: string,messageId: string) => Promise<StarboardSource | null>;
  countVotes: (source: StarboardSource,emojiKey: string) => Promise<number>;
  validateDestination: (sourceChannelId: string,destinationId: string) => Promise<void>;
  inspectPost: (entry: StarboardPost) => Promise<boolean>;
  findCreated: (entry: StarboardPost) => Promise<string | null>;
  createPost: (channelId: string,body: RESTPostAPIChannelMessageJSONBody) => Promise<string>;
  editPost: (entry: StarboardPost,body: RESTPostAPIChannelMessageJSONBody) => Promise<void>;
  deletePost: (entry: StarboardPost) => Promise<void>;
};
export class StarboardRuntimeError extends Error { constructor(public readonly code: string) { super(code); } }
export const isDiscordMissing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && [10008,10003].includes(Number(error.code));
const isRejection = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && [400,401,403,404].includes(Number(error.status));
export const runtimeCode = (error: unknown): string => error instanceof StarboardRuntimeError ? error.code : 'DISCORD_OR_DATABASE_UNAVAILABLE';
export function chooseBoards(boards: StarboardBoard[],source: StarboardSource,counts: Map<string,number>): StarboardBoard[] {
  const eligible = boards.filter((board) => !board.deleted_at && board.enabled && board.source_channel_ids.includes(source.channelId) &&
    board.destination_channel_id !== source.channelId && (counts.get(board.emoji_key) ?? 0) >= board.threshold);
  const chosen: StarboardBoard[] = [];
  for (const board of eligible) if (!chosen.length || (board.allow_crosspost && chosen.every((entry) => entry.allow_crosspost))) chosen.push(board);
  return chosen;
}
export function highlightBody(board: StarboardBoard,source: StarboardSource,count: number,entry: StarboardPost): RESTPostAPIChannelMessageJSONBody {
  const link = `https://discord.com/channels/${board.guild_id}/${source.channelId}/${source.id}`;
  const safeURL = (value: string) => { try { return new URL(value).protocol === 'https:' && value.length <= 500; } catch { return false; } };
  const attachments = source.attachments.filter((file) => !file.spoiler && safeURL(file.url));
  const links = attachments.slice(0,3).map((file) => `[${escapeMarkdown(file.name).slice(0,80)}](${file.url.replace(/\(/g,'%28').replace(/\)/g,'%29')})`).join('\n').slice(0,1000);
  return { content: `${board.emoji} **${count}** · <#${source.channelId}>`,allowed_mentions: { parse: [] },
    nonce: digest(entry.marker).slice(0,25),enforce_nonce: true,
    embeds: [{ title: board.name,author: { name: source.authorName.slice(0,256) },
      description: source.content.slice(0,3000) || 'Open the original message to view this post.',
      fields: [{ name: 'Original message',value: `[Jump to message](${link})` },...(links ? [{ name: 'Attachments',value: links }] : [])],
      ...(attachments.find((file) => file.image) ? { image: { url: attachments.find((file) => file.image)!.url } } : {}),
      footer: { text: entry.marker },timestamp: source.timestamp,color: 0xe6ad73 }] };
}

// Caller owns the shared Starboard session lock. Every external create has a committed intent first.
export async function reconcileStarboard(client: PoolClient,job: StarboardJob,deps: StarboardDependencies): Promise<void> {
  const guildId = job.guild_id;
  const boards = (await client.query<StarboardBoard>('SELECT * FROM starboard_boards WHERE guild_id=$1 ORDER BY created_at,board_id',[guildId])).rows;
  const entries = (await client.query<StarboardPost>('SELECT * FROM starboard_posts WHERE guild_id=$1 AND source_message_id=$2',[guildId,job.source_message_id])).rows.filter((entry) => {
    const board = boards.find((candidate) => candidate.board_id === entry.board_id);
    return !board?.deleted_at || board.delete_remove_highlights;
  });
  const map = new Map(entries.map((entry) => [entry.board_id,entry]));
  async function auditState(entry: StarboardPost,state: StarboardPost['state'],event: string,postId: string | null,hash: string | null = null) {
    let transaction = false;
    try {
      await client.query('BEGIN'); transaction = true;
      await client.query(`UPDATE starboard_posts SET state=$4,post_message_id=$5,body_hash=$6,last_error=NULL,updated_at=NOW()
        WHERE guild_id=$1 AND board_id=$2 AND source_message_id=$3`,[guildId,entry.board_id,job.source_message_id,state,postId,hash]);
      await client.query('INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)',
        [guildId,deps.botId(),event,JSON.stringify({ board_id: entry.board_id,source_message_id: job.source_message_id,
          channel_id: entry.destination_channel_id,message_id: postId,generation: entry.generation,reason: 'Starboard worker recorded a managed highlight transition.' })]);
      await client.query('COMMIT'); transaction = false;
    } catch (error) { if (transaction) await client.query('ROLLBACK'); throw error; }
    entry.state = state; entry.post_message_id = postId; entry.body_hash = hash;
  }
  // Recover an uncertain create through a bot-owned marker, never by issuing another POST.
  async function recover(entry: StarboardPost) {
    if (entry.state !== 'creating') return;
    let id: string | null;
    try { id = await deps.findCreated(entry); }
    catch (error) {
      if (error instanceof StarboardRuntimeError && error.code === 'DESTINATION_DELETED') {
        await auditState(entry,'absent','STARBOARD_DESTINATION_REMOVED',null); return;
      }
      throw error;
    }
    if (!id) throw new StarboardRuntimeError('DELIVERY_UNCONFIRMED');
    if (!/^\d{17,20}$/.test(id)) throw new StarboardRuntimeError('INVALID_RECOVERY_RESPONSE');
    await auditState(entry,'posted','STARBOARD_POST_RECOVERED',id);
  }
  async function remove(entry: StarboardPost) {
    await recover(entry);
    if (entry.state === 'absent') return;
    if (entry.state !== 'deleting') await auditState(entry,'deleting','STARBOARD_DELETE_REQUESTED',entry.post_message_id);
    if (await deps.inspectPost(entry)) await deps.deletePost(entry);
    await auditState(entry,'absent','STARBOARD_POST_REMOVED',null);
  }
  // Explicit board cleanup does not require access to the original source channel.
  for (const entry of entries) {
    const board = boards.find((candidate) => candidate.board_id === entry.board_id);
    if (board?.deleted_at && board.delete_remove_highlights) await remove(entry);
  }
  const shouldReadSource = !job.source_deleted && boards.some((board) => !board.deleted_at && board.enabled && board.source_channel_ids.includes(job.source_channel_id));
  let source = shouldReadSource ? await deps.readSource(job.source_channel_id,job.source_message_id) : null;
  if (source && (source.id !== job.source_message_id || source.channelId !== job.source_channel_id)) throw new StarboardRuntimeError('INVALID_SOURCE_RESPONSE');
  if (shouldReadSource && !source) await client.query('UPDATE starboard_jobs SET source_deleted=TRUE WHERE guild_id=$1 AND source_message_id=$2',[guildId,job.source_message_id]);
  const counts = new Map<string,number>();
  if (source && source.authorId !== deps.botId()) {
    for (const board of boards) if (!board.deleted_at && board.enabled && board.source_channel_ids.includes(source.channelId) && !counts.has(board.emoji_key)) {
      const count = await deps.countVotes(source,board.emoji_key);
      if (!Number.isSafeInteger(count) || count < 0 || count > 100000) throw new StarboardRuntimeError('INVALID_REACTION_COUNT');
      counts.set(board.emoji_key,count);
    }
  } else source = null;
  const chosen = source ? chooseBoards(boards,source,counts) : [];
  for (const entry of entries) await recover(entry);
  // Confirm removals before adding any competing board or changing a destination.
  for (const entry of entries) {
    const wanted = chosen.find((board) => board.board_id === entry.board_id);
    if (entry.state === 'absent') continue;
    if (!wanted || wanted.destination_channel_id !== entry.destination_channel_id || entry.state === 'deleting') {
      await remove(entry);
    }
  }
  if (!source) return;
  for (const board of chosen) {
    let entry = map.get(board.board_id);
    if (entry?.state === 'posted' && !await deps.inspectPost(entry)) await auditState(entry,'absent','STARBOARD_POST_MISSING',null);
    if (!entry || entry.state === 'absent') {
      const generation = entry ? entry.generation+1 : 1;
      const marker = `Maru · Starboard ${board.board_id} · ${source.id} · ${generation}`;
      let transaction = false;
      try {
        await client.query('BEGIN'); transaction = true;
        const result = await client.query<StarboardPost>(`INSERT INTO starboard_posts
          (guild_id,board_id,source_channel_id,source_message_id,destination_channel_id,state,generation,marker)
          VALUES ($1,$2,$3,$4,$5,'creating',$6,$7) ON CONFLICT (guild_id,board_id,source_message_id)
          DO UPDATE SET destination_channel_id=EXCLUDED.destination_channel_id,state='creating',generation=EXCLUDED.generation,
          marker=EXCLUDED.marker,post_message_id=NULL,body_hash=NULL,last_error=NULL,attempted_at=NOW(),updated_at=NOW() RETURNING *`,
          [guildId,board.board_id,source.channelId,source.id,board.destination_channel_id,generation,marker]);
        entry = result.rows[0]!; map.set(board.board_id,entry);
        await client.query('INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,\'STARBOARD_CREATE_REQUESTED\',$3::jsonb)',
          [guildId,deps.botId(),JSON.stringify({ board_id: board.board_id,source_message_id: source.id,channel_id: board.destination_channel_id,
            generation,reason: 'Persisted Starboard create intent before Discord dispatch.' })]);
        await client.query('COMMIT'); transaction = false;
      } catch (error) { if (transaction) await client.query('ROLLBACK'); throw error; }
      const body = highlightBody(board,source,counts.get(board.emoji_key)!,entry);
      try {
        await deps.validateDestination(source.channelId,entry.destination_channel_id);
      } catch (error) {
        await auditState(entry,'absent','STARBOARD_CREATE_BLOCKED',null); throw error;
      }
      let id: string;
      try { id = await deps.createPost(entry.destination_channel_id,body); }
      catch (error) {
        if (isRejection(error)) await auditState(entry,'absent','STARBOARD_CREATE_REJECTED',null);
        throw error;
      }
      if (!/^\d{17,20}$/.test(id)) throw new StarboardRuntimeError('INVALID_CREATE_RESPONSE');
      await auditState(entry,'posted','STARBOARD_POST_CREATED',id,digest(JSON.stringify(body)));
    } else {
      const body = highlightBody(board,source,counts.get(board.emoji_key)!,entry);
      const hash = digest(JSON.stringify(body));
      if (entry.body_hash !== hash) {
        await deps.validateDestination(source.channelId,entry.destination_channel_id);
        await deps.editPost(entry,body);
        await client.query('UPDATE starboard_posts SET body_hash=$4,last_error=NULL,updated_at=NOW() WHERE guild_id=$1 AND board_id=$2 AND source_message_id=$3',
          [guildId,board.board_id,source.id,hash]);
      }
    }
  }
}
