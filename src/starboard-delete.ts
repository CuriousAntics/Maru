import type { Pool } from 'pg';
import { getStaffAccess } from './staff-access.js';
import { digest } from './web-security.js';
import { boardIdValid, boardSnapshot, StarboardSettingsError } from './starboard-settings.js';
import type { StarboardBoard } from './starboard-settings.js';

export type PendingBoardDeletion = { board_id: string; name: string; pending_count: number; uncertain_count: number };
export async function loadBoardDeletions(pool: Pick<Pool,'query'>,guildId: string): Promise<PendingBoardDeletion[]> {
  return (await pool.query<PendingBoardDeletion>(`SELECT b.board_id,b.name,count(*)::int AS pending_count,
    count(*) FILTER (WHERE p.state='creating')::int AS uncertain_count
    FROM starboard_boards b JOIN starboard_posts p ON p.guild_id=b.guild_id AND p.board_id=b.board_id
    WHERE b.guild_id=$1 AND b.deleted_at IS NOT NULL AND b.delete_remove_highlights AND p.state<>'absent'
    GROUP BY b.board_id,b.name ORDER BY b.name`,[guildId])).rows;
}
export async function deleteStarboard(pool: Pick<Pool,'connect'>,input: {
  guildId: string; actorId: string; sessionToken: string; boardId: string; revision: number;
  confirmation: string; removeHighlights: boolean; reason: string;
  readMemberRoles: (id: string) => Promise<string[] | null>;
}): Promise<'changed'|'unchanged'> {
  if (![input.guildId,input.actorId].every((id) => /^\d{17,20}$/.test(id)) || !boardIdValid(input.boardId) ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision > 2147483647 || typeof input.removeHighlights !== 'boolean') {
    throw new StarboardSettingsError('INVALID_INPUT');
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new StarboardSettingsError('INVALID_REASON');
  const client = await pool.connect(); let locked = false,transaction = false,discard = false;
  try {
    locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),731208) AS locked',[input.guildId])).rows[0]?.locked === true;
    if (!locked) throw new StarboardSettingsError('WORKER_BUSY');
    await client.query('BEGIN'); transaction = true;
    await client.query("SET LOCAL lock_timeout='5s'"); await client.query("SET LOCAL statement_timeout='15s'");
    if (!(await client.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[input.guildId])).rowCount) throw new StarboardSettingsError('SERVER_NOT_CONFIGURED');
    if (!(await client.query('SELECT user_id FROM dashboard_sessions WHERE token_hash=$1 AND guild_id=$2 AND user_id=$3 AND expires_at>NOW()',
      [digest(input.sessionToken),input.guildId,input.actorId])).rowCount) throw new StarboardSettingsError('SESSION_EXPIRED');
    const roles = await input.readMemberRoles(input.actorId);
    if (!roles || await getStaffAccess(client,input.guildId,input.actorId,roles) === 'none') throw new StarboardSettingsError('STAFF_REQUIRED');
    const board = (await client.query<StarboardBoard>('SELECT * FROM starboard_boards WHERE guild_id=$1 AND board_id=$2 FOR UPDATE',[input.guildId,input.boardId])).rows[0];
    if (!board) throw new StarboardSettingsError('BOARD_NOT_FOUND');
    if (input.confirmation.trim() !== board.name) throw new StarboardSettingsError('CONFIRM_REQUIRED');
    if (board.deleted_at) {
      if (board.revision !== input.revision+1 || board.deleted_by !== input.actorId || board.delete_reason !== reason || board.delete_remove_highlights !== input.removeHighlights) throw new StarboardSettingsError('STALE_BOARD');
      await client.query('COMMIT'); transaction = false; return 'unchanged';
    }
    if (board.revision !== input.revision) throw new StarboardSettingsError('STALE_BOARD');
    const counts = (await client.query<{ known: number; uncertain: number }>(`SELECT count(*) FILTER (WHERE post_message_id IS NOT NULL)::int AS known,
      count(*) FILTER (WHERE state='creating')::int AS uncertain FROM starboard_posts WHERE guild_id=$1 AND board_id=$2 AND state<>'absent'`,[input.guildId,input.boardId])).rows[0]!;
    await client.query(`UPDATE starboard_boards SET enabled=FALSE,deleted_at=NOW(),deleted_by=$3,delete_reason=$4,
      delete_remove_highlights=$5,updated_by=$3,updated_at=NOW(),revision=revision+1 WHERE guild_id=$1 AND board_id=$2`,
      [input.guildId,input.boardId,input.actorId,reason,input.removeHighlights]);
    if (!input.removeHighlights) {
      // Clear live ownership so even the prior worker version cannot later delete retained snapshots.
      await client.query(`UPDATE starboard_posts SET retained_post_message_id=coalesce(post_message_id,retained_post_message_id),
        post_message_id=NULL,state='absent',body_hash=NULL,last_error=NULL,updated_at=NOW() WHERE guild_id=$1 AND board_id=$2`,[input.guildId,input.boardId]);
    }
    await client.query('INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,\'STARBOARD_DELETED\',$3::jsonb)',
      [input.guildId,input.actorId,JSON.stringify({ board_id: input.boardId,reason,before: boardSnapshot(board),revision: board.revision+1,
        remove_highlights: input.removeHighlights,known_highlights: counts.known,uncertain_highlights: counts.uncertain })]);
    // Reevaluate competing boards and ensure cleanup is queued even for deleted original sources.
    await client.query(`INSERT INTO starboard_jobs (guild_id,source_channel_id,source_message_id)
      SELECT guild_id,source_channel_id,source_message_id FROM starboard_posts WHERE guild_id=$1 AND board_id=$2
      ON CONFLICT (guild_id,source_message_id) DO UPDATE SET version=starboard_jobs.version+1,available_at=NOW()`,[input.guildId,input.boardId]);
    await client.query('UPDATE starboard_jobs SET version=version+1,available_at=NOW() WHERE guild_id=$1 AND NOT source_deleted',[input.guildId]);
    await client.query('COMMIT'); transaction = false; return 'changed';
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
    throw error;
  } finally {
    if (locked) { try { await client.query('SELECT pg_advisory_unlock(hashtext($1),731208)',[input.guildId]); } catch { discard = true; } }
    client.release(discard ? new Error('Starboard delete connection could not be released safely.') : undefined);
  }
}
