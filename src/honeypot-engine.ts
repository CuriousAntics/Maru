import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { getStaffAccess } from './staff-access.js';
import { logChannelId } from './server-settings.js';
import { digest } from './web-security.js';
import { readHoneypotSettings, HoneypotError } from './honeypot-settings.js';
import { deliverWarning } from './warnings.js';
import type { WarningCase, WarningDependencies } from './warnings.js';
export type HoneypotEvent={ messageId: string; channelId: string; userId: string; occurredAt: Date };
export type HoneypotRow={ guild_id: string; message_id: string; channel_id: string; user_id: string; occurred_at: Date; settings_revision: number; marker: string;
  case_number: number | null; ban_status: string; unban_status: string; note: string; done: boolean };
export type HoneypotContext={ guildName: string; member: boolean; bot: boolean; owner: boolean; administrator: boolean; roles: string[]; canBan: boolean; above: boolean };
export type HoneypotDependencies={ botId: () => string; readContext: (id: string) => Promise<HoneypotContext>;
  readBan: (id: string) => Promise<{ reason: string | null } | null>;
  ban: (id: string,reason: string) => Promise<void>; unban: (id: string,reason: string) => Promise<void>;
  notifications: WarningDependencies };
export function parseHoneypotEvent(packet: { t?: string | null; d: unknown },guildId: string): HoneypotEvent | undefined {
  if(packet.t!=='MESSAGE_CREATE') return;
  const d=packet.d as { guild_id?: string; id?: string; channel_id?: string; timestamp?: string; type?: number; webhook_id?: string; author?: { id?: string; bot?: boolean } } | null;
  if(!d || d.guild_id!==guildId || d.webhook_id || d.author?.bot || ![0,19].includes(d.type ?? 0) ||
    ![d.id,d.channel_id,d.author?.id].every((id) => /^\d{17,20}$/.test(id ?? ''))) return;
  const at=new Date(d.timestamp ?? '');
  if(!Number.isFinite(at.getTime()) || at.getTime()>Date.now()+30000 || at.getTime()<Date.now()-120000) return;
  return { messageId: d.id!,channelId: d.channel_id!,userId: d.author!.id!,occurredAt: at };
}
export async function enqueueHoneypot(pool: Pick<Pool,'query'>,guildId: string,events: HoneypotEvent[]): Promise<void> {
  for(const event of events) {
    if(![guildId,event.messageId,event.channelId,event.userId].every((id) => /^\d{17,20}$/.test(id)) || !Number.isFinite(event.occurredAt.getTime())) continue;
    await pool.query(`INSERT INTO honeypot_events (guild_id,message_id,channel_id,user_id,occurred_at,settings_revision,marker)
      SELECT guild_id,$2,$3,$4,$5,revision,$6 FROM honeypot_settings WHERE guild_id=$1 AND enabled AND $3=ANY(channel_ids)
        AND $5::timestamptz>=updated_at AND $5::timestamptz>NOW()-INTERVAL '2 minutes' AND $5::timestamptz<=NOW()+INTERVAL '30 seconds'
      ON CONFLICT (guild_id,message_id) DO NOTHING`,[guildId,event.messageId,event.channelId,event.userId,event.occurredAt,`Maru honeypot ${randomUUID()}`]);
  }
}
export function honeypotLog(row: HoneypotRow,record: WarningCase): RESTPostAPIChannelMessageJSONBody {
  return { allowed_mentions: { parse: [] },enforce_nonce: true,nonce: digest(`honeypot:${row.guild_id}:${row.message_id}`).slice(0,25),
    embeds: [{ title: `Honeypot softban · Case #${record.case_number}`,color: 0xe6ad73,
      description: 'Recorded results. A completed softban removes the member and allows them to rejoin; it does not rejoin them automatically. No DM is sent.',
      fields: [{ name: 'Member ID',value: row.user_id },{ name: 'Channel ID',value: row.channel_id },{ name: 'Message ID',value: row.message_id },
        { name: 'Ban',value: row.ban_status },{ name: 'Unban',value: row.unban_status },{ name: 'Requested history deletion',value: '24 hours' },{ name: 'Result',value: row.note.slice(0,1000) }] }] };
}
// An owned ban has a per-event random reason. Never undo a pre-existing or replaced ban.
export async function processHoneypotJob(pool: Pick<Pool,'query'|'connect'>,guildId: string,deps: HoneypotDependencies): Promise<boolean> {
  const client=await pool.connect(); let guildLock=false,memberLock=false,transaction=false,discard=false;
  let row: HoneypotRow | undefined;
  async function begin() { await client.query('BEGIN'); transaction=true; await client.query("SET LOCAL lock_timeout='5s'"); }
  async function commit() { await client.query('COMMIT'); transaction=false; }
  async function audit(event: string,note: string) {
    await client.query('INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)',
      [guildId,deps.botId(),event,JSON.stringify({ case_number: row!.case_number,target_user_id: row!.user_id,message_id: row!.message_id,channel_id: row!.channel_id,reason: note })]);
  }
  async function update(ban: string,unban: string,note: string,done=false) {
    row=(await client.query<HoneypotRow>(`UPDATE honeypot_events SET ban_status=$3,unban_status=$4,note=$5,done=$6 WHERE guild_id=$1 AND message_id=$2 RETURNING *`,[guildId,row!.message_id,ban,unban,note,done])).rows[0]!;
  }
  async function finish(ban: string,unban: string,note: string) {
    await begin(); await update(ban,unban,note,true);
    if(row!.case_number) {
      const status=ban==='applied' && unban==='applied'?'applied':['rejected','skipped'].includes(ban)?'rejected':'unconfirmed';
      await client.query(`UPDATE moderation_cases SET action_status=$3,action_completed_at=NOW(),action_error=$4 WHERE guild_id=$1 AND case_number=$2`,[guildId,row!.case_number,status,status==='applied'?null:note]);
    }
    await audit('HONEYPOT_RESULT',note); await commit();
  }
  async function eligible(db: PoolClient) {
    // Same guild row serialization as dashboard saves; settings and staff mappings are read afresh.
    await db.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[guildId]);
    const settings=await readHoneypotSettings(db,guildId);
    if(!settings.enabled || settings.revision!==row!.settings_revision || !settings.channel_ids.includes(row!.channel_id) || new Date(row!.occurred_at).getTime()<Date.now()-600000) return { note: 'Disabled, changed settings, or expired event' };
    const earlier=(await db.query(`SELECT 1 FROM honeypot_events e JOIN moderation_cases c ON c.guild_id=e.guild_id AND c.case_number=e.case_number
      WHERE e.guild_id=$1 AND e.user_id=$2 AND e.message_id<>$3 AND e.ban_status IN ('applying','applied','unconfirmed')
      AND COALESCE(c.action_completed_at,c.action_attempted_at)>=$4::timestamptz LIMIT 1`,[guildId,row!.user_id,row!.message_id,row!.occurred_at])).rowCount;
    if(earlier) return { note: 'An earlier softban attempt already covered this queued message' };
    const context=await deps.readContext(row!.user_id);
    if(!context.member || context.bot || context.owner || context.administrator || context.roles.some((id) => settings.exempt_role_ids.includes(id)) || await getStaffAccess(db,guildId,row!.user_id,context.roles)!=='none') return { note: 'Member absent or protected by staff, bot, owner, Administrator, or exemption checks' };
    return { context };
  }
  try {
    guildLock=(await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),731210) AS locked',[guildId])).rows[0]?.locked===true;
    if(!guildLock) return false;
    row=(await client.query<HoneypotRow>(`SELECT e.* FROM honeypot_events e LEFT JOIN moderation_cases c ON c.guild_id=e.guild_id AND c.case_number=e.case_number
      WHERE e.guild_id=$1 AND e.available_at<=NOW() AND (NOT e.done OR (c.notification_claimed_at IS NULL AND c.action_status IN ('applied','rejected','unconfirmed')))
      ORDER BY e.created_at,e.message_id LIMIT 1`,[guildId])).rows[0];
    if(!row) return false;
    memberLock=(await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',[guildId,row.user_id])).rows[0]?.locked===true;
    if(!memberLock) throw new HoneypotError('MEMBER_BUSY');
    if(!row.done && row.ban_status==='pending') {
      await begin();
      const check=await eligible(client);
      if(!check.context) { await commit(); await finish('skipped','skipped',check.note!); }
      else {
        const existing=check.context.canBan?await deps.readBan(row.user_id):null;
        if(existing) { await commit(); await finish('skipped','skipped','Already banned; existing ban was left in place'); }
        else {
          if(!row.case_number) {
            const settings=(await client.query<{ settings: Record<string,unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1',[guildId])).rows[0]!.settings;
            const channel=logChannelId(settings);
            if(!channel || (await readHoneypotSettings(client,guildId)).channel_ids.includes(channel)) { await commit(); await finish('skipped','skipped','No safe moderation log destination outside the trap channels; action not attempted'); }
            else {
              const number=(await client.query<{ last_case_number: number }>(`INSERT INTO guild_case_counters (guild_id,last_case_number) VALUES ($1,1)
                ON CONFLICT (guild_id) DO UPDATE SET last_case_number=guild_case_counters.last_case_number+1 RETURNING last_case_number`,[guildId])).rows[0]!.last_case_number;
              await client.query(`INSERT INTO moderation_cases (guild_id,case_number,request_id,action,actor_id,target_user_id,reason,guild_name,log_channel_id,dm_status,action_status,delete_message_seconds,origin)
                VALUES ($1,$2,$3,'softban',$4,$5,'Posted in the configured honeypot channel',$6,$7,'skipped','pending',86400,'automod')`,
                [guildId,number,`honeypot:${row.message_id}`,deps.botId(),row.user_id,check.context.guildName.slice(0,100),channel]);
              row.case_number=number;
              await client.query('UPDATE honeypot_events SET case_number=$3 WHERE guild_id=$1 AND message_id=$2',[guildId,row.message_id,number]);
              await audit('HONEYPOT_REQUESTED','Softban requested with 24 hours of message deletion; no DM');
            }
          }
          if(transaction) {
            // Recheck after ban lookups: a role or exemption may have changed while awaiting Discord.
            const finalCheck=await eligible(client);
            if(!finalCheck.context) { await commit(); await finish('skipped','skipped',finalCheck.note!); }
            else if(!finalCheck.context.canBan || !finalCheck.context.above) { await commit(); await finish('rejected','skipped','Ban Members permission or role hierarchy unavailable'); }
            else {
              await update('applying','pending','Ban attempt claimed');
              await client.query("UPDATE moderation_cases SET action_status='applying',action_attempted_at=NOW() WHERE guild_id=$1 AND case_number=$2",[guildId,row.case_number]);
              await audit('HONEYPOT_BAN_CLAIMED','Ban attempt claimed before dispatch'); await commit();
              try { await deps.ban(row.user_id,row.marker); }
              catch(error) {
                if(explicitRejection(error)) { await finish('rejected','skipped','Discord rejected the ban'); }
                // An ambiguous response is reconciled by its unique ban reason below; never repeat PUT.
              }
            }
          }
        }
      }
    }
    if(!row.done && ['applying','unconfirmed','applied'].includes(row.ban_status)) {
      const ban=await deps.readBan(row.user_id);
      if(!ban) {
        if(row.ban_status==='applied' && row.unban_status!=='pending') await finish('applied','applied','Ban removal verified; member may rejoin');
        else await finish(row.ban_status==='applied'?'applied':'unconfirmed','skipped','No current ban; ban execution or removal was not confirmed');
      } else if(ban.reason!==row.marker) await finish(row.ban_status==='applied'?'applied':'unconfirmed','skipped','Current ban belongs to another action; left in place for staff review');
      else if(row.unban_status==='applying' || row.unban_status==='unconfirmed') await finish('applied','unconfirmed','Unban attempt was interrupted or unconfirmed; owned ban remains. Staff must review and use /unban if appropriate');
      else {
        // Only a ban bearing this event's random marker may be removed.
        await begin(); await update('applied','applying','Unban attempt claimed');
        await audit('HONEYPOT_UNBAN_CLAIMED','Owned ban confirmed; unban attempt claimed before dispatch'); await commit();
        let rejected=false;
        try { await deps.unban(row.user_id,row.marker); }
        catch(error) { rejected=explicitRejection(error); }
        const after=await deps.readBan(row.user_id);
        if(!after) await finish('applied','applied','Softban completed; member may rejoin. Discord was asked to delete 24 hours of message history');
        else await finish('applied',rejected?'rejected':'unconfirmed',after.reason===row.marker?'Unban was not confirmed; member may still be banned. Staff review required':'Another ban now exists; left in place for staff review');
      }
    }
    if(row.done && row.case_number) {
      const record=(await client.query<WarningCase>('SELECT * FROM moderation_cases WHERE guild_id=$1 AND case_number=$2',[guildId,row.case_number])).rows[0]!;
      const snapshot=row;
      await deliverWarning(pool,record,deps.notifications,() => honeypotLog(snapshot,record));
    }
    return true;
  } catch(error) {
    if(transaction) { try { await client.query('ROLLBACK'); transaction=false; } catch { discard=true; } }
    if(row && !discard) await client.query("UPDATE honeypot_events SET available_at=NOW()+INTERVAL '30 seconds' WHERE guild_id=$1 AND message_id=$2",[guildId,row.message_id]);
    console.error('Honeypot work is saved for recovery after a Discord, permission, or database failure.');
    return false;
  } finally {
    if(memberLock || guildLock) { try {
      if(memberLock && row) await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',[guildId,row.user_id]);
      if(guildLock) await client.query('SELECT pg_advisory_unlock(hashtext($1),731210)',[guildId]);
    } catch { discard=true; } }
    client.release(discard?new Error('Honeypot connection could not release its locks safely.'):undefined);
  }
}
function explicitRejection(error: unknown): boolean { return !!error && typeof error==='object' && 'status' in error && [400,401,403,404].includes(Number(error.status)); }
