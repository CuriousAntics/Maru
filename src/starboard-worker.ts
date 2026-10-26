import type { Pool } from 'pg';
import { reconcileStarboard, runtimeCode } from './starboard-engine.js';
import type { StarboardDependencies, StarboardJob } from './starboard-engine.js';

type Database = Pick<Pool,'query'|'connect'>;
export type StarboardEvent = { guildId: string; channelId: string; messageIds: string[]; deleted: boolean; emojiKey?: string };
const idValid = (id: unknown): id is string => typeof id === 'string' && /^\d{17,20}$/.test(id);
export function parseStarboardEvent(packet: { t?: string | null; d: unknown },guildId: string): StarboardEvent | undefined {
  if (!['MESSAGE_REACTION_ADD','MESSAGE_REACTION_REMOVE','MESSAGE_REACTION_REMOVE_ALL','MESSAGE_REACTION_REMOVE_EMOJI','MESSAGE_DELETE','MESSAGE_DELETE_BULK','MESSAGE_UPDATE'].includes(packet.t ?? '')) return;
  const data = packet.d as Record<string,unknown> | null;
  if (!data || data.guild_id !== guildId || !idValid(data.channel_id)) return;
  const messageIds = packet.t === 'MESSAGE_DELETE_BULK' ? data.ids : [data.message_id ?? data.id];
  if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 100 || !messageIds.every(idValid)) return;
  const emoji = data.emoji as { id?: string; name?: string } | undefined;
  const emojiKey = emoji ? emoji.id ? `c:${emoji.id}` : typeof emoji.name === 'string' ? `u:${emoji.name.normalize('NFC').replace(/\uFE0F/g,'')}` : undefined : undefined;
  return { guildId,channelId: data.channel_id,messageIds: [...new Set(messageIds)],deleted: packet.t === 'MESSAGE_DELETE' || packet.t === 'MESSAGE_DELETE_BULK',emojiKey };
}
export async function enqueueStarboardEvent(pool: Pick<Pool,'query'>,event: StarboardEvent): Promise<void> {
  const { guildId,channelId,messageIds,deleted,emojiKey } = event;
  if (![guildId,channelId,...messageIds].every(idValid)) return;
  await pool.query(`INSERT INTO starboard_jobs (guild_id,source_channel_id,source_message_id,source_deleted)
    SELECT $1,$2,id,$4 FROM unnest($3::text[]) id
    WHERE EXISTS (SELECT 1 FROM starboard_boards b WHERE b.guild_id=$1 AND b.enabled AND $2=ANY(b.source_channel_ids)
      AND ($5::text IS NULL OR b.emoji_key=$5))
      OR EXISTS (SELECT 1 FROM starboard_posts p WHERE p.guild_id=$1 AND p.source_message_id=id)
    ON CONFLICT (guild_id,source_message_id) DO UPDATE SET version=starboard_jobs.version+1,available_at=NOW(),
      source_deleted=starboard_jobs.source_deleted OR EXCLUDED.source_deleted`,[guildId,channelId,messageIds,deleted,emojiKey ?? null]);
  if (deleted) await pool.query(`INSERT INTO starboard_jobs (guild_id,source_channel_id,source_message_id)
    SELECT DISTINCT guild_id,source_channel_id,source_message_id FROM starboard_posts
    WHERE guild_id=$1 AND destination_channel_id=$2 AND post_message_id=ANY($3::text[])
    ON CONFLICT (guild_id,source_message_id) DO UPDATE SET version=starboard_jobs.version+1,available_at=NOW()`,[guildId,channelId,messageIds]);
}
export async function sweepStarboards(pool: Pick<Pool,'query'>,guildId: string): Promise<void> {
  await pool.query(`UPDATE starboard_jobs SET version=version+1,available_at=NOW(),checked_at=NOW()
    WHERE guild_id=$1 AND source_message_id IN (SELECT source_message_id FROM starboard_jobs
      WHERE guild_id=$1 AND version=processed_version AND NOT source_deleted AND checked_at<NOW()-INTERVAL '10 minutes'
      ORDER BY checked_at LIMIT 25)`,[guildId]);
}
export async function processStarboardJob(pool: Database,guildId: string,deps: StarboardDependencies): Promise<boolean> {
  const client = await pool.connect(); let locked = false,discard = false;
  let job: StarboardJob | undefined;
  try {
    locked = (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),731208) AS locked',[guildId])).rows[0]?.locked === true;
    if (!locked) return false;
    job = (await client.query<StarboardJob>(`SELECT * FROM starboard_jobs WHERE guild_id=$1 AND version>processed_version AND available_at<=NOW()
      ORDER BY available_at,source_message_id LIMIT 1`,[guildId])).rows[0];
    if (!job) return false;
    await reconcileStarboard(client,job,deps);
    await client.query(`UPDATE starboard_jobs SET processed_version=$3,attempts=0,last_error=NULL,checked_at=NOW()
      WHERE guild_id=$1 AND source_message_id=$2`,[guildId,job.source_message_id,job.version]);
    return true;
  } catch (error) {
    // Persist only known codes, never source text, token-bearing URLs or provider error details.
    try { await client.query('ROLLBACK'); } catch { discard = true; }
    if (job && !discard) {
      const code = runtimeCode(error);
      await client.query(`UPDATE starboard_jobs SET attempts=attempts+1,last_error=$3,checked_at=NOW(),
        available_at=CASE WHEN version>$4 THEN NOW() ELSE NOW()+least(300,5*power(2,least(attempts,6))) * INTERVAL '1 second' END
        WHERE guild_id=$1 AND source_message_id=$2`,[guildId,job.source_message_id,code,job.version]);
      await client.query(`UPDATE starboard_posts SET last_error=$3 WHERE guild_id=$1 AND source_message_id=$2 AND state<>'absent'`,[guildId,job.source_message_id,code]);
      if (!job.attempts) console.error(`Starboard work deferred: ${code}. Saved work will be checked again.`);
    } else if (!job) console.error('Starboard queue is temporarily unavailable.');
    return false;
  } finally {
    if (locked) {
      try { await client.query('ROLLBACK'); await client.query('SELECT pg_advisory_unlock(hashtext($1),731208)',[guildId]); }
      catch { discard = true; }
    }
    client.release(discard ? new Error('Starboard connection could not release its lock safely.') : undefined);
  }
}
export function startStarboardWorker(pool: Database,guildId: string,deps: StarboardDependencies,isReady: () => boolean) {
  let stopping = false,lastSweep = 0;
  let running: Promise<void> | undefined;
  async function tick() {
    if (stopping || running || !isReady()) return;
    running = (async () => {
      if (Date.now()-lastSweep >= 60000) { await sweepStarboards(pool,guildId); lastSweep = Date.now(); }
      for (let count = 0; count < 5 && !stopping && isReady(); count++) if (!await processStarboardJob(pool,guildId,deps)) break;
    })();
    try { await running; } catch { console.error('Starboard worker will retry saved work after a temporary failure.'); }
    finally { running = undefined; }
  }
  const timer = setInterval(() => { void tick(); },2000); timer.unref();
  return { stop: async () => { stopping = true; clearInterval(timer); await running; } };
}
