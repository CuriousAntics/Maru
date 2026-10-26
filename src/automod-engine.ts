import type { PoolClient } from 'pg';
import type { RESTPostAPIChannelMessageJSONBody } from 'discord.js';
import { escapeMarkdown } from 'discord.js';
import { AutoModError, autoModExempt, readAutoModSettings } from './automod-settings.js';
import type { AutoModSettings } from './automod-settings.js';
import { matchBlockedWords } from './blocked-words.js';
import { digest } from './web-security.js';
import { logChannelId } from './server-settings.js';
import type { WarningCase } from './warnings.js';

export type AutoModMessage = { id: string; channelId: string; userId: string; content: string; bot: boolean; webhook: boolean };
export type AutoModContext = { guildName: string; roleIds: string[]; parentId: string | null; owner: boolean; canDelete: boolean; canTimeout: boolean; timeoutUntil: string | null };
export type AutoModJob = { guild_id: string; message_id: string; channel_id: string; event_at: Date; version: string; attempts: number };
export type AutoModDependencies = {
  botId: () => string;
  readMessage: (channel: string,message: string) => Promise<AutoModMessage | null>;
  readContext: (channel: string,userId: string) => Promise<AutoModContext>;
  deleteMessage: (channel: string,message: string) => Promise<void>;
  applyTimeout: (userId: string,until: string,caseNumber: number) => Promise<{ targetId: string; until: string | null }>;
  sendLog: (channel: string,body: RESTPostAPIChannelMessageJSONBody) => Promise<string>;
};
type Violation = { guild_id: string; message_id: string; channel_id: string; parent_channel_id: string | null; user_id: string; occurred_at: Date;
  counted_at: Date | null; matched_entries: string[]; delete_status: string; violation_count: number; case_number: number | null; timeout_note: string;
  escalation_evaluated: boolean; log_channel_id: string | null; log_status: string; log_message_id: string | null };
type Counter = { reset_at: Date; last_attempt_at: Date | null; pending_case_number: number | null };
export async function processAutoModMessage(client: PoolClient,job: AutoModJob,deps: AutoModDependencies): Promise<void> {
  const guild=job.guild_id; const config=await readAutoModSettings(client,guild);
  let violation=(await client.query<Violation>("SELECT * FROM automod_violations WHERE guild_id=$1 AND rule_key='blocked_words' AND message_id=$2",[guild,job.message_id])).rows[0];
  let context: AutoModContext | undefined;
  async function audit(event: string,details: Record<string,unknown>) {
    await client.query('INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)',[guild,deps.botId(),event,JSON.stringify({ rule_key: 'blocked_words',message_id: job.message_id,target_user_id: violation?.user_id,...details })]);
  }
  async function atomic(work: () => Promise<void>) { await client.query('BEGIN'); try { await work(); await client.query('COMMIT'); } catch(error) { await client.query('ROLLBACK'); throw error; } }
  if (!violation) {
    if (!config.blocked_enabled) return;
    const source=await deps.readMessage(job.channel_id,job.message_id);
    if (!source || source.bot || source.webhook || source.userId===deps.botId()) return;
    if (source.id!==job.message_id || source.channelId!==job.channel_id) throw new AutoModError('INVALID_MESSAGE');
    const matched=matchBlockedWords(source.content,config.blocked_words); if (!matched.length) return;
    context=await deps.readContext(job.channel_id,source.userId);
    if (context.owner || autoModExempt(config,context.roleIds,job.channel_id,context.parentId)) return;
    if (!context.canDelete) throw new AutoModError('DELETE_PERMISSION');
    await atomic(async () => {
      const settings=(await client.query<{ settings: Record<string,unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[guild])).rows[0];
      if (!settings) throw new AutoModError('NOT_CONFIGURED');
      violation=(await client.query<Violation>(`INSERT INTO automod_violations (guild_id,message_id,channel_id,parent_channel_id,user_id,occurred_at,matched_entries,log_channel_id,log_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[guild,job.message_id,job.channel_id,context!.parentId,source.userId,job.event_at,matched,logChannelId(settings.settings),logChannelId(settings.settings)?'pending':'not_configured'])).rows[0]!;
      await audit('AUTOMOD_BLOCKED_WORD',{ matched_entries: matched,channel_id: job.channel_id,reason: 'Detected a blocked word or phrase; source content was not copied into the audit.' });
    });
  }
  if (!violation) return;
  const v=violation;
  context ??= await deps.readContext(v.channel_id,v.user_id);
  let currentMessage: AutoModMessage | null | undefined;
  if(config.blocked_enabled && v.delete_status!=='removed' && !context.owner && !autoModExempt(config,context.roleIds,v.channel_id,context.parentId ?? v.parent_channel_id)) {
    currentMessage=await deps.readMessage(v.channel_id,v.message_id);
    if(currentMessage && currentMessage.userId===v.user_id && !currentMessage.bot && !currentMessage.webhook) {
      const currentMatches=matchBlockedWords(currentMessage.content,config.blocked_words);
      if(currentMatches.length && !v.counted_at && (JSON.stringify(currentMatches)!==JSON.stringify(v.matched_entries) || new Date(v.occurred_at).getTime()!==new Date(job.event_at).getTime())) {
        await atomic(async () => {
          await client.query('UPDATE automod_violations SET matched_entries=$3,occurred_at=$4 WHERE guild_id=$1 AND message_id=$2 AND counted_at IS NULL',[guild,v.message_id,currentMatches,job.event_at]);
          await audit('AUTOMOD_MATCH_RECHECKED',{ matched_entries: currentMatches,reason: 'Rechecked an edited message before its first confirmed removal.' });
        }); v.matched_entries=currentMatches; v.occurred_at=job.event_at;
      }
    }
  }
  const active=config.blocked_enabled && v.matched_entries.some((entry) => config.blocked_words.includes(entry)) && !context.owner &&
    !autoModExempt(config,context.roleIds,v.channel_id,context.parentId ?? v.parent_channel_id);
  if (active) {
    if (v.delete_status!=='removed') {
      const source=currentMessage===undefined?await deps.readMessage(v.channel_id,v.message_id):currentMessage;
      if (source) {
        // Recheck an edited message: removing the match before processing avoids a stale deletion.
        if (source.userId!==v.user_id || source.bot || source.webhook || !matchBlockedWords(source.content,config.blocked_words).length) {
          await client.query("UPDATE automod_violations SET timeout_note='Message no longer matches; no further action' WHERE guild_id=$1 AND message_id=$2",[guild,v.message_id]);
          await logViolation(client,v,deps); return;
        }
        if (!context.canDelete) throw new AutoModError('DELETE_PERMISSION');
        await client.query("UPDATE automod_violations SET delete_status='deleting' WHERE guild_id=$1 AND message_id=$2",[guild,v.message_id]);
        await deps.deleteMessage(v.channel_id,v.message_id);
      }
      await atomic(async () => {
        await client.query("UPDATE automod_violations SET delete_status='removed' WHERE guild_id=$1 AND message_id=$2",[guild,v.message_id]);
        await audit('AUTOMOD_MESSAGE_REMOVED',{ channel_id: v.channel_id,reason: 'The blocked message is confirmed removed.' });
      }); v.delete_status='removed';
    }
    await client.query('INSERT INTO automod_counters (guild_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[guild,v.user_id]);
    const counter=(await client.query<Counter>('SELECT * FROM automod_counters WHERE guild_id=$1 AND user_id=$2',[guild,v.user_id])).rows[0]!;
    const count=(await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM automod_violations WHERE guild_id=$1 AND user_id=$2 AND rule_key='blocked_words'
      AND delete_status='removed' AND occurred_at>NOW()-INTERVAL '10 minutes' AND occurred_at>(SELECT reset_at FROM automod_counters WHERE guild_id=$1 AND user_id=$2)`,[guild,v.user_id])).rows[0]!.count;
    const snapshot=await client.query('UPDATE automod_violations SET violation_count=$3,counted_at=NOW() WHERE guild_id=$1 AND message_id=$2 AND counted_at IS NULL RETURNING message_id',[guild,v.message_id,count]);
    if(snapshot.rowCount) v.violation_count=count;
    if (v.case_number || (!v.escalation_evaluated && count>=5)) await timeoutForViolation(client,v,config,counter,deps,count);
    await client.query('UPDATE automod_violations SET escalation_evaluated=TRUE WHERE guild_id=$1 AND message_id=$2',[guild,v.message_id]);
  } else {
    await atomic(async () => {
      if(v.case_number) {
        const rejected=await client.query("UPDATE moderation_cases SET action_status='rejected',action_completed_at=NOW(),action_error='RULE_DISABLED_OR_EXEMPT' WHERE guild_id=$1 AND case_number=$2 AND action_status='pending' RETURNING case_number",[guild,v.case_number]);
        if(rejected.rowCount) {
          await client.query('UPDATE automod_counters SET pending_case_number=NULL WHERE guild_id=$1 AND user_id=$2 AND pending_case_number=$3',[guild,v.user_id,v.case_number]);
          await audit('AUTOMOD_TIMEOUT_REJECTED',{ case_number: v.case_number,reason: 'Rule disabled, changed or target exempt before native dispatch.' });
        }
      }
      await client.query("UPDATE automod_violations SET escalation_evaluated=TRUE,timeout_note='Rule disabled, changed, or member/channel now exempt; no further action' WHERE guild_id=$1 AND message_id=$2",[guild,v.message_id]);
    });
  }
  await logViolation(client,v,deps);
}

async function timeoutForViolation(client: PoolClient,v: Violation,settings: AutoModSettings,counter: Counter,deps: AutoModDependencies,currentCount: number) {
  let locked=false;
  const note=async (text: string) => { await client.query('UPDATE automod_violations SET timeout_note=$3 WHERE guild_id=$1 AND message_id=$2',[v.guild_id,v.message_id,text]); };
  const getCase=async (number: number) => (await client.query<WarningCase>('SELECT * FROM moderation_cases WHERE guild_id=$1 AND case_number=$2',[v.guild_id,number])).rows[0]!;
  async function outcome(record: WarningCase,status: 'applied'|'rejected'|'unconfirmed',code: string | null) {
    await client.query('BEGIN');
    try {
      await client.query('UPDATE moderation_cases SET action_status=$3,action_completed_at=NOW(),action_error=$4 WHERE guild_id=$1 AND case_number=$2',[v.guild_id,record.case_number,status,code]);
      if(status==='applied') await client.query('UPDATE automod_counters SET reset_at=NOW(),pending_case_number=NULL,last_attempt_at=NULL WHERE guild_id=$1 AND user_id=$2',[v.guild_id,v.user_id]);
      else if(status==='rejected') await client.query('UPDATE automod_counters SET pending_case_number=NULL WHERE guild_id=$1 AND user_id=$2',[v.guild_id,v.user_id]);
      await note(`Timeout ${status}${code?`: ${code}`:''}`);
      await client.query('INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)',[v.guild_id,deps.botId(),`AUTOMOD_TIMEOUT_${status.toUpperCase()}`,
        JSON.stringify({ case_number: record.case_number,target_user_id: v.user_id,rule_key: 'blocked_words',error_code: code,reason: status==='applied'?'Timeout confirmed; this member’s blocked-word counter was reset.':'No counter reset; review the recorded timeout result.' })]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
  }
  try {
    locked=(await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',[v.guild_id,v.user_id])).rows[0]?.locked===true;
    if(!locked) { await note('Timeout not attempted: another native moderation action is running'); return; }
    const context=await deps.readContext(v.channel_id,v.user_id);
    let record=v.case_number?await getCase(v.case_number):undefined;
    if(!record && counter.pending_case_number) {
      const pending=await getCase(counter.pending_case_number);
      if (['applying','unconfirmed'].includes(pending.action_status) && context.timeoutUntil && Math.abs(Date.parse(context.timeoutUntil)-new Date(pending.requested_until!).getTime())<=1) {
        await outcome(pending,'applied','VERIFIED_CURRENT_TIMEOUT'); return;
      }
      if(new Date(pending.requested_until!).getTime()>Date.now()) { await note('Earlier automatic timeout is awaiting confirmation; staff review required'); return; }
      await client.query('UPDATE automod_counters SET pending_case_number=NULL WHERE guild_id=$1 AND user_id=$2',[v.guild_id,v.user_id]);
    }
    if (record && record.action_status!=='pending') {
      if (['applying','unconfirmed'].includes(record.action_status) && context.timeoutUntil && Math.abs(Date.parse(context.timeoutUntil)-new Date(record.requested_until!).getTime())<=1) await outcome(record,'applied','VERIFIED_CURRENT_TIMEOUT');
      else if(record.action_status==='applying') await outcome(record,'unconfirmed','RESPONSE_UNAVAILABLE');
      return;
    }
    if(record && currentCount<5) { await outcome(record,'rejected','VIOLATION_WINDOW_EXPIRED'); return; }
    const exempt=context.owner || autoModExempt(settings,context.roleIds,v.channel_id,context.parentId ?? v.parent_channel_id);
    if(exempt || !context.canTimeout || context.timeoutUntil && Date.parse(context.timeoutUntil)>Date.now()) {
      if(record) await outcome(record,'rejected','TARGET_NOW_PROTECTED');
      else { await note('Timeout not attempted: member is exempt, protected, already timed out, or bot permissions/hierarchy are insufficient');
        await client.query('UPDATE automod_counters SET last_attempt_at=NOW() WHERE guild_id=$1 AND user_id=$2',[v.guild_id,v.user_id]); }
      return;
    }
    if(!record) {
      if(counter.last_attempt_at && Date.now()-new Date(counter.last_attempt_at).getTime()<60000) { await note('Timeout not attempted: waiting after a recent unsuccessful attempt'); return; }
      await client.query('BEGIN');
      try {
        await client.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[v.guild_id]);
        const counterRow=(await client.query<{ last_case_number: number }>(`INSERT INTO guild_case_counters (guild_id,last_case_number) VALUES ($1,1)
          ON CONFLICT (guild_id) DO UPDATE SET last_case_number=guild_case_counters.last_case_number+1 RETURNING last_case_number`,[v.guild_id])).rows[0]!;
        record=(await client.query<WarningCase>(`INSERT INTO moderation_cases (guild_id,case_number,request_id,action,actor_id,target_user_id,reason,guild_name,
          log_channel_id,log_status,dm_status,action_status,duration_seconds,requested_until,origin)
          VALUES ($1,$2,$3,'timeout',$4,$5,$6,$7,$8,$9,'skipped','pending',$10,$11,'automod') RETURNING *`,
          [v.guild_id,counterRow.last_case_number,v.message_id,deps.botId(),v.user_id,'AutoMod: five blocked-word violations within a rolling ten-minute window.',context.guildName.slice(0,100),
            v.log_channel_id,v.log_channel_id?'pending':'not_configured',settings.timeout_seconds,new Date(Date.now()+settings.timeout_seconds*1000)])).rows[0]!;
        await client.query('UPDATE automod_violations SET case_number=$3 WHERE guild_id=$1 AND message_id=$2',[v.guild_id,v.message_id,record.case_number]); v.case_number=record.case_number;
        await client.query('UPDATE automod_counters SET pending_case_number=$3,last_attempt_at=NOW() WHERE guild_id=$1 AND user_id=$2',[v.guild_id,v.user_id,record.case_number]);
        await client.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'AUTOMOD_TIMEOUT_REQUESTED',$3::jsonb)",[v.guild_id,deps.botId(),JSON.stringify({ case_number: record.case_number,target_user_id: v.user_id,rule_key: 'blocked_words',reason: record.reason })]);
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK'); throw error; }
    }
    if(record.duration_seconds!==settings.timeout_seconds || new Date(record.requested_until!).getTime()<=Date.now()) { await outcome(record,'rejected','RULE_CHANGED_OR_REQUEST_EXPIRED'); return; }
    const claim=await client.query("UPDATE moderation_cases SET action_status='applying',action_attempted_at=NOW() WHERE guild_id=$1 AND case_number=$2 AND action_status='pending' RETURNING case_number",[v.guild_id,record.case_number]);
    if(!claim.rowCount) throw new AutoModError('TIMEOUT_CLAIM_UNAVAILABLE');
    let status: 'applied'|'rejected'|'unconfirmed'='unconfirmed',code: string | null=null;
    try {
      const until=new Date(record.requested_until!).toISOString(); const response=await deps.applyTimeout(v.user_id,until,record.case_number);
      if(response.targetId===v.user_id && response.until && Math.abs(Date.parse(response.until)-Date.parse(until))<=1) status='applied'; else code='UNEXPECTED_RESPONSE';
    } catch(error) {
      if(error && typeof error==='object' && 'status' in error && [400,401,403,404].includes(Number(error.status))) { status='rejected'; code=`HTTP_${Number(error.status)}`; }
      else code='RESPONSE_UNAVAILABLE';
    }
    await outcome(record,status,code);
  } finally { if(locked) await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',[v.guild_id,v.user_id]); }
}

async function logViolation(client: PoolClient,old: Violation,deps: AutoModDependencies) {
  const v=(await client.query<Violation>('SELECT * FROM automod_violations WHERE guild_id=$1 AND message_id=$2',[old.guild_id,old.message_id])).rows[0]!;
  if(!v.log_channel_id || v.log_status!=='pending') return;
  const claim=await client.query("UPDATE automod_violations SET log_status='sending' WHERE guild_id=$1 AND message_id=$2 AND log_status='pending' RETURNING message_id",[v.guild_id,v.message_id]);
  if(!claim.rowCount) return;
  if(v.case_number) await client.query("UPDATE moderation_cases SET notification_claimed_at=NOW(),log_status='sending' WHERE guild_id=$1 AND case_number=$2",[v.guild_id,v.case_number]);
  const body: RESTPostAPIChannelMessageJSONBody={ allowed_mentions: { parse: [] },nonce: digest(`automod:${v.guild_id}:${v.message_id}`).slice(0,25),enforce_nonce: true,
    embeds: [{ title: 'Blocked-word violation',color: 0xe6ad73,description: 'Recorded automatic moderation results; the original message content is not copied here.',fields: [
      { name: 'Member ID',value: v.user_id },{ name: 'Channel ID',value: v.channel_id },{ name: 'Message ID',value: v.message_id },
      { name: 'Matched entries',value: v.matched_entries.map((entry) => escapeMarkdown(entry)).join(', ').slice(0,1000) },
      { name: 'Message removal',value: v.delete_status==='removed'?'Confirmed removed':'Not confirmed' },
      { name: 'Violations in rolling window',value: String(v.violation_count) },{ name: 'Timeout result',value: v.timeout_note },
      ...(v.case_number?[{ name: 'Case',value: String(v.case_number) }]:[]) ],timestamp: new Date(v.occurred_at).toISOString() }] };
  let status='unconfirmed',messageId: string | null=null;
  try { const id=await deps.sendLog(v.log_channel_id,body); if(/^\d{17,20}$/.test(id)) { status='sent'; messageId=id; } }
  catch(error) { if(error && typeof error==='object' && 'status' in error && [400,401,403,404].includes(Number(error.status))) status='failed'; }
  await client.query('BEGIN');
  try {
    await client.query('UPDATE automod_violations SET log_status=$3,log_message_id=$4 WHERE guild_id=$1 AND message_id=$2',[v.guild_id,v.message_id,status,messageId]);
    if(v.case_number) await client.query('UPDATE moderation_cases SET log_status=$3,log_message_id=$4 WHERE guild_id=$1 AND case_number=$2',[v.guild_id,v.case_number,status,messageId]);
    await client.query('INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)',[v.guild_id,deps.botId(),`AUTOMOD_LOG_${status.toUpperCase()}`,JSON.stringify({ rule_key: 'blocked_words',message_id: v.message_id,target_user_id: v.user_id,case_number: v.case_number,channel_id: v.log_channel_id,reason: 'Recorded the automatic moderation log delivery result.' })]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
}
