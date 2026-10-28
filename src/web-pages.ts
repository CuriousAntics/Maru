import type { WarningCase } from './warnings.js';
import type { CaseFilter, CaseChangeEvent } from './case-history.js';
import { caseHistoryUrl } from './case-history.js';
import { actionLabel, actionResultLabel, durationLabel } from './case-labels.js';
import { deliveryLabel } from './handle-warning.js';
import type { LogChannel } from './server-settings.js';
import { escapeHtml } from './web-security.js';

const css = `
:root{color-scheme:dark;font-family:Inter,Segoe UI,system-ui,sans-serif;background:#101315;color:#eef0eb}
*{box-sizing:border-box}body{margin:0}a{color:inherit}.shell{max-width:1160px;margin:auto;padding:32px 30px 60px}
header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #303636;padding-bottom:23px;gap:20px}
.brand{display:flex;align-items:center;gap:12px;text-decoration:none;font-size:22px;font-weight:700;letter-spacing:-.7px}
.mark{display:grid;place-items:center;width:37px;height:37px;border-radius:12px;background:#e6ad73;color:#171818}
.eyebrow{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a7b2a7;margin:0 0 14px}
.hero{padding:54px 0 30px}.hero h1{font-size:clamp(30px,4vw,46px);letter-spacing:-1.6px;margin:0 0 12px;font-weight:600}
p{color:#acb5b2;line-height:1.65;max-width:690px}.pill{font-size:12px;color:#cadbbf;border:1px solid #40503f;border-radius:24px;padding:7px 12px;white-space:nowrap}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:10px 0 36px}.card{border:1px solid #333b3a;border-radius:16px;background:#191e20;padding:23px;min-width:0}
.label{color:#a7b2ae;font-size:12px;margin-bottom:13px}.value{font-size:24px;letter-spacing:-.6px}.small{font-size:12px;color:#9ca8a3;overflow-wrap:anywhere;margin-top:10px}
.section-title{display:flex;align-items:center;justify-content:space-between;gap:15px;margin:0 0 15px}.section-title h2{font-size:19px;font-weight:500;margin:0}.muted{color:#96a39d;font-size:12px}
.table-wrap{overflow:auto;border:1px solid #333b3a;border-radius:16px}table{width:100%;border-collapse:collapse;background:#191e20;font-size:13px;text-align:left}
th{padding:16px 20px;color:#aab4ad;font-weight:500;font-size:11px;letter-spacing:.7px;text-transform:uppercase;background:#202728}
td{padding:18px 20px;border-top:1px solid #303837;vertical-align:top;overflow-wrap:anywhere;max-width:300px}.mono{font-family:Consolas,monospace;font-size:12px}
button,.button{display:inline-block;background:#e6ad73;color:#191b1b;border:0;border-radius:9px;padding:12px 18px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none}
button.secondary{background:transparent;color:#c7d0cb;border:1px solid #414c47;padding:9px 15px}form{margin:0}
label{display:block;margin:20px 0 8px}input:not([type="hidden"]),select,textarea{width:100%;max-width:650px;background:#101315;color:#eef0eb;border:1px solid #53615a;border-radius:8px;padding:12px;font:inherit}textarea{display:block;min-height:90px;margin-bottom:20px}nav{display:flex;gap:20px;margin-top:24px}\n.notice{padding:18px 20px;border:1px solid #424a3c;border-radius:12px;color:#c0cbb5;background:#1d231e;margin:24px 0;font-size:13px;line-height:1.6}
.case-reason{white-space:pre-wrap;overflow-wrap:anywhere;max-width:none;color:#eef0eb}.status{display:inline-block;padding:5px 9px;border:1px solid #49544f;border-radius:7px;font-size:12px}.pagination{display:flex;gap:22px;margin-top:24px;flex-wrap:wrap}.filter{margin-bottom:26px}.filter button{margin:12px 14px 0 0}nav{flex-wrap:wrap}hr{border:0;border-top:1px solid #333b3a;margin:25px 0}\nfooter{font-size:12px;color:#8b9890;padding-top:30px}.empty{padding:32px;color:#9fada5}.login{max-width:720px}.login .card{margin-top:12px;padding:30px}.tag{color:#e6bd91}
.channel-choices{margin:24px 0 8px;max-width:650px;max-height:320px;overflow:auto;border:1px solid #53615a;border-radius:8px;padding:16px}.channel-choice{display:flex;align-items:center;margin:10px 0;font-size:14px}.channel-choice input[type="checkbox"]{width:auto;margin:0 12px 0 0;flex:none}
@media(max-width:700px){.shell{padding:24px 18px}.grid{grid-template-columns:1fr}.hero{padding-top:38px}td,th{padding:13px}.pill{font-size:10px}header{gap:10px}}
`;

export function layout(title: string, body: string, nonce: string, logout?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Maru</title><style nonce="${nonce}">${css}</style></head><body><main class="shell"><header><a class="brand" href="/"><span class="mark">M</span>Maru<span class="pill">Development workspace</span></a>${logout ? `<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${escapeHtml(logout)}"><button class="secondary" type="submit">Sign out</button></form>` : '<span class="muted">Staff dashboard</span>'}</header>${logout ? '<nav aria-label="Staff navigation"><a href="/dashboard">Overview</a><a href="/cases">Moderation cases</a><a href="/settings">Server settings</a><a href="/starboards">Starboard</a><a href="/automod">AutoMod</a><a href="/honeypot">Honeypot</a><a href="/community">Community roles</a></nav>' : ''}${body}<footer>Maru · Community management</footer></main></body></html>`;
}

export function loginPage(nonce: string): string {
  return layout('Sign in', `<div class="hero login"><div class="eyebrow">Your community, in view</div><h1>A home for your server staff.</h1><p>Sign in with Discord to view your Maru access and recent staff activity.</p></div><section class="card login"><h2>Welcome to Maru</h2><p>Access is limited to configured staff in Maru Development. Your current Discord roles determine what you can access.</p><a class="button" href="/auth/discord">Continue with Discord</a><p class="small">Sign-in requests your basic Discord profile. No email access is requested.</p></section>`, nonce);
}

export function messagePage(title: string, message: string, nonce: string): string {
  return layout(title, `<div class="hero"><div class="eyebrow">Staff dashboard</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="button" href="/">Back to sign in</a></div>`, nonce);
}

export type AuditRow = {
  event_id: string;
  event_type: string;
  actor_id: string;
  details: Record<string, unknown>;
  created_at: Date;
};

export function dashboardPage(data: {
  name: string; access: 'admin' | 'moderator'; guildId: string; botReady: boolean;
  events: AuditRow[]; csrf: string; nonce: string;
}): string {
  const rows = data.events.map((event) => {
    const reason = typeof event.details.reason === 'string' ? event.details.reason : '—';
    const settingChange = event.event_type === 'SERVER_SETTINGS_CHANGED' && event.details.setting === 'moderation_log_channel_id'
      ? `<div class="small mono">Moderation log channel: ${escapeHtml(event.details.previous_channel_id ?? 'Not configured')} → ${escapeHtml(event.details.channel_id ?? 'Not configured')}</div>` : '';
    const caseLabel = Number.isInteger(event.details.case_number) && Number(event.details.case_number) > 0 && Number(event.details.case_number) <= 2147483647
      ? `<div class="small"><a href="/cases/${event.details.case_number}">Case #${escapeHtml(event.details.case_number)}</a></div>` : '';
    const boardLink = ['STARBOARD_CREATED','STARBOARD_UPDATED'].includes(event.event_type) && typeof event.details.board_id === 'string' && /^[0-9a-f-]{36}$/.test(event.details.board_id)
      ? `<div class="small"><a href="/starboards/${event.details.board_id}">View board</a></div>` : '';
    const target = event.details.target_user_id ?? event.details.role_id ?? event.details.channel_id ?? event.details.board_id ?? '—';
    return `<tr><td><span class="tag">${escapeHtml(event.event_type.replaceAll('_', ' ').toLowerCase())}</span><div class="small">${escapeHtml(reason)}</div>${settingChange}${caseLabel}${boardLink}</td><td class="mono">${escapeHtml(event.actor_id)}</td><td class="mono">${escapeHtml(target)}</td><td>${escapeHtml(new Date(event.created_at).toISOString().replace('T', ' ').slice(0, 19))}</td></tr>`;
  }).join('');
  return layout('Overview', `<div class="hero"><div class="eyebrow">Workspace overview</div><h1>Welcome back, ${escapeHtml(data.name)}.</h1><p>Your access and the latest staff activity, together in one place.</p></div><div class="grid"><section class="card"><div class="label">Your Maru access</div><div class="value">${data.access === 'admin' ? 'Admin' : 'Moderator'}</div><div class="small">Verified against current Discord roles</div></section><section class="card"><div class="label">Bot connection</div><div class="value">${data.botReady ? 'Connected' : 'Reconnecting'}</div><div class="small">Database connection verified</div></section><section class="card"><div class="label">Server</div><div class="value">Maru Development</div><div class="small mono">${escapeHtml(data.guildId)}</div></section></div><div class="section-title"><h2>Recent staff activity</h2><span class="muted">Latest 20 events · UTC</span></div><div class="table-wrap"><table><thead><tr><th>Event and reason</th><th>Actor</th><th>Target</th><th>Time UTC</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty">No staff activity recorded yet.</td></tr>'}</tbody></table></div><div class="notice"><a href="/settings">Server settings</a> · Use <strong>/staff-access</strong> in Discord to manage individual grants.</div>`, data.nonce, data.csrf);
}

export function settingsPage(data: {
  access: 'admin' | 'moderator'; channelId: string | null; channels: LogChannel[];
  csrf: string; logoutCsrf: string; nonce: string; error?: string; notice?: string; testRequestId?: string; testCsrf?: string;
}): string {
  const current = data.channels.find((channel) => channel.id === data.channelId);
  const currentLabel = current ? `#${current.name}` : data.channelId ? `Unavailable channel (${data.channelId})` : 'Not configured';
  const choices = data.channels.map((channel) => `<option value="${escapeHtml(channel.id)}"${channel.id === data.channelId ? ' selected' : ''}${!channel.usable ? ' disabled' : ''}>#${escapeHtml(channel.name)}${channel.usable ? '' : ' (missing bot permissions)'}</option>`).join('');
  const missing = data.channelId && !current ? `<option value="${escapeHtml(data.channelId)}" selected disabled>${escapeHtml(currentLabel)}</option>` : '';
  return layout('Server settings', `<div class="hero"><div class="eyebrow">Server configuration</div><h1>Server settings</h1><p>Choose where Maru will send moderation logs.</p></div>
    ${data.notice ? `<div class="notice" role="status">${escapeHtml(data.notice)}</div>` : ''}
    ${data.error ? `<div class="notice" role="alert">${escapeHtml(data.error)} <a href="/settings">Reload settings</a></div>` : `<section class="card"><h2>Moderation log channel</h2><p>Current destination: <strong>${escapeHtml(currentLabel)}</strong></p>
    <p class="small">This saves the destination for upcoming moderation features. Automatic moderation logs are not active yet. You can send a test embed to verify delivery. Settings changes are recorded under Recent staff activity.</p>
    ${data.access === 'admin' ? `<form method="post" action="/settings"><input type="hidden" name="csrf" value="${escapeHtml(data.csrf)}"><input type="hidden" name="previous_channel_id" value="${escapeHtml(data.channelId ?? '')}"><label for="channel_id">Destination channel</label><select id="channel_id" name="channel_id"><option value=""${data.channelId === null ? ' selected' : ''}>Not configured</option>${missing}${choices}</select><p class="small">Maru needs View Channel, Send Messages, and Embed Links. Only text and announcement channels are supported.</p><label for="reason">Reason for change</label><textarea id="reason" name="reason" required maxlength="500" placeholder="Why are you changing the log destination?"></textarea><button type="submit">Save settings</button></form>${data.channelId && current?.usable && data.testRequestId && data.testCsrf ? `<hr><h3>Test delivery</h3><p>This sends one test embed to the saved destination above. Save any destination changes first. No moderation action is performed.</p><form method="post" action="/settings/test-log"><input type="hidden" name="csrf" value="${escapeHtml(data.testCsrf)}"><input type="hidden" name="request_id" value="${escapeHtml(data.testRequestId)}"><input type="hidden" name="channel_id" value="${escapeHtml(data.channelId)}"><button class="secondary" type="submit">Send test log</button></form>` : '<p class="small">Save an available log channel to enable test delivery.</p>'}` : '<p>Only Admins and Mods granted full access can change these settings.</p>'}</section>`}`, data.nonce, data.logoutCsrf);
}

function caseTime(value: Date): string {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 19);
}
function statusLabel(status: WarningCase['dm_status'], action?: WarningCase['action'], origin?: WarningCase['origin']): string {
  return `<span class="status">${escapeHtml(action === 'unban' ? 'Not sent for unbans' : origin === 'automod' ? 'Not sent for automatic moderation' : deliveryLabel(status))}</span>`;
}
export function caseHistoryPage(data: {
  cases: WarningCase[]; hasOlder: boolean; filter: CaseFilter; csrf: string; nonce: string; error?: string;
}): string {
  const rows = data.cases.map((record) => `<tr><td><a href="/cases/${record.case_number}">Case #${record.case_number}</a><div class="small">${escapeHtml(actionLabel(record.action))} · ${record.action !== 'warning' ? 'Recorded' : record.state === 'void' ? 'Voided' : 'Active'}</div>${record.action !== 'warning' ? `<div class="small">Action: ${escapeHtml(actionResultLabel(record.action_status))}</div>` : ''}<div class="small">${escapeHtml(record.reason.slice(0, 100))}${record.reason.length > 100 ? '…' : ''}</div></td><td class="mono"><a href="${escapeHtml(caseHistoryUrl({ memberId: record.target_user_id }))}">${escapeHtml(record.target_user_id)}</a></td><td class="mono">${escapeHtml(record.actor_id)}</td><td>${statusLabel(record.dm_status, record.action, record.origin)}<div class="small">Log: ${escapeHtml(deliveryLabel(record.log_status))}</div></td><td>${caseTime(record.created_at)}</td></tr>`).join('');
  const last = data.cases.at(-1);
  const older = data.hasOlder && last ? `<a href="${escapeHtml(caseHistoryUrl({ memberId: data.filter.memberId, before: last.case_number }))}">Older cases →</a>` : '';
  return layout('Moderation cases', `<div class="hero"><div class="eyebrow">Moderation history</div><h1>Moderation cases</h1><p>Saved warnings and their delivery results. Times are shown in UTC.</p></div>
    <form class="card filter" method="get" action="/cases"><label for="member">Filter by member ID</label><input type="text" id="member" name="member" inputmode="numeric" pattern="[0-9]{17,20}" maxlength="20" value="${escapeHtml(data.filter.memberId ?? '')}" placeholder="Discord member ID"><div><button type="submit">Apply filter</button><a href="/cases">Clear filter</a></div></form>
    ${data.error ? `<div class="notice" role="alert">${escapeHtml(data.error)} <a href="/cases">Back to cases</a></div>` :
      `<div class="section-title"><h2>${data.filter.memberId ? 'Member history' : 'Latest cases'}</h2><span class="muted">Up to 20 cases per page</span></div><div class="table-wrap"><table><thead><tr><th>Case and reason</th><th>Member ID</th><th>Staff ID</th><th>DM and log delivery</th><th>Created UTC</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="empty">${data.filter.before ? 'No older cases found.' : data.filter.memberId ? 'No cases found for this member.' : 'No moderation cases recorded yet.'}</td></tr>`}</tbody></table></div><div class="pagination">${data.filter.before ? `<a href="${escapeHtml(caseHistoryUrl({ memberId: data.filter.memberId }))}">Newest cases</a>` : ''}${older}</div>`}`, data.nonce, data.csrf);
}

export function caseDetailPage(data: { record: WarningCase; csrf: string; nonce: string; changes: CaseChangeEvent[];
  canChange: boolean; correctCsrf: string; voidCsrf: string }): string {
  const record = data.record;
  return layout(`Case #${record.case_number}`, `<div class="hero"><div class="eyebrow">Moderation case</div><h1>Case #${record.case_number}</h1><p>${escapeHtml(actionLabel(record.action))} · <strong>${record.action !== 'warning' ? 'Recorded' : record.state === 'void' ? 'Voided' : 'Active'}</strong> · Created ${caseTime(record.created_at)} UTC</p><p class="small">Revision ${record.revision} · Updated ${caseTime(record.updated_at)} UTC${record.last_changed_by ? ` · By ${escapeHtml(record.last_changed_by)}` : ''}</p></div>
    <div class="grid"><section class="card"><div class="label">Member ID</div><div class="mono">${escapeHtml(record.target_user_id)}</div><p class="small"><a href="${escapeHtml(caseHistoryUrl({ memberId: record.target_user_id }))}">View member history</a></p></section><section class="card"><div class="label">Staff ID</div><div class="mono">${escapeHtml(record.actor_id)}</div></section><section class="card"><div class="label">Server</div><div>${escapeHtml(record.guild_name)}</div><div class="small mono">${escapeHtml(record.guild_id)}</div></section></div>
    ${record.action !== 'warning' ? `<section class="card"><h2>Discord action result</h2>${record.origin === 'automod' ? '<p>Origin: Automatic moderation</p>' : ''}<p>${escapeHtml(actionResultLabel(record.action_status))}</p><p class="small">This is the recorded result, not a live timeout-status check or ban-status check.</p>${record.action === 'softban' ? '<p>Requested message deletion: 24 hours. No DM is sent. Applied means both the ban and its removal were confirmed. Deleted messages cannot be restored, and the member must rejoin using a valid invite.</p><p><a href="/honeypot">View separate ban and unban results in Honeypot</a></p>' : record.action === 'ban' || record.action === 'unban' ? `<p>Requested message deletion: ${record.action === 'unban' ? 'Not applicable' : record.delete_message_seconds === 0 ? 'Keep history' : escapeHtml(durationLabel(record.delete_message_seconds!))}</p><p class="small">Ban notices are attempted before the ban; a sent DM does not confirm the ban. Unbans do not send a DM, restore deleted messages, or rejoin the member.</p>` : `<p>Requested duration: ${record.duration_seconds ? escapeHtml(durationLabel(record.duration_seconds)) : 'None (removal)'}</p><p>Requested end UTC: ${record.requested_until ? escapeHtml(caseTime(record.requested_until)) : 'None (removal)'}</p><p>Previous end UTC: ${record.previous_until ? escapeHtml(caseTime(record.previous_until)) : 'None'}</p>`}${record.action_error ? `<p class="small mono">Result code: ${escapeHtml(record.action_error)}</p>` : ''}</section>` : ''}<section class="card"><h2>Current reason</h2><p class="case-reason">${escapeHtml(record.reason)}</p>${record.original_reason !== record.reason ? `<h3>Original reason</h3><p class="case-reason">${escapeHtml(record.original_reason)}</p>` : '<p class="small">The original reason is unchanged.</p>'}${record.state === 'void' ? `<h3>Why this warning was voided</h3><p class="case-reason">${escapeHtml(record.void_reason)}</p>` : ''}</section>
    <div class="grid"><section class="card"><div class="label">Member DM</div>${statusLabel(record.dm_status, record.action, record.origin)}<div class="small mono">Message ID: ${escapeHtml(record.dm_message_id ?? 'Not recorded')}</div></section><section class="card"><div class="label">Moderation log</div>${statusLabel(record.log_status)}<div class="small mono">Channel ID: ${escapeHtml(record.log_channel_id ?? 'Not configured')}</div><div class="small mono">Message ID: ${escapeHtml(record.log_message_id ?? 'Not recorded')}</div></section></div>
    <div class="notice">A case remains saved regardless of delivery status. Sent means Discord confirmed message creation, not that the member read it. Not confirmed means the message may have arrived; it is not automatically resent.</div>${caseChangeForms(data)}${caseChangeHistory(data.changes)}<a href="/cases">Back to all cases</a>`, data.nonce, data.csrf);
}

function caseChangeForms(data: { record: WarningCase; canChange: boolean; correctCsrf: string; voidCsrf: string }): string {
  const record = data.record;
  if (record.action !== 'warning') return '<div class="notice">Discord action cases are read only. Use /untimeout to remove an active timeout or /unban to remove a ban. Changing a historical case does not undo a Discord action.</div>';
  if (record.state === 'void') return '<div class="notice">This warning is voided and inactive. Its saved case and history remain available.</div>';
  if (!data.canChange) return '<div class="notice">Ordinary Mods can change only warnings they issued. Admins and Mods with full access can change any warning.</div>';
  const hidden = (csrf: string) => `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="revision" value="${record.revision}">`;
  return `<div class="notice">These controls update the saved case and audit trail. Existing Discord DMs and log messages keep their original text. Notifications already started may still finish. Voiding prevents an unstarted delivery.</div>
    <section class="card"><h2>Correct the warning reason</h2><form method="post" action="/cases/${record.case_number}/correct">${hidden(data.correctCsrf)}<label for="new_reason">Corrected warning reason</label><textarea id="new_reason" name="new_reason" maxlength="500" required>${escapeHtml(record.reason)}</textarea><label for="correction_reason">Why are you correcting this case?</label><textarea id="correction_reason" name="reason" maxlength="500" required></textarea><button type="submit">Save correction</button></form></section>
    <section class="card"><h2>Void this warning</h2><p>Mark this warning inactive. Its reason and full audit history will be retained.</p><form method="post" action="/cases/${record.case_number}/void">${hidden(data.voidCsrf)}<label for="void_reason">Why should this warning be voided?</label><textarea id="void_reason" name="reason" maxlength="500" required></textarea><label for="confirm_case">Type ${record.case_number} to confirm</label><input id="confirm_case" name="confirm" type="text" inputmode="numeric" pattern="${record.case_number}" maxlength="10" required><p><button type="submit">Void warning</button></p></form></section>`;
}
function caseChangeHistory(changes: CaseChangeEvent[]): string {
  return `<section class="card"><h2>Case change history</h2><p class="small">Latest 50 changes · UTC</p>${changes.length ? changes.map((event) => `<article><hr><h3>${event.event_type === 'CASE_VOIDED' ? 'Warning voided' : 'Reason corrected'}</h3><p class="small">${caseTime(event.created_at)} UTC · Staff ID ${escapeHtml(event.actor_id)} · Revision ${escapeHtml(event.details.revision)}</p><p><strong>Justification:</strong></p><p class="case-reason">${escapeHtml(event.details.reason)}</p><p><strong>Previous reason:</strong></p><p class="case-reason">${escapeHtml(event.details.before_reason)}</p><p><strong>Saved reason:</strong></p><p class="case-reason">${escapeHtml(event.details.after_reason)}</p><p class="small">State: ${escapeHtml(event.details.previous_state)} → ${escapeHtml(event.details.new_state)}</p></article>`).join('') : '<p>No corrections or voiding recorded.</p>'}</section>`;
}
