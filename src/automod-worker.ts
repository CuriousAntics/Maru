import type { Pool } from 'pg';
import { readAutoModSettings, AutoModError } from './automod-settings.js';
import { matchBlockedWords } from './blocked-words.js';
import { processAutoModMessage } from './automod-engine.js';
import type { AutoModDependencies, AutoModJob } from './automod-engine.js';
type Database=Pick<Pool,'query'|'connect'>;
export type AutoModEvent={ messageId: string; channelId: string; content: string; eventAt: Date };
export function parseAutoModEvent(packet: { t?: string | null; d: unknown },guildId: string): AutoModEvent | undefined {
  if(!['MESSAGE_CREATE','MESSAGE_UPDATE'].includes(packet.t ?? '')) return;
  const data=packet.d as { guild_id?: string; id?: string; channel_id?: string; content?: unknown; author?: { bot?: boolean }; webhook_id?: string; timestamp?: string; edited_timestamp?: string | null } | null;
  if(!data || data.guild_id!==guildId || !/^\d{17,20}$/.test(data.id ?? '') || !/^\d{17,20}$/.test(data.channel_id ?? '') || typeof data.content!=='string' || data.content.length>10000 || data.author?.bot || data.webhook_id) return;
  const timestamp=packet.t==='MESSAGE_UPDATE' ? data.edited_timestamp ?? data.timestamp : data.timestamp;
  const eventAt=timestamp ? new Date(timestamp) : new Date();
  if (!Number.isFinite(eventAt.getTime())) return;
  return { messageId: data.id!,channelId: data.channel_id!,content: data.content,eventAt };
}
export async function enqueueAutoModCandidates(pool: Pick<Pool,'query'>,guildId: string,events: AutoModEvent[]): Promise<void> {
  const settings=await readAutoModSettings(pool,guildId); if(!settings.blocked_enabled) return;
  for(const event of events) if(matchBlockedWords(event.content,settings.blocked_words).length) {
    await pool.query(`INSERT INTO automod_jobs (guild_id,message_id,channel_id,event_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT (guild_id,message_id) DO UPDATE SET version=automod_jobs.version+1,event_at=EXCLUDED.event_at,available_at=NOW()`,[guildId,event.messageId,event.channelId,event.eventAt]);
  }
}
export async function processAutoModJob(pool: Database,guildId: string,deps: AutoModDependencies): Promise<boolean> {
  const client=await pool.connect(); let locked=false,discard=false; let job: AutoModJob | undefined;
  try {
    locked=(await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),731209) AS locked',[guildId])).rows[0]?.locked===true;
    if(!locked) return false;
    job=(await client.query<AutoModJob>('SELECT * FROM automod_jobs WHERE guild_id=$1 AND version>processed_version AND available_at<=NOW() ORDER BY event_at,message_id LIMIT 1',[guildId])).rows[0];
    if(!job) return false;
    await processAutoModMessage(client,job,deps);
    await client.query('UPDATE automod_jobs SET processed_version=$3,attempts=0,last_error=NULL WHERE guild_id=$1 AND message_id=$2',[guildId,job.message_id,job.version]); return true;
  } catch(error) {
    try { await client.query('ROLLBACK'); } catch { discard=true; }
    if(job && !discard) await client.query(`UPDATE automod_jobs SET attempts=attempts+1,last_error=$3,
      available_at=CASE WHEN version>$4 THEN NOW() ELSE NOW()+least(300,5*power(2,least(attempts,6)))*INTERVAL '1 second' END WHERE guild_id=$1 AND message_id=$2`,
      [guildId,job.message_id,error instanceof AutoModError?error.code:'CHECK_DISCORD_OR_DATABASE',job.version]);
    if(!job?.attempts) console.error('Automatic moderation work is pending after a permission, Discord, or database failure.'); return false;
  } finally {
    if(locked) { try { await client.query('ROLLBACK'); await client.query('SELECT pg_advisory_unlock_all()'); } catch { discard=true; } }
    client.release(discard?new Error('AutoMod worker connection unavailable.'):undefined);
  }
}
export function startAutoModWorker(pool: Database,guildId: string,deps: AutoModDependencies,isReady: () => boolean) {
  const pending=new Map<string,AutoModEvent>(); let stopping=false;
  let intake: Promise<void> | undefined,work: Promise<void> | undefined;
  async function flush() {
    const events=[...pending.values()].slice(0,100);
    if(!events.length) return;
    await enqueueAutoModCandidates(pool,guildId,events);
    for(const event of events) if(pending.get(event.messageId)===event) pending.delete(event.messageId);
  }
  function tick() {
    if(stopping || !isReady()) return;
    if(!intake && pending.size) {
      intake=flush().catch(() => { console.error('Automatic moderation intake will retry after a temporary failure.'); }).finally(() => { intake=undefined; });
    }
    if(!work) work=(async () => {
      const due=await pool.query('SELECT 1 FROM automod_jobs WHERE guild_id=$1 AND version>processed_version AND available_at<=NOW() LIMIT 1',[guildId]);
      if(!due.rowCount) return;
      for(let i=0;i<5 && !stopping && isReady();i++) if(!await processAutoModJob(pool,guildId,deps)) break;
    })().catch(() => { console.error('Automatic moderation worker will retry saved work.'); }).finally(() => { work=undefined; });
  }
  const timer=setInterval(tick,250); timer.unref();
  return {
    accept: (packet: { t?: string | null; d: unknown }) => {
      if(stopping) return; const event=parseAutoModEvent(packet,guildId); if(!event) return;
      if(pending.size>=5000 && !pending.has(event.messageId)) { console.error('Automatic moderation intake is full; a new message could not be queued.'); return; }
      pending.set(event.messageId,event);
    },
    stop: async () => { stopping=true; clearInterval(timer); await intake; while(pending.size) await flush(); await work; },
  };
}
