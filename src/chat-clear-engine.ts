import type { Pool } from 'pg';
import { readChatClearSettings } from './chat-clear-settings.js';

export type ClearMessage = { id: string; pinned: boolean; type: number };
export type ChatClearDependencies = {
  botId: () => string;
  canClear: (channelId: string) => Promise<boolean>;
  list: (channelId: string, before: string) => Promise<ClearMessage[]>;
  read: (channelId: string, messageId: string) => Promise<ClearMessage | null>;
  remove: (channelId: string, messageId: string) => Promise<void>;
  notify: (channelId: string, secondsBefore: number) => Promise<string>;
};
export type ChatClearRun = {
  run_id: string; guild_id: string; channel_id: string; revision: number; cutoff_id: string; cursor_id: string;
  status: string; removed_or_absent: number; preserved: number; note: string;
  started_at: Date | string; finished_at: Date | string | null; retry_at: Date | string;
};
export const deletableTypes = new Set([0,6,7,8,9,10,11,12,14,15,16,17,18,19,20,22,23,24,25,26,27,28,29,31,32,36,37,38,39,44,46]);
export function clearCutoff(at: number) { return ((BigInt(Math.floor(at)) - 1420070400000n) << 22n).toString(); }
const validMessage = (m: ClearMessage) => /^\d{17,20}$/.test(m.id) && typeof m.pinned === 'boolean' && Number.isInteger(m.type);

// Work is bounded to ten messages. The schedule row lock serializes changes, workers and restart recovery.
// A committed run records deletion intent before any Discord deletion; retries only revisit its fixed ID range.
export async function processChatClear(pool: Pick<Pool, 'connect'>, guildId: string, deps: ChatClearDependencies, now = Date.now()): Promise<boolean> {
  const db = await pool.connect(); let discard = false;
  try {
    await db.query('BEGIN');
    if (!(await db.query('SELECT 1 FROM chat_clear_settings WHERE guild_id=$1 FOR UPDATE SKIP LOCKED', [guildId])).rowCount) {
      await db.query('COMMIT'); return false;
    }
    const settings = await readChatClearSettings(db, guildId);
    let run = (await db.query<ChatClearRun>("SELECT * FROM chat_clear_runs WHERE guild_id=$1 AND status='running'", [guildId])).rows[0];
    if (run && (!settings.enabled || run.revision !== settings.revision || run.channel_id !== settings.channel_id)) {
      await db.query("UPDATE chat_clear_runs SET status='cancelled',finished_at=NOW(),note='Schedule changed or disabled' WHERE run_id=$1", [run.run_id]);
      await db.query('COMMIT'); return true;
    }
    if (!settings.enabled || !settings.channel_id) { await db.query('COMMIT'); return false; }
    if (!run) {
      if (!settings.next_run_at) { await db.query('COMMIT'); return false; }
      let due = new Date(settings.next_run_at).getTime();
      const notices = (await db.query<{ seconds_before: number; status: string }>(
        'SELECT seconds_before,status FROM chat_clear_notices WHERE guild_id=$1 AND revision=$2 AND scheduled_at=$3',
        [guildId, settings.revision, new Date(due)])).rows;
      const first = notices.find(n => n.seconds_before === 300);
      const remaining = due - now;
      const stage = !first && remaining <= 300000 ? 300
        : first?.status === 'sent' && remaining > 0 && remaining <= 10000 ? 10
        : first?.status === 'sent' && remaining > 10000 && remaining <= 60000 ? 60 : null;
      if (stage && !notices.some(n => n.seconds_before === stage)) {
        if (stage === 300 && remaining < 300000) {
          // Missing the warning window, including downtime, gives members a fresh five minutes.
          due = now + 300000;
          await db.query('UPDATE chat_clear_settings SET next_run_at=$2 WHERE guild_id=$1', [guildId, new Date(due)]);
        }
        await db.query(`INSERT INTO chat_clear_notices (guild_id,revision,scheduled_at,seconds_before) VALUES ($1,$2,$3,$4)`,
          [guildId, settings.revision, new Date(due), stage]);
        await db.query('COMMIT');
        // Claim before send: an unknown send outcome is displayed, never blindly reposted.
        let status = 'unconfirmed', id: string | null = null;
        try {
          const current = await readChatClearSettings(db, guildId);
          if (!current.enabled || current.revision !== settings.revision) status = 'cancelled';
          else if (await deps.canClear(settings.channel_id)) {
            id = await deps.notify(settings.channel_id, stage);
            if (!/^\d{17,20}$/.test(id)) throw new Error('INVALID_NOTICE');
            status = 'sent';
          }
        } catch { /* A lost response is not permission to send twice. */ }
        await db.query(`UPDATE chat_clear_notices SET status=$5,message_id=$6
          WHERE guild_id=$1 AND revision=$2 AND scheduled_at=$3 AND seconds_before=$4`,
          [guildId, settings.revision, new Date(due), stage, status, id]);
        return true;
      }
      // The initial warning must be confirmed before any deletion. Admins can reset an uncertain cycle by switching Off then On.
      if (first?.status !== 'sent' || due > now) { await db.query('COMMIT'); return false; }
      const cutoff = clearCutoff(now);
      run = (await db.query<ChatClearRun>(`INSERT INTO chat_clear_runs (guild_id,channel_id,revision,cutoff_id,cursor_id)
        VALUES ($1,$2,$3,$4,$4) RETURNING *`, [guildId, settings.channel_id, settings.revision, cutoff])).rows[0]!;
      await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'CHAT_CLEAR_STARTED',$3::jsonb)",
        [guildId, deps.botId(), JSON.stringify({ run_id: run.run_id, channel_id: run.channel_id, cutoff_id: cutoff, preserve_pins: true })]);
      await db.query('COMMIT'); return true;
    }
    if (new Date(run.retry_at).getTime() > now) { await db.query('COMMIT'); return false; }
    // Save progress even if a later message fails. A lost response never expands this sweep's cutoff.
    let complete = false;
    try {
      if (!await deps.canClear(run.channel_id)) throw new Error('CHANNEL_UNAVAILABLE');
      const messages = await deps.list(run.channel_id, run.cursor_id);
      if (!Array.isArray(messages) || messages.length > 100 || messages.some(m => !validMessage(m) || BigInt(m.id) >= BigInt(run!.cursor_id)) ||
          new Set(messages.map(m => m.id)).size !== messages.length) throw new Error('INVALID_MESSAGES');
      messages.sort((a,b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
      if (!messages.length) {
        complete = true;
      } else {
        for (const message of messages.slice(0, 10)) {
          // Preserve anything observed pinned in either the page or the immediate fresh lookup.
          if (message.pinned || !deletableTypes.has(message.type)) run.preserved++;
          else {
            const fresh = await deps.read(run.channel_id, message.id);
            if (fresh && (!validMessage(fresh) || fresh.id !== message.id)) throw new Error('INVALID_MESSAGE');
            if (fresh?.pinned || fresh && !deletableTypes.has(fresh.type)) run.preserved++;
            else { if (fresh) await deps.remove(run.channel_id, message.id); run.removed_or_absent++; }
          }
          run.cursor_id = message.id;
        }
        await db.query("UPDATE chat_clear_runs SET cursor_id=$2,removed_or_absent=$3,preserved=$4,note='Clearing' WHERE run_id=$1",
          [run.run_id, run.cursor_id, run.removed_or_absent, run.preserved]);
      }
    } catch {
      await db.query(`UPDATE chat_clear_runs SET cursor_id=$2,removed_or_absent=$3,preserved=$4,
        note='Paused; check channel permissions and Discord availability. Will retry.',retry_at=$5 WHERE run_id=$1`,
        [run.run_id, run.cursor_id, run.removed_or_absent, run.preserved, new Date(now + 60000)]);
    }
    if (complete) {
      await db.query("UPDATE chat_clear_runs SET status='completed',note='Sweep complete',finished_at=NOW() WHERE run_id=$1", [run.run_id]);
      // Skip missed ticks, rather than replaying many destructive catch-up sweeps after downtime.
      const previous = new Date(settings.next_run_at!).getTime(), interval = settings.interval_hours * 3600000;
      const next = previous + (Math.floor((now - previous) / interval) + 1) * interval;
      await db.query('UPDATE chat_clear_settings SET next_run_at=$2 WHERE guild_id=$1', [guildId, new Date(next)]);
      await db.query("INSERT INTO audit_events (guild_id,actor_id,event_type,details) VALUES ($1,$2,'CHAT_CLEAR_COMPLETED',$3::jsonb)",
        [guildId, deps.botId(), JSON.stringify({ run_id: run.run_id, channel_id: run.channel_id, removed_or_absent: run.removed_or_absent, preserved: run.preserved })]);
    }
    await db.query('COMMIT'); return true;
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { discard = true; }
    throw error;
  } finally { db.release(discard ? new Error('Chat clear connection unavailable') : undefined); }
}

export function startChatClearWorker(pool: Pick<Pool,'connect'>, guildId: string, deps: ChatClearDependencies, isReady: () => boolean) {
  let stopping = false, work: Promise<unknown> | undefined;
  function tick() {
    if (stopping || work || !isReady()) return;
    work = processChatClear(pool, guildId, deps).catch(() => console.error('Scheduled chat clear is waiting for saved work.')).finally(() => { work = undefined; });
  }
  const timer = setInterval(tick, 5000); timer.unref();
  return { stop: async () => { stopping = true; clearInterval(timer); await work; } };
}
