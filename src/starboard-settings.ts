import type { Pool } from 'pg';
import { getStaffAccess } from './staff-access.js';
import { digest } from './web-security.js';

export type StarboardChannel = { id: string; name: string; sourceUsable: boolean; destinationUsable: boolean };
export type StarboardEmoji = { id: string; name: string; animated: boolean; usable: boolean };
export type StarboardResources = { channels: StarboardChannel[]; emojis: StarboardEmoji[] };
export type BoardValues = {
  name: string; destination_channel_id: string; emoji: string; emoji_key: string;
  threshold: number; source_channel_ids: string[]; allow_crosspost: boolean; enabled: boolean;
};
export type StarboardBoard = BoardValues & {
  guild_id: string; board_id: string; enabled: boolean; revision: number;
  unconfirmed_posts?: number; posted_count?: number;
  created_by: string; updated_by: string; created_at: Date; updated_at: Date;
};
export class StarboardSettingsError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export const boardIdValid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const snowflake = (id: string) => /^\d{17,20}$/.test(id);
const unicodeEmoji = new RegExp('^(?:\\p{RGI_Emoji})$','v');

export function resolveBoardEmoji(text: string, emojis: StarboardEmoji[]): { emoji: string; emoji_key: string } {
  const input = text.trim().normalize('NFC');
  const custom = /^<(?:a)?:[A-Za-z0-9_]{2,32}:(\d{17,20})>$/.exec(input);
  const id = custom?.[1] ?? (snowflake(input) ? input : undefined);
  if (id) {
    const entry = emojis.find((emoji) => emoji.id === id && emoji.usable);
    if (!entry) throw new StarboardSettingsError('EMOJI_UNAVAILABLE');
    return { emoji: `<${entry.animated ? 'a' : ''}:${entry.name}:${entry.id}>`,emoji_key: `c:${entry.id}` };
  }
  if (input.length > 100 || !unicodeEmoji.test(input)) throw new StarboardSettingsError('INVALID_EMOJI');
  return { emoji: input,emoji_key: `u:${input.replace(/\uFE0F/g,'')}` };
}
export async function loadStarboards(pool: Pick<Pool,'query'>, guildId: string): Promise<StarboardBoard[]> {
  return (await pool.query<StarboardBoard>(`SELECT b.*, (SELECT count(*)::int FROM starboard_posts p WHERE p.guild_id=b.guild_id AND p.board_id=b.board_id AND p.state='creating') AS unconfirmed_posts,
    (SELECT count(*)::int FROM starboard_posts p WHERE p.guild_id=b.guild_id AND p.board_id=b.board_id AND p.state='posted') AS posted_count
    FROM starboard_boards b WHERE b.guild_id=$1 ORDER BY b.created_at,b.board_id`,[guildId])).rows;
}
export function boardSnapshot(board: BoardValues): BoardValues {
  return { name: board.name,destination_channel_id: board.destination_channel_id,emoji: board.emoji,emoji_key: board.emoji_key,
    threshold: board.threshold,source_channel_ids: [...board.source_channel_ids].sort(),allow_crosspost: board.allow_crosspost,enabled: board.enabled };
}
export async function saveStarboard(pool: Pick<Pool,'connect'>, input: {
  guildId: string; actorId: string; sessionToken: string; boardId: string; action: 'create' | 'save'; revision: number;
  name: string; destinationId: string; emoji: string; threshold: number; sourceIds: string[]; allowCrosspost: boolean; enabled?: boolean; reason: string;
  readMemberRoles: (userId: string) => Promise<string[] | null>;
  readResources: () => Promise<StarboardResources>;
}): Promise<'changed' | 'unchanged'> {
  if (![input.guildId,input.actorId,input.destinationId].every(snowflake) || !boardIdValid(input.boardId) ||
      !['create','save'].includes(input.action) || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision > 2147483647 ||
      (input.action === 'create' && input.revision !== 0) || typeof input.allowCrosspost !== 'boolean' || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw new StarboardSettingsError('INVALID_INPUT');
  const name = input.name.trim(), reason = input.reason.trim();
  if (!name || name.length > 60) throw new StarboardSettingsError('INVALID_NAME');
  if (!reason || reason.length > 500) throw new StarboardSettingsError('INVALID_REASON');
  if (!Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > 1000) throw new StarboardSettingsError('INVALID_THRESHOLD');
  if (!Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 100 ||
      !input.sourceIds.every(snowflake) || new Set(input.sourceIds).size !== input.sourceIds.length || input.sourceIds.includes(input.destinationId)) {
    throw new StarboardSettingsError('INVALID_SOURCES');
  }
  const client = await pool.connect(); let transaction = false, discard = false, locked = false;
  try {
    locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),731208) AS locked',[input.guildId])).rows[0]?.locked === true;
    if (!locked) throw new StarboardSettingsError('WORKER_BUSY');
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SET LOCAL statement_timeout='15s'");
    const guild = await client.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[input.guildId]);
    if (!guild.rowCount) throw new StarboardSettingsError('SERVER_NOT_CONFIGURED');
    const session = await client.query(`SELECT user_id FROM dashboard_sessions WHERE token_hash=$1 AND guild_id=$2 AND user_id=$3 AND expires_at>NOW()`,
      [digest(input.sessionToken),input.guildId,input.actorId]);
    if (!session.rowCount) throw new StarboardSettingsError('SESSION_EXPIRED');
    const roles = await input.readMemberRoles(input.actorId);
    if (!roles || await getStaffAccess(client,input.guildId,input.actorId,roles) === 'none') throw new StarboardSettingsError('STAFF_REQUIRED');
    const existing = (await client.query<StarboardBoard>('SELECT * FROM starboard_boards WHERE guild_id=$1 AND board_id=$2 FOR UPDATE',[input.guildId,input.boardId])).rows[0];
    if (input.action === 'save' && !existing) throw new StarboardSettingsError('BOARD_NOT_FOUND');
    if (existing && existing.revision !== input.revision) throw new StarboardSettingsError('STALE_BOARD');
    // An authorized staff member can switch posting off without repairing unavailable channels first.
    const pauseOnly = existing?.enabled && input.enabled === false && name === existing.name &&
      input.destinationId === existing.destination_channel_id && input.emoji.trim() === existing.emoji &&
      input.threshold === existing.threshold && input.allowCrosspost === existing.allow_crosspost &&
      JSON.stringify([...input.sourceIds].sort()) === JSON.stringify([...existing.source_channel_ids].sort());
    let emoji: { emoji: string; emoji_key: string };
    if (pauseOnly) emoji = { emoji: existing.emoji,emoji_key: existing.emoji_key };
    else {
      const resources = await input.readResources();
      if (!resources.channels.some((channel) => channel.id === input.destinationId && channel.destinationUsable) ||
          input.sourceIds.some((id) => !resources.channels.some((channel) => channel.id === id && channel.sourceUsable))) {
        throw new StarboardSettingsError('CHANNEL_UNAVAILABLE');
      }
      emoji = resolveBoardEmoji(input.emoji,resources.emojis);
    }
    const values: BoardValues = { name,destination_channel_id: input.destinationId,...emoji,
      threshold: input.threshold,source_channel_ids: [...input.sourceIds].sort(),allow_crosspost: input.allowCrosspost,enabled: input.enabled ?? false };
    if (existing && JSON.stringify(boardSnapshot(existing)) === JSON.stringify(boardSnapshot(values))) {
      await client.query('COMMIT'); transaction = false; return 'unchanged';
    }
    if (input.action === 'create' && existing) throw new StarboardSettingsError('STALE_BOARD');
    const duplicate = await client.query('SELECT board_id FROM starboard_boards WHERE guild_id=$1 AND lower(name)=lower($2) AND board_id<>$3',
      [input.guildId,name,input.boardId]);
    if (duplicate.rowCount) throw new StarboardSettingsError('DUPLICATE_NAME');
    if (!existing) {
      const count = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM starboard_boards WHERE guild_id=$1',[input.guildId]);
      if (count.rows[0]!.count >= 25) throw new StarboardSettingsError('BOARD_LIMIT');
      await client.query(`INSERT INTO starboard_boards
        (guild_id,board_id,name,destination_channel_id,emoji,emoji_key,threshold,source_channel_ids,allow_crosspost,enabled,created_by,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$11,$10,$10)`,
        [input.guildId,input.boardId,values.name,values.destination_channel_id,values.emoji,values.emoji_key,values.threshold,values.source_channel_ids,values.allow_crosspost,input.actorId,values.enabled]);
    } else {
      await client.query(`UPDATE starboard_boards SET name=$3,destination_channel_id=$4,emoji=$5,emoji_key=$6,threshold=$7,
        source_channel_ids=$8,allow_crosspost=$9,enabled=$11,updated_by=$10,updated_at=NOW(),revision=revision+1 WHERE guild_id=$1 AND board_id=$2`,
        [input.guildId,input.boardId,values.name,values.destination_channel_id,values.emoji,values.emoji_key,values.threshold,values.source_channel_ids,values.allow_crosspost,input.actorId,values.enabled]);
    }
    await client.query('INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)',
      [input.guildId,input.actorId,existing ? 'STARBOARD_UPDATED' : 'STARBOARD_CREATED',JSON.stringify({ board_id: input.boardId,reason,
        before: existing ? boardSnapshot(existing) : null,after: boardSnapshot(values),revision: existing ? existing.revision+1 : 0 })]);
    // Reconcile all observed messages on a configuration change; never scan/import old channel history.
    await client.query('UPDATE starboard_jobs SET version=version+1,available_at=NOW() WHERE guild_id=$1 AND NOT source_deleted',[input.guildId]);
    await client.query('COMMIT'); transaction = false; return 'changed';
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
    throw error;
  } finally {
    if (locked) { try { await client.query('SELECT pg_advisory_unlock(hashtext($1),731208)',[input.guildId]); } catch { discard = true; } }
    client.release(discard ? new Error('Starboard settings connection could not be released safely.') : undefined);
  }
}
