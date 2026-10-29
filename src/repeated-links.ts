import type { PoolClient } from 'pg';
import type { AutoModSettings } from './automod-settings.js';
import type { AutoModJob, AutoModMessage } from './automod-engine.js';
import { messageLinks } from './message-links.js';
export async function observeRepeatedLinks(db: PoolClient,job: AutoModJob,source: AutoModMessage,s: AutoModSettings) {
 const at=new Date(job.created_at ?? job.event_at).getTime();
 if(job.link_revision!==s.link_revision || job.link_shared_revision!==s.revision || !Number.isFinite(at) || at<new Date(s.link_updated_at ?? 0).getTime() || at<Date.now()-600000 || at>Date.now()+30000 || source.id!==job.message_id || source.channelId!==job.channel_id) return;
 if((await db.query('SELECT 1 FROM automod_link_activity WHERE guild_id=$1 AND message_id=$2',[job.guild_id,job.message_id])).rowCount) return;
 const links=messageLinks(source.content),matched: string[]=[],entries: string[]=[];
 for(const link of links) {
 const n=(await db.query<{ n: number }>(`SELECT 1+count(*)::int AS n FROM automod_link_activity WHERE guild_id=$1 AND user_id=$2 AND occurred_at>$3::timestamptz-$4::integer*INTERVAL '1 second'
 AND occurred_at<=$3 AND settings_revision=$5 AND shared_revision=$6 AND fingerprints @> ARRAY[$7]::text[]`,[job.guild_id,source.userId,job.created_at ?? job.event_at,s.link_window_seconds ?? 30,s.link_revision,s.revision,link.key])).rows[0]!.n;
 if(n>=(s.link_limit ?? 3)) { matched.push(link.key); entries.push(`Repeated URL at ${link.domain}: ${n} occurrences in ${s.link_window_seconds ?? 30}s`); }
 }
 await db.query(`INSERT INTO automod_link_activity(guild_id,message_id,user_id,occurred_at,fingerprints,matched_keys,matched_entries,settings_revision,shared_revision)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[job.guild_id,job.message_id,source.userId,job.created_at ?? job.event_at,links.map((l) => l.key),matched,entries,s.link_revision,s.revision]);
}
export async function repeatedLinkMatch(db: PoolClient,job: AutoModJob,source: AutoModMessage,s: AutoModSettings) {
 const row=(await db.query<{ user_id: string; settings_revision: number; shared_revision: number; matched_keys: string[]; matched_entries: string[] }>('SELECT * FROM automod_link_activity WHERE guild_id=$1 AND message_id=$2',[job.guild_id,job.message_id])).rows[0];
 if(!row || row.user_id!==source.userId || row.settings_revision!==s.link_revision || row.shared_revision!==s.revision) return [];
 if(source.linkHistorical) return row.matched_entries;
 const keys=new Set(messageLinks(source.content).map((l) => l.key)); return row.matched_entries.filter((_,i) => keys.has(row.matched_keys[i]!));
}
export async function readLinkSource(db: PoolClient,job: AutoModJob): Promise<AutoModMessage | undefined> {
 const row=(await db.query<{ user_id: string }>('SELECT user_id FROM automod_link_activity WHERE guild_id=$1 AND message_id=$2',[job.guild_id,job.message_id])).rows[0];
 return row?{ id: job.message_id,channelId: job.channel_id,userId: row.user_id,content: '',bot: false,webhook: false,linkHistorical: true }:undefined;
}
