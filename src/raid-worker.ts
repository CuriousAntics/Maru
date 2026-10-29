import { escapeMarkdown } from 'discord.js';
import type { Pool } from 'pg';
import { RaidError, readRaidSettings, raidAuthorize } from './raid-settings.js';
import type { RaidDependencies } from './raid-settings.js';
import { raidExclusion } from './raid-plans.js';
import type { RaidRun, RaidTarget, RaidInviteRow } from './raid-plans.js';
import { logChannelId } from './server-settings.js';
import { deliverWarning } from './warnings.js';
import type { WarningCase, WarningDependencies } from './warnings.js';
import { digest } from './web-security.js';
import { durationLabel } from './case-labels.js';
export async function processRaidWork(pool: Pick<Pool,'query'|'connect'>,guildId: string,deps: RaidDependencies): Promise<boolean> {
 const db=await pool.connect(); let locked=false,memberLocked=false,tx=false,discard=false; let run: RaidRun | undefined,target: RaidTarget | undefined;
 async function begin() { await db.query('BEGIN'); tx=true; await db.query("SET LOCAL lock_timeout='5s'"); }
 async function commit() { await db.query('COMMIT'); tx=false; }
 async function audit(event: string,details: Record<string,unknown>) {
 await db.query('INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4::jsonb)',[guildId,run!.actor_id,event,JSON.stringify({ run_id: run!.run_id,...details })]);
 }
 async function authorize() {
 await begin(); await db.query('SELECT guild_id FROM guild_settings WHERE guild_id=$1 FOR UPDATE',[guildId]);
 const current=(await db.query<RaidRun>('SELECT * FROM raid_runs WHERE guild_id=$1 AND run_id=$2 FOR UPDATE',[guildId,run!.run_id])).rows[0]!;
 if(!['building','executing'].includes(current.status)) throw new RaidError('RUN_STOPPED'); run=current;
 const s=await readRaidSettings(db,guildId); if(!s.enabled || !deps.membersReady || s.revision!==run.settings_revision) throw new RaidError('STALE_SETTINGS');
 const deadline=run.status==='building'?run.expires_at:run.execution_until;
 if(!deadline || new Date(deadline).getTime()<=Date.now()) throw new RaidError('PREVIEW_EXPIRED');
 return raidAuthorize(db,guildId,run.actor_id,run.session_hash,deps);
 }
 async function stop(note: string) {
 await db.query("UPDATE raid_runs SET status='stopped',note=$3 WHERE guild_id=$1 AND run_id=$2 AND status='executing'",[guildId,run!.run_id,note]);
 await audit('RAID_STOPPED',{ reason: note });
 }
 async function targetOutcome(status: 'applied'|'rejected'|'unconfirmed',note: string) {
 await begin();
 await db.query('UPDATE raid_targets SET status=$4,note=$5 WHERE guild_id=$1 AND run_id=$2 AND user_id=$3',[guildId,run!.run_id,target!.user_id,status,note]);
 await db.query('UPDATE moderation_cases SET action_status=$3,action_completed_at=NOW(),action_error=$4 WHERE guild_id=$1 AND case_number=$2',[guildId,target!.case_number,status,status==='applied'?null:note]);
 await audit('RAID_BAN_RESULT',{ target_user_id: target!.user_id,case_number: target!.case_number,status,reason: note });
 if(status!=='applied') await stop('Ban rejected or unconfirmed; remaining actions stopped for review');
 await commit();
 }
 try {
 locked=(await db.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),731214) AS locked',[guildId])).rows[0]?.locked===true;
 if(!locked) return false;
 run=(await db.query<RaidRun>("SELECT * FROM raid_runs WHERE guild_id=$1 AND status IN ('building','executing') AND available_at<=NOW() ORDER BY created_at,run_id LIMIT 1",[guildId])).rows[0];
 if(!run) return false;
 if(run.status==='building') {
 await authorize(); await commit();
 const invites=(await db.query<RaidInviteRow>('SELECT * FROM raid_invites WHERE guild_id=$1 AND run_id=$2 ORDER BY code',[guildId,run.run_id])).rows;
 for(const i of invites) if(i.channel_id===null && i.status==='pending') {
 const source=await deps.readInvite(i.code);
 if(source && (source.guildId!==guildId || source.code!==i.code)) throw new RaidError('FOREIGN_OR_INVALID_INVITE');
 await authorize();
 await db.query('UPDATE raid_invites SET channel_id=$4,status=$5,note=$6 WHERE guild_id=$1 AND run_id=$2 AND code=$3',[guildId,run.run_id,i.code,source?.channelId ?? null,source?'pending':'missing',source?'Designated server invite; no deletion authorized yet':'Already absent at preview']); await commit();
 }
 const page=await deps.listMembers(run.cursor_id,run.actor_id);
 if(page.length>1000 || page.some((m) => !/^\d{17,20}$/.test(m.id) || BigInt(m.id)<=BigInt(run!.cursor_id) || !Number.isFinite(new Date(m.joinedAt).getTime())) || new Set(page.map((m) => m.id)).size!==page.length) throw new RaidError('INVALID_MEMBER_PAGE');
 await authorize();
 const count=Number((await db.query<{ count: string }>('SELECT count(*)::text AS count FROM raid_targets WHERE guild_id=$1 AND run_id=$2',[guildId,run.run_id])).rows[0]!.count);
 const matched=page.filter((m) => new Date(m.joinedAt)>=new Date(run!.starts_at) && new Date(m.joinedAt)<=new Date(run!.ends_at));
 if(count+matched.length>500 || run.scanned+page.length>100000) throw new RaidError('WINDOW_TOO_LARGE');
 for(const m of matched) {
 const exclusion=await raidExclusion(db,run,m,deps.botId());
 await db.query(`INSERT INTO raid_targets (guild_id,run_id,user_id,display_name,joined_at,eligible,exclusion) VALUES ($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT DO NOTHING`,[guildId,run.run_id,m.id,m.name.slice(0,100),new Date(m.joinedAt),!exclusion,exclusion]);
 }
 const cursor=page.reduce((id,m) => BigInt(m.id)>BigInt(id)?m.id:id,run.cursor_id),ready=page.length<1000;
 await db.query('UPDATE raid_runs SET cursor_id=$3,scanned=scanned+$4,status=$5,note=$6 WHERE guild_id=$1 AND run_id=$2',[guildId,run.run_id,cursor,page.length,ready?'ready':'building',ready?'Preview complete. Review exclusions and select targets; no actions have run':'Building preview; no actions authorized']);
 if(ready) await audit('RAID_PREVIEW_READY',{ reason: 'Full current-member scan completed; no external actions authorized' });
 await commit(); return true;
 }
 await authorize(); await commit();
 const invite=(await db.query<RaidInviteRow>("SELECT * FROM raid_invites WHERE guild_id=$1 AND run_id=$2 AND selected AND status IN ('pending','applying') ORDER BY code LIMIT 1",[guildId,run.run_id])).rows[0];
 if(invite) {
 const source=await deps.readInvite(invite.code);
 if(!source) {
 await authorize(); await db.query("UPDATE raid_invites SET status='missing',note='Invite is absent; no further deletion requested' WHERE guild_id=$1 AND run_id=$2 AND code=$3",[guildId,run.run_id,invite.code]);
 await audit('RAID_INVITE_RESULT',{ invite_code: invite.code,status: 'missing',reason: 'Invite absence confirmed' }); await commit(); return true;
 }
 if(source.guildId!==guildId || source.channelId!==invite.channel_id || source.code!==invite.code) throw new RaidError('INVITE_CHANGED');
 if(invite.status==='applying') {
 await begin(); await db.query("UPDATE raid_invites SET status='unconfirmed',note='Interrupted deletion; invite still exists. Not retried automatically' WHERE guild_id=$1 AND run_id=$2 AND code=$3",[guildId,run.run_id,invite.code]); await stop('Invite revocation unconfirmed; bans have not started'); await commit(); return true;
 }
 if(!await deps.canRevoke(run.actor_id,source.channelId)) throw new RaidError('INVITE_PERMISSION');
 await authorize();
 await db.query("UPDATE raid_invites SET status='applying',note='Deletion claimed before dispatch' WHERE guild_id=$1 AND run_id=$2 AND code=$3",[guildId,run.run_id,invite.code]);
 await audit('RAID_INVITE_CLAIMED',{ invite_code: invite.code,reason: 'Confirmed designated invite deletion claimed' }); await commit();
 let status='unconfirmed';
 try { await deps.revokeInvite(invite.code,run.run_id,source.channelId); status='deleted'; }
 catch(e) { if(explicitRejection(e)) status='rejected'; }
 if(status==='unconfirmed') { try { if(!await deps.readInvite(invite.code)) status='missing'; } catch { /* Remain unconfirmed. */ } }
 await begin(); await db.query('UPDATE raid_invites SET status=$4,note=$5 WHERE guild_id=$1 AND run_id=$2 AND code=$3',[guildId,run.run_id,invite.code,status,['deleted','missing'].includes(status)?'Invite deletion or absence confirmed':'Deletion rejected or unconfirmed; review required']);
 await audit('RAID_INVITE_RESULT',{ invite_code: invite.code,status,reason: 'Recorded designated invite revocation result' });
 if(!['deleted','missing'].includes(status)) await stop('Invite deletion rejected or unconfirmed; bans have not started');
 await commit(); return true;
 }
 if((await db.query("SELECT 1 FROM raid_invites WHERE guild_id=$1 AND run_id=$2 AND selected AND status NOT IN ('deleted','missing')",[guildId,run.run_id])).rowCount) throw new RaidError('INVITE_UNCONFIRMED');
 target=(await db.query<RaidTarget>("SELECT * FROM raid_targets WHERE guild_id=$1 AND run_id=$2 AND selected AND status IN ('pending','applying') ORDER BY joined_at,user_id LIMIT 1",[guildId,run.run_id])).rows[0];
 if(!target) {
 await authorize(); await db.query("UPDATE raid_runs SET status='complete',note='All selected actions processed; review per-invite and per-member outcomes' WHERE guild_id=$1 AND run_id=$2",[guildId,run.run_id]);
 await audit('RAID_COMPLETE',{ reason: 'Selected invite and member work completed' }); await commit(); return true;
 }
 memberLocked=(await db.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',[guildId,target.user_id])).rows[0]?.locked===true;
 if(!memberLocked) return false;
 const marker=() => `Maru raid ${run!.run_id} case #${target!.case_number}`;
 if(target.status==='applying') {
 const current=await deps.readBan(target.user_id);
 await targetOutcome(current?.reason===marker()?'applied':'unconfirmed',current?.reason===marker()?'Matching raid ban verified after interruption':'Interrupted ban cannot be confirmed; never automatically replayed'); return true;
 }
 await authorize();
 const prior=await deps.readBan(target.user_id),member=await deps.readMember(target.user_id,run.actor_id);
 let exclusion=member?await raidExclusion(db,run,member,deps.botId()):'Member left; no departed-user bulk ban';
 if(member && new Date(member.joinedAt).getTime()!==new Date(target.joined_at).getTime()) exclusion='Membership changed since preview; left or rejoined';
 if(prior) exclusion='Already banned; no replacement ban or additional deletion';
 if(exclusion) {
 await db.query("UPDATE raid_targets SET status='skipped',note=$4 WHERE guild_id=$1 AND run_id=$2 AND user_id=$3",[guildId,run.run_id,target.user_id,exclusion]);
 await audit('RAID_TARGET_SKIPPED',{ target_user_id: target.user_id,reason: exclusion }); await commit(); return true;
 }
 const actor=await raidAuthorize(db,guildId,run.actor_id,run.session_hash,deps);
 const settings=(await db.query<{ settings: Record<string,unknown> }>('SELECT settings FROM guild_settings WHERE guild_id=$1',[guildId])).rows[0]!.settings,channel=logChannelId(settings);
 if(!channel) throw new RaidError('LOG_REQUIRED');
 const number=(await db.query<{ last_case_number: number }>(`INSERT INTO guild_case_counters (guild_id,last_case_number) VALUES ($1,1)
 ON CONFLICT (guild_id) DO UPDATE SET last_case_number=guild_case_counters.last_case_number+1 RETURNING last_case_number`,[guildId])).rows[0]!.last_case_number;
 await db.query(`INSERT INTO moderation_cases (guild_id,case_number,request_id,action,actor_id,target_user_id,reason,guild_name,log_channel_id,origin,dm_status,action_status,delete_message_seconds,action_attempted_at)
 VALUES ($1,$2,$3,'ban',$4,$5,$6,$7,$8,'raid','skipped','applying',$9,NOW())`,[guildId,number,`raid:${run.run_id}:${target.user_id}`,run.actor_id,target.user_id,run.reason,actor.guildName.slice(0,100),channel,run.delete_seconds]);
 await db.query("UPDATE raid_targets SET status='applying',case_number=$4,note='Ban claimed before dispatch; no DM sent' WHERE guild_id=$1 AND run_id=$2 AND user_id=$3",[guildId,run.run_id,target.user_id,number]); target.case_number=number;
 await audit('RAID_BAN_CLAIMED',{ target_user_id: target.user_id,case_number: number,delete_seconds: run.delete_seconds,reason: run.reason }); await commit();
 let status: 'applied'|'rejected'|'unconfirmed'='unconfirmed';
 try { await deps.ban(target.user_id,run.delete_seconds,marker()); status='applied'; }
 catch(e) { if(explicitRejection(e)) status='rejected'; }
 if(status==='unconfirmed') { try { if((await deps.readBan(target.user_id))?.reason===marker()) status='applied'; } catch { /* Never retry PUT. */ } }
 await targetOutcome(status,status==='applied'?'Raid ban confirmed':status==='rejected'?'Discord rejected the raid ban':'Ban outcome unconfirmed; staff review required');
 return true;
 } catch(e) {
 if(tx) { try { await db.query('ROLLBACK'); tx=false; } catch { discard=true; } }
 if(run && !discard) {
 const terminal=e instanceof RaidError;
 await begin();
 await db.query(`UPDATE raid_runs SET status=CASE WHEN $3 THEN CASE WHEN status='building' THEN 'failed' ELSE 'stopped' END ELSE status END,
 note=$4,available_at=NOW()+INTERVAL '15 seconds' WHERE guild_id=$1 AND run_id=$2 AND status IN ('building','executing')`,[guildId,run.run_id,terminal,e instanceof RaidError?e.code:'Temporary Discord or database failure; saved work will recheck before continuing']);
 await audit(terminal?'RAID_HALTED':'RAID_RETRY_PENDING',{ reason: e instanceof RaidError?e.code:'Temporary service failure; no blind action retry' }); await commit();
 }
 return false;
 } finally {
 if(tx) { try { await db.query('ROLLBACK'); } catch { discard=true; } }
 if(memberLocked && target) { try { await db.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',[guildId,target.user_id]); } catch { discard=true; } }
 if(locked) { try { await db.query('SELECT pg_advisory_unlock(hashtext($1),731214)',[guildId]); } catch { discard=true; } }
 db.release(discard?new Error('Raid worker connection or lock unavailable'):undefined);
 }
}
function explicitRejection(e: unknown) { return !!e && typeof e==='object' && 'status' in e && [400,401,403,404].includes(Number(e.status)); }
export async function deliverRaidLog(pool: Pick<Pool,'query'|'connect'>,guildId: string,deps: WarningDependencies) {
 const record=(await pool.query<WarningCase>(`SELECT * FROM moderation_cases WHERE guild_id=$1 AND origin='raid' AND notification_claimed_at IS NULL
 AND action_status IN ('applied','rejected','unconfirmed') ORDER BY case_number LIMIT 1`,[guildId])).rows[0];
 if(!record) return;
 await deliverWarning(pool,record,deps,() => ({ allowed_mentions: { parse: [] },nonce: digest(`raid-log:${guildId}:${record.case_number}`).slice(0,25),enforce_nonce: true,
 embeds: [{ title: `Raid response · Case #${record.case_number}`,description: 'Historical ban result. No member DM is sent during raid response.',fields: [{ name: 'Member ID',value: record.target_user_id },{ name: 'Staff ID',value: record.actor_id },{ name: 'Action',value: record.action_status },{ name: 'Reason',value: escapeMarkdown(record.reason) },{ name: 'Requested history deletion',value: record.delete_message_seconds===0?'Keep history':durationLabel(record.delete_message_seconds!) }] }] }));
}
export function startRaidWorker(pool: Pick<Pool,'query'|'connect'>,guildId: string,deps: RaidDependencies,notifications: WarningDependencies,isReady: () => boolean) {
 let stopping=false,work: Promise<void> | undefined;
 const timer=setInterval(() => {
 if(stopping || !isReady() || work) return;
 work=(async () => { const due=await pool.query("SELECT 1 FROM raid_runs WHERE guild_id=$1 AND status IN ('building','executing') AND available_at<=NOW() LIMIT 1",[guildId]); if(due.rowCount) await processRaidWork(pool,guildId,deps); await deliverRaidLog(pool,guildId,notifications); })().catch(() => console.error('Raid response work is saved; review its status after service recovery.')).finally(() => { work=undefined; });
 },1000); timer.unref();
 return { stop: async () => { stopping=true; clearInterval(timer); await work; } };
}
