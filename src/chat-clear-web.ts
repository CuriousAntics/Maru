import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { ChatClearError, readChatClearSettings, saveChatClearSettings } from './chat-clear-settings.js';
import type { ChatClearResources } from './chat-clear-settings.js';
import type { ChatClearRun } from './chat-clear-engine.js';
import { chatClearProof, equal, escapeHtml as e, logoutProof } from './web-security.js';
import { layout } from './web-pages.js';
export async function handleChatClearPage(request: IncomingMessage, o: {
  pool: Pick<Pool,'query'|'connect'>; guildId: string; actorId: string; token: string; origin: string; access: 'admin'|'moderator';
  readRoles: (id: string) => Promise<string[] | null>; readResources: () => Promise<ChatClearResources>;
}, views: { html: (status: number, render: (nonce: string) => string) => void; redirect: (path: string) => void }) {
  let error: string | undefined, status = 200;
  if (request.method === 'POST') try {
    if (o.access !== 'admin') throw new ChatClearError('ADMIN_REQUIRED');
    if (request.headers.origin !== o.origin || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded')
      throw new ChatClearError('REQUEST_REJECTED');
    let body = '';
    for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body) > 8192) throw new ChatClearError('INVALID_INPUT'); }
    const p = new URLSearchParams(body), keys = ['csrf','revision','enabled','channel','hours','reason'];
    if (keys.some(k => p.getAll(k).length !== 1) || [...p.keys()].some(k => !keys.includes(k)) ||
        !/^(0|[1-9]\d{0,9})$/.test(p.get('revision')!) || !/^[1-9]\d{0,2}$/.test(p.get('hours')!) ||
        !['true','false'].includes(p.get('enabled')!)) throw new ChatClearError('INVALID_INPUT');
    const revision = Number(p.get('revision'));
    if (!equal(p.get('csrf')!, chatClearProof(o.token, revision))) throw new ChatClearError('REQUEST_REJECTED');
    await saveChatClearSettings(o.pool, { guildId: o.guildId, actorId: o.actorId, token: o.token, revision,
      enabled: p.get('enabled') === 'true', channelId: p.get('channel') || null, intervalHours: Number(p.get('hours')),
      reason: p.get('reason')!, readRoles: o.readRoles, readResources: o.readResources });
    views.redirect('/chat-clear'); return;
  } catch (err) {
    if (!(err instanceof ChatClearError)) throw err;
    status = ['ADMIN_REQUIRED','SESSION_EXPIRED','REQUEST_REJECTED'].includes(err.code) ? 403 : 409;
    error = ({ ADMIN_REQUIRED: 'Only Admins and Mods with full access may change the schedule.',
      SESSION_EXPIRED: 'Sign in again before saving.', REQUEST_REJECTED: 'Reload and use this page’s save button.',
      STALE_SETTINGS: 'Settings changed. Reload before saving.', BUSY: 'A sweep is processing messages. Try saving again shortly.',
      CHANNEL_UNAVAILABLE: 'Choose a voice channel where Maru has View Channel, Read Message History, Send Messages, and Manage Messages.',
      INVALID_INPUT: 'Choose a voice channel, a whole number of hours from 1 to 720, and a reason from 1 to 500 characters.',
    } as Record<string,string>)[err.code] ?? 'Settings could not be saved.';
  }
  const s = await readChatClearSettings(o.pool, o.guildId), resources = await o.readResources();
  const runs = (await o.pool.query<ChatClearRun>('SELECT * FROM chat_clear_runs WHERE guild_id=$1 ORDER BY run_id DESC LIMIT 20', [o.guildId])).rows;
  const notices = (await o.pool.query<{ seconds_before: number; status: string }>(
    'SELECT seconds_before,status FROM chat_clear_notices WHERE guild_id=$1 AND revision=$2 AND scheduled_at=$3 ORDER BY seconds_before DESC',
    [o.guildId, s.revision, s.next_run_at])).rows;
  const time = (value: Date | string | null) => value ? e(new Date(value).toISOString()) : 'None';
  views.html(status, nonce => layout('Scheduled chat clear', `<div class="hero"><div class="eyebrow">Channel housekeeping</div><h1>Scheduled chat clear</h1>
    <p>Clear a voice channel’s text chat every ${s.interval_hours} hours. Pinned messages are preserved.</p></div>
    ${error ? `<div class="notice">${e(error)}</div>` : ''}<div class="notice">${s.enabled ? 'On' : 'Off'} · Next clear (UTC): ${time(s.next_run_at)}</div>
    <section class="card"><h2>Clear schedule</h2><p>Each sweep removes all unpinned messages present when it starts, including messages from staff and bots. Messages posted during the sweep wait for the next one. Voice participants stay connected.</p>
    <p>Countdown notices are posted about 5 minutes, 1 minute, and 10 seconds before clearing, without pings. If the first warning was missed during downtime, a fresh five-minute countdown starts when Maru returns. An unconfirmed first warning pauses deletion; switch Off and save, then On and save to reset the schedule.</p>
    <p>Deleted messages cannot be restored. Threads and other channels are not included. Discord system messages that cannot be deleted are preserved.</p>
    <form method="post" action="/chat-clear"><input type="hidden" name="csrf" value="${e(chatClearProof(o.token, s.revision))}"><input type="hidden" name="revision" value="${s.revision}">
    <fieldset${o.access === 'admin' ? '' : ' disabled'}><legend>Scheduled clearing</legend><label for="clear-enabled">Schedule</label><select id="clear-enabled" name="enabled"><option value="false"${!s.enabled ? ' selected' : ''}>Off</option><option value="true"${s.enabled ? ' selected' : ''}>On — delete unpinned messages on schedule</option></select>
    <label for="clear-channel">Voice channel text chat</label><select id="clear-channel" name="channel"><option value="">Choose a voice channel</option>${resources.channels.map(c => `<option value="${e(c.id)}"${c.id === s.channel_id ? ' selected' : ''}>${e(c.name)}${c.usable ? '' : ' (missing permissions)'}</option>`).join('')}${s.channel_id && !resources.channels.some(c => c.id === s.channel_id) ? `<option value="${e(s.channel_id)}" selected>Unavailable channel ${e(s.channel_id)}</option>` : ''}</select>
    <label for="clear-hours">Clear every (hours)</label><input id="clear-hours" type="number" name="hours" min="1" max="720" step="1" required value="${s.interval_hours}">
    <p>Default: 6 hours. Enabling or changing this schedule starts a full new interval. Saving unchanged settings keeps the existing deadline. Switching Off stops further batches; a deletion already dispatched may finish.</p>
    <label for="clear-reason">Reason for this change</label><input id="clear-reason" name="reason" required maxlength="500"><button>Save clear schedule</button></fieldset></form></section>
    <section class="card"><h2>Current countdown</h2>${notices.length ? notices.map(n => `<p>${n.seconds_before === 300 ? '5 minutes' : n.seconds_before === 60 ? '1 minute' : '10 seconds'}: ${e(n.status)}</p>`).join('') : '<p>No countdown notices for the next clear yet.</p>'}</section>
    <h2>Recent sweeps</h2><div class="table-wrap"><table><thead><tr><th>Channel / started UTC</th><th>Status</th><th>Removed or already absent</th><th>Preserved</th></tr></thead><tbody>${runs.map(r => `<tr><td>${e(r.channel_id)}<div>${time(r.started_at)}</div></td><td>${e(r.status)} · ${e(r.note)}</td><td>${r.removed_or_absent}</td><td>${r.preserved}</td></tr>`).join('') || '<tr><td colspan="4">No sweeps recorded.</td></tr>'}</tbody></table></div>`, nonce, logoutProof(o.token)));
}
