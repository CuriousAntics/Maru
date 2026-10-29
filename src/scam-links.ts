import type { PoolClient } from 'pg';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { escapeMarkdown } from 'discord.js';
import type { AutoModSettings } from './automod-settings.js';
import type { AutoModDependencies, AutoModJob, AutoModMessage } from './automod-engine.js';
import { messageLinks } from './message-links.js';
import { digest } from './web-security.js';
import { logChannelId } from './server-settings.js';
export async function scamDomainVerdict(domains: string[],s: AutoModSettings,deps: AutoModDependencies) {
 const allowed=new Set(s.scam_allowed_domains ?? []),manual=new Set(s.scam_blocked_domains ?? []);
 const has=(set: Set<string>,d: string) => set.has(d) || d.startsWith('www.') && set.has(d.slice(4));
 const remaining=domains.filter((d) => !has(allowed,d) && !has(manual,d));
 let verdict={ blocked: [] as string[],unknown: remaining,note: 'Feed unavailable' };
 if(remaining.length && deps.checkScamDomains) { try { const checked=await deps.checkScamDomains(remaining); if(checked && Array.isArray(checked.blocked) && Array.isArray(checked.unknown) && typeof checked.note==='string') verdict=checked; } catch { /* Unknown never implies guilt. */ } }
 const blocked=[...new Set([...domains.filter((d) => !has(allowed,d) && has(manual,d)),...verdict.blocked.filter((d) => remaining.includes(d))])];
 return { blocked,unknown: verdict.unknown.filter((d) => remaining.includes(d) && !blocked.includes(d)),note: verdict.note };
}
export async function scamLinkMatch(db: PoolClient,job: AutoModJob,source: AutoModMessage,s: AutoModSettings,deps: AutoModDependencies): Promise<string[]> {
 const at=new Date(job.event_at).getTime();
 if(job.scam_revision!==s.link_revision || !Number.isFinite(at) || at<new Date(s.link_updated_at ?? 0).getTime() || at<Date.now()-600000 || at>Date.now()+30000) return [];
 const domains=[...new Set(messageLinks(source.content).map((l) => l.domain))]; if(!domains.length) return [];
 const verdict=await scamDomainVerdict(domains,s,deps);
 if(!verdict.blocked.length && verdict.unknown.length) await reviewLinks(db,job,source,verdict.unknown,verdict.note,deps);
 return verdict.blocked.map((d) => `Scam domain: ${d}`);
}
async function reviewLinks(db: PoolClient,job: AutoModJob,source: AutoModMessage,domains: string[],reason: string,deps: AutoModDependencies) {
 domains=[...new Set(domains)].sort();
 await db.query('BEGIN');
 try {
 const guild=(await db.query<{ settings: Record<string,unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[job.guild_id])).rows[0]; if(!guild) throw new Error('NOT_CONFIGURED');
 const channel=logChannelId(guild.settings);
 const prior=(await db.query("SELECT 1 FROM automod_link_reviews WHERE guild_id=$1 AND user_id=$2 AND domains=$3::text[] AND created_at>NOW()-INTERVAL '10 minutes' AND log_status IN ('sending','sent','unconfirmed') LIMIT 1",[job.guild_id,source.userId,domains])).rowCount;
 const inserted=await db.query(`INSERT INTO automod_link_reviews(guild_id,message_id,channel_id,user_id,domains,reason,log_channel_id,log_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
 ON CONFLICT DO NOTHING RETURNING message_id`,[job.guild_id,source.id,source.channelId,source.userId,domains,reason.slice(0,500),channel,!channel?'not_configured':prior?'suppressed':'pending']);
 if(inserted.rowCount) await db.query("INSERT INTO audit_events(guild_id,actor_id,event_type,details) VALUES ($1,$2,'AUTOMOD_LINK_REVIEW',$3::jsonb)",[job.guild_id,deps.botId(),JSON.stringify({ message_id: source.id,target_user_id: source.userId,domains,reason: 'Unverified link left by scam rule; no violation or punishment' })]);
 await db.query('COMMIT');
 } catch(e) { await db.query('ROLLBACK'); throw e; }
 const row=(await db.query<{ log_channel_id: string; log_status: string; reason: string }>('SELECT * FROM automod_link_reviews WHERE guild_id=$1 AND message_id=$2',[job.guild_id,source.id])).rows[0]!;
 if(row.log_status!=='pending' || !row.log_channel_id) return;
 if(!(await db.query("UPDATE automod_link_reviews SET log_status='sending' WHERE guild_id=$1 AND message_id=$2 AND log_status='pending' RETURNING message_id",[job.guild_id,source.id])).rowCount) return;
 const body: RESTPostAPIChannelMessageJSONBody={ allowed_mentions: { parse: [] },nonce: digest(`link-review:${job.guild_id}:${source.id}`).slice(0,25),enforce_nonce: true,
 embeds: [{ title: 'Link review needed',description: 'Unverified does not mean malicious. The scam rule left this message and recorded no violation. Other rules may act independently. Domains are shown without paths, credentials or query strings.',fields: [{ name: 'Member ID',value: source.userId },{ name: 'Domains',value: domains.map((d) => escapeMarkdown(d)).join(', ').slice(0,1000) },{ name: 'Check',value: row.reason },{ name: 'Original message',value: `https://discord.com/channels/${job.guild_id}/${source.channelId}/${source.id}` }] }] };
 let status='unconfirmed',messageId: string | null=null;
 try { const id=await deps.sendLog(row.log_channel_id,body); if(/^\d{17,20}$/.test(id)) { status='sent'; messageId=id; } } catch(e) { if(e && typeof e==='object' && 'status' in e && [400,401,403,404].includes(Number(e.status))) status='failed'; }
 await db.query('BEGIN');
 try {
 await db.query('UPDATE automod_link_reviews SET log_status=$3,log_message_id=$4 WHERE guild_id=$1 AND message_id=$2',[job.guild_id,source.id,status,messageId]);
 await db.query("INSERT INTO audit_events(guild_id,actor_id,event_type,details) VALUES ($1,$2,'AUTOMOD_LINK_REVIEW_LOG',$3::jsonb)",[job.guild_id,deps.botId(),JSON.stringify({ message_id: source.id,log_status: status,reason: 'Recorded link review notification outcome without punishment' })]); await db.query('COMMIT');
 } catch(e) { await db.query('ROLLBACK'); throw e; }
}
