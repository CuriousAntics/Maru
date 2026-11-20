import type { Pool } from 'pg';
import { customName } from './custom-commands.js';

export function inlineTriggers(content: string): string[] {
  // Mask URLs before matching so a path/query never invokes a response.
  const text = content.replace(/(?:https?:\/\/|www\.)\S+/giu, ' ');
  const pattern = /(?<![\p{L}\p{N}\p{M}_/:.\-])\/([a-z0-9_-]{1,32})(?![\p{L}\p{N}\p{M}_/\-])/giu;
  return [...new Set([...text.matchAll(pattern)].map(m => m[1]!.toLowerCase()).filter(customName))].slice(0,20);
}
export type InlineEvent = { messageId: string; channelId: string; userId: string; names: string[]; at: string };
const id = (v: unknown): v is string => typeof v === 'string' && /^\d{17,20}$/.test(v);
export function parseInlineEvent(packet: {t?: string | null; d: unknown},guildId: string,now=Date.now()): InlineEvent | null {
  if (packet.t !== 'MESSAGE_CREATE' || !packet.d || typeof packet.d !== 'object') return null;
  const d = packet.d as Record<string,any>, author = d.author;
  if (d.guild_id !== guildId || !id(d.id) || !id(d.channel_id) || !author || !id(author.id) || author.bot || d.webhook_id ||
      ![0,19].includes(d.type) || typeof d.content !== 'string' || d.content.length > 8000 || typeof d.timestamp !== 'string') return null;
  const at = Date.parse(d.timestamp);
  if (!Number.isFinite(at) || at < now-60000 || at > now+30000) return null;
  const names = inlineTriggers(d.content); if (!names.length) return null;
  return {messageId:d.id,channelId:d.channel_id,userId:author.id,names,at:new Date(at).toISOString()};
}
export async function enqueueInlineEvent(pool: Pick<Pool,'query'>,guildId: string,event: InlineEvent) {
  // Only the first enabled in-message trigger is selected, in source order. Source content is never stored.
  await pool.query(`INSERT INTO inline_command_jobs (guild_id,message_id,channel_id,user_id,command_name,revision,event_at)
    SELECT guild_id,$2,$3,$4,name,revision,$6::timestamptz FROM custom_commands
    WHERE guild_id=$1 AND name=ANY($5::text[]) AND enabled AND inline_enabled AND NOT deleted
      AND updated_at<=$6::timestamptz AND $6::timestamptz>=NOW()-INTERVAL '1 minute' AND $6::timestamptz<=NOW()+INTERVAL '30 seconds'
    ORDER BY array_position($5::text[],name) LIMIT 1 ON CONFLICT DO NOTHING`,
    [guildId,event.messageId,event.channelId,event.userId,event.names,event.at]);
}
export type InlineSource = { id: string; channelId: string; guildId: string; userId: string; content: string; bot: boolean; webhook: boolean };
export type InlineDependencies = {
  read: (channel: string,message: string) => Promise<InlineSource | null>;
  send: (channel: string,message: string,response: string) => Promise<string>;
};
type Job = {message_id:string;channel_id:string;user_id:string;command_name:string;revision:number;event_at:Date|string};
export async function processInlineCommand(pool: Pick<Pool,'connect'>,guildId: string,deps: InlineDependencies): Promise<boolean> {
  const db = await pool.connect(); let discard = false, job: Job | undefined;
  try {
    await db.query('BEGIN');
    await db.query(`UPDATE inline_command_jobs SET status='unconfirmed',note='Reply interrupted; not automatically replayed'
      WHERE guild_id=$1 AND status='sending' AND claimed_at<NOW()-INTERVAL '1 minute'`,[guildId]);
    job = (await db.query<Job>(`SELECT * FROM inline_command_jobs WHERE guild_id=$1 AND status='pending'
      ORDER BY created_at,message_id FOR UPDATE SKIP LOCKED LIMIT 1`,[guildId])).rows[0];
    if (!job) { await db.query('COMMIT'); return false; }
    const command = (await db.query<{revision:number;enabled:boolean;inline_enabled:boolean;deleted:boolean}>(
      'SELECT revision,enabled,inline_enabled,deleted FROM custom_commands WHERE guild_id=$1 AND name=$2 FOR UPDATE',[guildId,job.command_name])).rows[0];
    const fresh = new Date(job.event_at).getTime() >= Date.now()-60000;
    let skip = !fresh || !customName(job.command_name) || !command || !command.enabled || !command.inline_enabled || command.deleted || command.revision !== job.revision;
    if (!skip) skip = !(await db.query(`INSERT INTO inline_command_cooldowns (guild_id,user_id,claimed_at) VALUES ($1,$2,NOW())
      ON CONFLICT (guild_id,user_id) DO UPDATE SET claimed_at=NOW()
      WHERE inline_command_cooldowns.claimed_at<=NOW()-INTERVAL '5 seconds' RETURNING user_id`,[guildId,job.user_id])).rowCount;
    await db.query(`UPDATE inline_command_jobs SET status=$3,note=$4,claimed_at=NOW() WHERE guild_id=$1 AND message_id=$2`,
      [guildId,job.message_id,skip?'skipped':'sending',skip?'Changed, expired, disabled or on cooldown':'Reply claimed']);
    await db.query('COMMIT');
    if (skip) return true;
    let status = 'unconfirmed', note = 'Reply not confirmed; not automatically replayed', responseId: string | null = null;
    try {
      const source = await deps.read(job.channel_id,job.message_id);
      const current = (await db.query<{response:string}>(`SELECT response FROM custom_commands WHERE guild_id=$1 AND name=$2 AND revision=$3 AND enabled AND inline_enabled AND NOT deleted`,
        [guildId,job.command_name,job.revision])).rows[0];
      if (!source || source.id !== job.message_id || source.channelId !== job.channel_id || source.guildId !== guildId || source.userId !== job.user_id || source.bot || source.webhook ||
          !inlineTriggers(source.content).includes(job.command_name) || !current) {
        status='skipped'; note='Source missing or changed, or command disabled';
      } else {
        responseId = await deps.send(job.channel_id,job.message_id,current.response);
        if (!id(responseId)) throw new Error('INVALID_RESPONSE');
        status='sent'; note='Reply confirmed';
      }
    } catch { /* Never retry an uncertain send. */ }
    await db.query('UPDATE inline_command_jobs SET status=$3,note=$4,response_id=$5 WHERE guild_id=$1 AND message_id=$2',
      [guildId,job.message_id,status,note,responseId]);
    return true;
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { discard=true; }
    throw error;
  } finally { db.release(discard?new Error('Inline command connection unavailable'):undefined); }
}
export function startInlineCommandWorker(pool: Pick<Pool,'query'|'connect'>,guildId: string,deps: InlineDependencies,ready: () => boolean) {
  const pending = new Map<string,InlineEvent>(); let stopping=false,work:Promise<unknown>|undefined,nextCleanup=0;
  async function tick() {
    // Bounded intake and work; source text never survives the initial event parser.
    for (const event of [...pending.values()].slice(0,25)) { await enqueueInlineEvent(pool,guildId,event); if (pending.get(event.messageId)===event) pending.delete(event.messageId); }
    await processInlineCommand(pool,guildId,deps);
    if (Date.now()>=nextCleanup) {
      await pool.query("DELETE FROM inline_command_jobs WHERE guild_id=$1 AND status NOT IN ('pending','sending') AND created_at<NOW()-INTERVAL '1 day'",[guildId]);
      await pool.query("DELETE FROM inline_command_cooldowns WHERE guild_id=$1 AND claimed_at<NOW()-INTERVAL '1 day'",[guildId]);
      nextCleanup=Date.now()+3600000;
    }
  }
  const timer=setInterval(()=>{if(stopping || work || !ready())return;work=tick().catch(()=>console.error('In-message command work is waiting for saved events.')).finally(()=>{work=undefined;});},500);timer.unref();
  return {accept:(packet:{t?:string|null;d:unknown})=>{
    if(stopping)return;const event=parseInlineEvent(packet,guildId);if(!event)return;
    if(pending.size>=2000 && !pending.has(event.messageId)){console.error('In-message command intake is full.');return;}pending.set(event.messageId,event);
  },stop:async()=>{stopping=true;clearInterval(timer);await work;for(const event of pending.values())await enqueueInlineEvent(pool,guildId,event);pending.clear();}};
}
