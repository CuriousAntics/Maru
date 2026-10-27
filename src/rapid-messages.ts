import type { PoolClient } from 'pg';
import type { AutoModJob, AutoModMessage } from './automod-engine.js';
import type { AutoModSettings } from './automod-settings.js';
// Only eligible human MESSAGE_CREATE events enter this table. No source content is retained.
export async function observeRapidMessage(client: PoolClient,job: AutoModJob,source: AutoModMessage,settings: AutoModSettings): Promise<void> {
  const at=new Date(job.created_at ?? job.event_at).getTime();
  if(job.spam_revision!==settings.revision || source.id!==job.message_id || source.channelId!==job.channel_id || !Number.isFinite(at) || at<Date.now()-600000 || at>Date.now()+30000) return;
  const limit=settings.spam_limit ?? 5,window=settings.spam_window_seconds ?? 5;
  // The guild worker/settings lock serializes observation and settings changes.
  await client.query(`INSERT INTO automod_message_activity (guild_id,message_id,user_id,occurred_at,observed_count,message_limit,window_seconds,settings_revision)
    SELECT $1,$2,$3,$4,1+count(*)::int,$5,$6,$7 FROM automod_message_activity
    WHERE guild_id=$1 AND user_id=$3 AND occurred_at>$4::timestamptz-$6::integer*INTERVAL '1 second' AND occurred_at<=$4::timestamptz
      AND message_id<>$2 AND settings_revision=$7
    ON CONFLICT (guild_id,message_id) DO NOTHING`,[job.guild_id,job.message_id,source.userId,job.created_at ?? job.event_at,limit,window,settings.revision]);
}
export async function rapidMessageMatch(client: PoolClient,job: AutoModJob,source: AutoModMessage,settings: AutoModSettings): Promise<string[]> {
  const row=(await client.query<{ observed_count: number; message_limit: number; window_seconds: number; settings_revision: number; user_id: string }>(
    'SELECT * FROM automod_message_activity WHERE guild_id=$1 AND message_id=$2',[job.guild_id,job.message_id])).rows[0];
  if(!row || row.user_id!==source.userId || row.settings_revision!==settings.revision || row.message_limit!==(settings.spam_limit ?? 5) || row.window_seconds!==(settings.spam_window_seconds ?? 5) || row.observed_count<=row.message_limit) return [];
  return [`${row.observed_count} messages in ${row.window_seconds}s (limit ${row.message_limit})`];
}

export async function readRapidSource(client: PoolClient,job: AutoModJob): Promise<AutoModMessage | undefined> {
  const row=(await client.query<{ user_id: string }>('SELECT user_id FROM automod_message_activity WHERE guild_id=$1 AND message_id=$2',[job.guild_id,job.message_id])).rows[0];
  return row?{ id: job.message_id,channelId: job.channel_id,userId: row.user_id,content: '',bot: false,webhook: false }:undefined;
}
