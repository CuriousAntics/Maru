import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AutoModSettings } from './automod-settings.js';
import type { AutoModDependencies,AutoModJob,AutoModMessage } from './automod-engine.js';
import { normalizeWords } from './blocked-words.js';
export function repeatedTextKey(text: string): string | null {
  const normalized=normalizeWords(text); return normalized?'text:'+createHash('sha256').update(normalized).digest('hex'):null;
}
async function fingerprints(source: AutoModMessage,settings: AutoModSettings,deps: AutoModDependencies) {
  const keys=new Set<string>(); let imageStatus='not_present';
  if(settings.repeat_text ?? true) { const text=repeatedTextKey(source.content); if(text) keys.add(text); }
  if((settings.repeat_images ?? true) && source.images?.length) {
    const result=deps.imageFingerprints?await deps.imageFingerprints(source):{ hashes: [],skipped: true };
    for(const hash of result.hashes) if(/^[a-f0-9]{64}$/.test(hash)) keys.add('image:'+hash);
    imageStatus=result.skipped?'partly_skipped':'checked';
  }
  return { keys: [...keys],imageStatus };
}
type Observation={ user_id: string; settings_revision: number; matched_keys: string[]; matched_entries: string[] };
export async function observeRepeatedMessage(client: PoolClient,job: AutoModJob,source: AutoModMessage,settings: AutoModSettings,deps: AutoModDependencies): Promise<void> {
  const at=new Date(job.created_at ?? job.event_at).getTime();
  if(job.repeat_revision!==settings.revision || source.id!==job.message_id || source.channelId!==job.channel_id || !Number.isFinite(at) || at<Date.now()-600000 || at>Date.now()+30000) return;
  if((await client.query('SELECT 1 FROM automod_repeat_activity WHERE guild_id=$1 AND message_id=$2',[job.guild_id,job.message_id])).rowCount) return;
  const { keys,imageStatus }=await fingerprints(source,settings,deps),matchedKeys: string[]=[],entries: string[]=[];
  for(const key of keys) {
    const count=(await client.query<{ n: number }>(`SELECT 1+count(*)::int AS n FROM automod_repeat_activity WHERE guild_id=$1 AND user_id=$2
      AND occurred_at>$3::timestamptz-$4::integer*INTERVAL '1 second' AND occurred_at<=$3::timestamptz AND settings_revision=$5 AND fingerprints @> ARRAY[$6]::text[]`,
      [job.guild_id,source.userId,job.created_at ?? job.event_at,settings.repeat_window_seconds ?? 30,settings.revision,key])).rows[0]!.n;
    if(count>=(settings.repeat_limit ?? 3)) { matchedKeys.push(key); entries.push(`${key.startsWith('image:')?'Identical image':'Repeated text'}: ${count} occurrences in ${settings.repeat_window_seconds ?? 30}s`); }
  }
  await client.query(`INSERT INTO automod_repeat_activity (guild_id,message_id,user_id,occurred_at,fingerprints,matched_keys,matched_entries,image_status,settings_revision)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (guild_id,message_id) DO NOTHING`,[job.guild_id,job.message_id,source.userId,job.created_at ?? job.event_at,keys,matchedKeys,entries,imageStatus,settings.revision]);
}
async function observation(client: PoolClient,job: AutoModJob,settings: AutoModSettings) {
  const row=(await client.query<Observation>('SELECT * FROM automod_repeat_activity WHERE guild_id=$1 AND message_id=$2',[job.guild_id,job.message_id])).rows[0];
  return row && row.settings_revision===settings.revision?row:undefined;
}
export async function repeatedDecision(client: PoolClient,job: AutoModJob,settings: AutoModSettings): Promise<string[]> {
  return (await observation(client,job,settings))?.matched_entries ?? [];
}
export async function repeatedMessageMatch(client: PoolClient,job: AutoModJob,source: AutoModMessage,settings: AutoModSettings,deps: AutoModDependencies): Promise<string[]> {
  const row=await observation(client,job,settings); if(!row || row.user_id!==source.userId) return [];
  if(source.repeatHistorical) return row.matched_entries;
  if(!row.matched_keys.length) return [];
  const current=await fingerprints(source,settings,deps);
  return row.matched_entries.filter((_,i) => current.keys.includes(row.matched_keys[i]!));
}
export async function readRepeatedSource(client: PoolClient,job: AutoModJob): Promise<AutoModMessage | undefined> {
  const row=(await client.query<{ user_id: string }>('SELECT user_id FROM automod_repeat_activity WHERE guild_id=$1 AND message_id=$2',[job.guild_id,job.message_id])).rows[0];
  return row?{ id: job.message_id,channelId: job.channel_id,userId: row.user_id,content: '',bot: false,webhook: false,repeatHistorical: true }:undefined;
}
