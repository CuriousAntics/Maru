import type { PoolClient } from 'pg';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { digest } from './web-security.js';
import { logChannelId } from './server-settings.js';
import type { AutoModSettings } from './automod-settings.js';
import type { AutoModDependencies,AutoModJob,AutoModMessage } from './automod-engine.js';
export function inviteCodes(text: string): string[] {
  const normalized=text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'');
  const pattern=/(?<![\p{L}\p{N}_.@/:\\-])(?:https?:\/\/)?(?:(?:www\.)?discord\.gg\/|(?:(?:www|canary|ptb)\.)?discord(?:app)?\.com\/invite\/)([A-Za-z0-9_-]{1,100})(?:\/)?(?=$|[\s<>()\[\]{}'"`#?]|[.,!;:]+(?=$|[\s<>()\[\]{}'"`]))/giu;
  return [...new Set([...normalized.matchAll(pattern)].map((match) => match[1]!))].slice(0,100);
}
export function parseApprovedServers(text: string): string[] {
  const ids=[...new Set(text.split(/[,\s]+/).filter(Boolean))].sort();
  if(ids.length>100 || ids.some((id) => !/^\d{17,20}$/.test(id))) throw new Error('INVALID_INVITES');
  return ids;
}
function allowed(guild: string,config: AutoModSettings) { return guild===config.guild_id || (config.invite_allowed_guild_ids ?? []).includes(guild); }
export function inviteEntryBlocked(entry: string,config: AutoModSettings): boolean {
  const guild=/^Server (\d{17,20}) · invite [A-Za-z0-9_-]{1,100}$/.exec(entry)?.[1]; return !!guild && !allowed(guild,config);
}
export async function inviteMessageMatch(client: PoolClient,job: AutoModJob,source: AutoModMessage,config: AutoModSettings,deps: AutoModDependencies): Promise<string[]> {
  const codes=inviteCodes(source.content); if(!codes.length) return [];
  const blocked: string[]=[],unknown: string[]=[]; const end=Date.now()+6000;
  for(const [index,code] of codes.entries()) {
    let guild: string | null=null;
    if(index<10 && Date.now()<end && deps.resolveInvite) {
      try { guild=await deps.resolveInvite(code); } catch { /* An unresolved destination never implies guilt. */ }
    }
    if(!guild || !/^\d{17,20}$/.test(guild)) unknown.push(code);
    else if(!allowed(guild,config)) blocked.push(`Server ${guild} · invite ${code}`);
  }
  // A confirmed unapproved invite is sufficient even if another invite is unknown.
  if(!blocked.length && unknown.length) await reviewInvites(client,job,source,unknown,deps);
  return blocked;
}
type Review={ guild_id: string; message_id: string; channel_id: string; user_id: string; invite_codes: string[]; log_channel_id: string | null; log_status: string };
async function reviewInvites(client: PoolClient,job: AutoModJob,source: AutoModMessage,codes: string[],deps: AutoModDependencies) {
  await client.query('BEGIN');
  try {
    const guild=(await client.query<{ settings: Record<string,unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[job.guild_id])).rows[0];
    if(!guild) throw new Error('SERVER_NOT_CONFIGURED'); const destination=logChannelId(guild.settings);
    const inserted=await client.query(`INSERT INTO automod_invite_reviews (guild_id,message_id,channel_id,user_id,invite_codes,log_channel_id,log_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (guild_id,message_id) DO NOTHING RETURNING message_id`,[job.guild_id,source.id,source.channelId,source.userId,codes,destination,destination?'pending':'not_configured']);
    if(inserted.rowCount) await client.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'AUTOMOD_INVITE_REVIEW',$3::jsonb)",
      [job.guild_id,deps.botId(),JSON.stringify({ message_id: source.id,target_user_id: source.userId,invite_codes: codes,reason: 'Destination unverified; no invite-rule deletion or violation.' })]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  const review=(await client.query<Review>('SELECT * FROM automod_invite_reviews WHERE guild_id=$1 AND message_id=$2',[job.guild_id,source.id])).rows[0]!;
  if(!review.log_channel_id || review.log_status!=='pending') return;
  if(!(await client.query("UPDATE automod_invite_reviews SET log_status='sending' WHERE guild_id=$1 AND message_id=$2 AND log_status='pending' RETURNING message_id",[job.guild_id,source.id])).rowCount) return;
  const body: RESTPostAPIChannelMessageJSONBody={ allowed_mentions: { parse: [] },nonce: digest(`invite-review:${job.guild_id}:${source.id}`).slice(0,25),enforce_nonce: true,
    embeds: [{ title: 'Discord invite: review needed',color: 0xe6ad73,description: 'Maru could not verify a destination. This rule did not delete the message or count a violation. Other moderation rules may act independently.',fields: [
      { name: 'Member ID',value: review.user_id },{ name: 'Channel ID',value: review.channel_id },{ name: 'Message ID',value: review.message_id },
      { name: 'Unverified invite codes',value: review.invite_codes.join(', ').slice(0,1000) },{ name: 'Original message',value: `https://discord.com/channels/${job.guild_id}/${review.channel_id}/${review.message_id}` } ] }] };
  let status='unconfirmed',messageId: string | null=null;
  try { const id=await deps.sendLog(review.log_channel_id,body); if(/^\d{17,20}$/.test(id)) { status='sent'; messageId=id; } }
  catch(error) { if(error && typeof error==='object' && 'status' in error && [400,401,403,404].includes(Number(error.status))) status='failed'; }
  await client.query('BEGIN');
  try {
    await client.query('UPDATE automod_invite_reviews SET log_status=$3,log_message_id=$4 WHERE guild_id=$1 AND message_id=$2',[job.guild_id,source.id,status,messageId]);
    await client.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'AUTOMOD_INVITE_REVIEW_LOG',$3::jsonb)",[job.guild_id,deps.botId(),JSON.stringify({ message_id: source.id,log_status: status,reason: 'Recorded review log delivery without a punishment.' })]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
}
