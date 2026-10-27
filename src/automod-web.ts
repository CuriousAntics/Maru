import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { layout } from './web-pages.js';
import { autoModProof, autoModSectionProof, equal, escapeHtml as e, logoutProof } from './web-security.js';
import { parseTimeoutDuration, durationLabel } from './case-labels.js';
import { AutoModError, readAutoModSettings, saveAutoModSettings } from './automod-settings.js';
import type { AutoModResources, AutoModSettings } from './automod-settings.js';
type Views={ html: (status: number,render: (nonce: string) => string) => void; redirect: (path: string) => void };
export async function handleAutoModPage(request: IncomingMessage,input: {
  pool: Pick<Pool,'query'|'connect'>; guildId: string; actorId: string; token: string; origin: string; access: 'admin'|'moderator';
  readRoles: (id: string) => Promise<string[] | null>; readResources: () => Promise<AutoModResources>;
},views: Views) {
  const { pool,guildId,actorId,token,access,readRoles,readResources }=input;
  try {
    if(request.method==='POST') {
      if(access!=='admin') throw new AutoModError('ADMIN_REQUIRED');
      if(request.headers.origin!==input.origin || request.headers['content-type']?.split(';')[0]?.trim()!=='application/x-www-form-urlencoded') throw new AutoModError('CSRF');
      const chunks: Buffer[]=[]; let size=0;
      for await(const chunk of request) { const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk); size+=data.length; if(size>131072) throw new AutoModError('TOO_LARGE'); chunks.push(data); }
      const params=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      if(params.has('section')) { await saveSection(params,input); views.redirect('/automod'); return; }
      const scalar=['csrf','revision','words','timeout','reason'],spamScalars=['spam_limit','spam_window','spam_timeout'],arrays=['exempt_role','ignored_channel','enforced_role','enforced_channel','spam_enforced_role','spam_enforced_channel'];
      if(scalar.some((key) => params.getAll(key).length!==1) || [...params.keys()].some((key) => ![...scalar,...spamScalars,...arrays,'enabled','spam_enabled'].includes(key)) ||
        spamScalars.some((key) => params.getAll(key).length>1) || params.getAll('spam_enabled').length>1 || params.has('spam_enabled') && params.get('spam_enabled')!=='true' || params.getAll('enabled').length>1 || params.has('enabled') && params.get('enabled')!=='true') throw new AutoModError('INVALID_INPUT');
      const revision=params.get('revision')!;
      if(!/^(0|[1-9]\d{0,9})$/.test(revision) || Number(revision)>2147483647) throw new AutoModError('INVALID_INPUT');
      if(!equal(params.get('csrf')!,autoModProof(token,Number(revision)))) throw new AutoModError('CSRF');
      let seconds: number; try { seconds=parseTimeoutDuration(params.get('timeout')!); } catch { throw new AutoModError('INVALID_DURATION'); }
      if(spamScalars.some((key) => !params.has(key)) && spamScalars.some((key) => params.has(key)) || params.has('spam_enabled') && spamScalars.some((key) => !params.has(key))) throw new AutoModError('INVALID_INPUT');
      if(params.has('spam_limit') && (!/^\d{1,2}$/.test(params.get('spam_limit')!) || !/^\d{1,2}$/.test(params.get('spam_window')!))) throw new AutoModError('INVALID_SPAM');
      let spamSeconds: number | undefined;
      if(params.has('spam_timeout')) { try { spamSeconds=parseTimeoutDuration(params.get('spam_timeout')!); } catch { throw new AutoModError('INVALID_DURATION'); } }
      // Reject legacy open forms after rollout rather than silently disabling or rewriting the new rule.
      if(!params.has('spam_limit') && (params.has('spam_enforced_role') || params.has('spam_enforced_channel'))) throw new AutoModError('INVALID_INPUT');
      if(!params.has('spam_limit') && (await readAutoModSettings(pool,guildId)).spam_enabled) throw new AutoModError('STALE_SETTINGS');
      await saveAutoModSettings(pool,{ guildId,actorId,token,revision: Number(revision),enabled: params.get('enabled')==='true',words: params.get('words')!,timeoutSeconds: seconds,
        ...(params.has('spam_limit')?{ spamEnabled: params.get('spam_enabled')==='true',spamLimit: Number(params.get('spam_limit')),spamWindowSeconds: Number(params.get('spam_window')),spamTimeoutSeconds: spamSeconds,spamEnforcedRoles: params.getAll('spam_enforced_role'),spamEnforcedChannels: params.getAll('spam_enforced_channel') }:{}),
        exemptRoles: params.getAll('exempt_role'),ignoredChannels: params.getAll('ignored_channel'),enforcedRoles: params.getAll('enforced_role'),enforcedChannels: params.getAll('enforced_channel'),
        reason: params.get('reason')!,readRoles,readResources }); views.redirect('/automod'); return;
    }
    const resources=await readResources(),settings=await readAutoModSettings(pool,guildId,resources);
    const recent=(await pool.query<Record<string,unknown>>('SELECT rule_key,message_id,user_id,channel_id,matched_entries,delete_status,violation_count,case_number,timeout_note,log_status,detected_at FROM automod_violations WHERE guild_id=$1 ORDER BY detected_at DESC,message_id DESC LIMIT 20',[guildId])).rows;
    const pending=(await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM automod_jobs WHERE guild_id=$1 AND version>processed_version AND attempts>0',[guildId])).rows[0]!.count;
    views.html(200,(nonce) => autoModPage(settings,resources,recent,pending,access,token,logoutProof(token),nonce));
  } catch(error) {
    if(!(error instanceof AutoModError)) throw error;
    const messages: Record<string,[number,string]>={
      ADMIN_REQUIRED: [403,'Only Admins and Mods granted full access may change AutoMod settings.'],SESSION_EXPIRED: [403,'Sign in again before saving.'],
      BUSY: [409,'Maru is processing moderation work. Wait a moment, reload and save again.'],STALE_SETTINGS: [409,'The settings changed. Reload before saving.'],
      INVALID_WORDS: [400,'Use up to 100 distinct entries, separated by commas or new lines, with 1–100 characters each. An enabled filter needs at least one entry.'],
      INVALID_SPAM: [400,'Use a message limit of 2–50 and a window of 1–60 seconds.'],
      INVALID_DURATION: [400,'Use a timeout such as 10m, 1h or 1d, between 1s and 28d.'],INVALID_REASON: [400,'Enter a reason from 1 to 500 characters.'],
      INVALID_SELECTION: [400,'Choose available server roles/channels. Each rule exception must also be selected in its global exemption list.'],
      BOT_PERMISSIONS: [400,'Maru needs Manage Messages and Moderate Members permissions before this rule can be enabled.'],
      LOG_REQUIRED: [400,'Save a moderation log channel in Server settings before enabling the rule.'],
      CSRF: [403,'Reload AutoMod and use its form.'],TOO_LARGE: [413,'The form is too large. Use at most 100 blocked entries and 100 selections per list.'],
      INVALID_INPUT: [400,'Reload AutoMod and use its form.'],NOT_CONFIGURED: [409,'This server is not configured.'],
    };
    const [status,text]=messages[error.code] ?? [400,'Reload AutoMod before saving.'];
    views.html(status,(nonce) => layout('AutoMod settings not saved',`<div class="hero"><h1>Settings not saved</h1><p role="alert">${e(text)}</p><a class="button" href="/automod">Back to AutoMod</a></div>`,nonce,logoutProof(token)));
  }
}
function autoModPage(s: AutoModSettings,res: AutoModResources,recent: Record<string,unknown>[],pending: number,access: 'admin'|'moderator',token: string,logout: string,nonce: string) {
  const options=(name: string,entries: { id: string; name: string }[],selected: string[]) => `<fieldset class="channel-choices"><legend>${({ exempt_role: 'Exempt roles',ignored_channel: 'Ignored channels',enforced_role: 'Roles checked by this rule',enforced_channel: 'Channels checked by the blocked-word rule',spam_enforced_role: 'Roles checked by the rapid-message rule',spam_enforced_channel: 'Channels checked by the rapid-message rule' } as Record<string,string>)[name]}</legend>`+
    entries.map((entry) => `<label class="channel-choice"><input type="checkbox" name="${name}" value="${entry.id}"${selected.includes(entry.id)?' checked':''}>${e(entry.name)}</label>`).join('')+
    selected.filter((id) => !entries.some((entry) => entry.id===id)).map((id) => `<label class="channel-choice"><input type="checkbox" name="${name}" value="${id}" checked>Unavailable (${id})</label>`).join('')+'</fieldset>';
  const rows=recent.map((v) => `<tr><td class="mono">${e(v.user_id)}<div>${e(v.channel_id)}</div></td><td><div>${e(v.rule_key==='rapid_messages'?'Rapid messages':'Blocked words')}</div>${e((v.matched_entries as string[]).join(', '))}</td><td>${e(v.delete_status)}</td><td>${e(v.violation_count)}</td><td>${e(v.timeout_note)}${v.case_number?`<div><a href="/cases/${e(v.case_number)}">Case #${e(v.case_number)}</a></div>`:''}</td><td>${e(v.log_status)}</td></tr>`).join('');
  const open=(section: string) => `<form method="post" action="/automod"><input type="hidden" name="section" value="${section}"><input type="hidden" name="csrf" value="${e(autoModSectionProof(token,s.revision,section))}"><input type="hidden" name="revision" value="${s.revision}">`;
  const close=(section: string,label: string) => `<label for="${section}_reason">Reason for change</label><textarea id="${section}_reason" name="reason" required maxlength="500"></textarea><button type="submit">${label}</button></form>`;
  const form=access==='admin'?`
    <h2>Blocked-word filtering</h2>${open('blocked_words')}
    <label class="channel-choice"><input type="checkbox" name="enabled" value="true"${s.blocked_enabled?' checked':''}>Enable blocked-word filtering</label>
    <label for="blocked_words">Blocked words and phrases — separated by commas</label><textarea id="blocked_words" name="words" maxlength="11000">${e(s.blocked_words.join(', '))}</textarea>
    <label for="timeout">Timeout after five blocked-word violations in ten minutes</label><input id="timeout" name="timeout" required maxlength="32" value="${s.timeout_seconds%60===0?s.timeout_seconds/60+'m':s.timeout_seconds+'s'}">
    <h3>Exceptions for the blocked-word rule</h3><p>Select globally exempt roles or channels that this rule should check. A role override does not override an ignored channel, or vice versa.</p>
    ${options('enforced_role',res.roles,s.enforced_role_ids)}${options('enforced_channel',res.channels,s.enforced_channel_ids)}
    ${close('blocked_words','Save blocked words')}
    <h2>Rapid-message filtering</h2>${open('rapid_messages')}
    <label class="channel-choice"><input type="checkbox" name="spam_enabled" value="true"${s.spam_enabled?' checked':''}>Enable rapid-message filtering</label>
    <label for="spam_limit">Messages allowed per member</label><input id="spam_limit" name="spam_limit" type="number" min="2" max="50" required value="${s.spam_limit ?? 5}">
    <label for="spam_window">Rolling message window (seconds)</label><input id="spam_window" name="spam_window" type="number" min="1" max="60" required value="${s.spam_window_seconds ?? 5}">
    <label for="spam_timeout">Timeout after five rapid-message violations in ten minutes</label><input id="spam_timeout" name="spam_timeout" required maxlength="32" value="${(s.spam_timeout_seconds ?? 600)%60===0?(s.spam_timeout_seconds ?? 600)/60+'m':s.spam_timeout_seconds+'s'}">
    <p>Default: allow five messages in five seconds across eligible channels; remove the sixth and further messages while over the limit. Each removed message counts as one violation. Edits do not add messages. The rapid-message violation counter is separate from blocked words.</p>
    <h3>Exceptions for the rapid-message rule</h3><p>Select globally exempt roles or channels that this rule should check.</p>
    ${options('spam_enforced_role',res.roles,s.spam_enforced_role_ids ?? [])}${options('spam_enforced_channel',res.channels,s.spam_enforced_channel_ids ?? [])}
    ${close('rapid_messages','Save rapid messaging')}
    <h2>Shared exemptions</h2>${open('exemptions')}
    <p>These settings apply to both rules. Select your Admin, Mods, Owner and Community Manager roles, plus globally ignored channels. Removing a shared exemption also removes its per-rule overrides.</p>
    ${options('exempt_role',res.roles,s.exempt_role_ids)}${options('ignored_channel',res.channels,s.ignored_channel_ids)}
    ${close('exemptions','Save shared exemptions')}
    <p class="small">Each button saves its own section and refreshes this page. Save one section before editing another. Changing settings starts a fresh rapid-message observation window; ten-minute violation counters remain.</p>`:
    `<p>Only Admins and Mods granted full access can change settings.</p><h3>Blocked entries</h3><p class="case-reason">${e(s.blocked_words.join(', ') || 'None configured')}</p><p>${s.exempt_role_ids.length} exempt roles · ${s.ignored_channel_ids.length} ignored channels</p>`;
  return layout('AutoMod',`<div class="hero"><div class="eyebrow">Automatic moderation</div><h1>AutoMod</h1><p>Blocked words: ${s.blocked_enabled?'On':'Off'} · Revision ${s.revision} · Timeout ${e(durationLabel(s.timeout_seconds))}</p><p>Rapid messages: ${s.spam_enabled?'On':'Off'} · Limit ${s.spam_limit ?? 5} in ${s.spam_window_seconds ?? 5}s · Timeout ${e(durationLabel(s.spam_timeout_seconds ?? 600))}</p></div><div class="notice">Case-insensitive whole-word and phrase matching on new messages and edits. Matching messages are removed after posting. Logs go to the saved moderation log channel with mentions disabled. No automatic DMs are sent. Bots, webhooks and the server owner are excluded.</div>${!res.canDelete || !res.canTimeout?'<p role="alert">Maru needs Manage Messages and Moderate Members permissions before enabling.</p>':''}${pending?`<p role="alert">${pending} message(s) are awaiting another check after a processing failure. Check bot channel permissions and host logs.</p>`:''}<section class="card">${form}</section><h2>Recent violations</h2><p class="small">Latest 20 · counts and outcomes recorded during processing, not a live member-status check.</p><div class="table-wrap"><table><thead><tr><th>Member / channel</th><th>Entries</th><th>Removal</th><th>Count</th><th>Timeout</th><th>Log</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No violations recorded.</td></tr>'}</tbody></table></div>`,nonce,logout);
}

async function saveSection(params: URLSearchParams,input: Parameters<typeof handleAutoModPage>[1]): Promise<void> {
  const section=params.get('section');
  const fields: Record<string,{ scalar: string[]; arrays: string[]; flag?: string }>={
    blocked_words: { scalar: ['words','timeout'],arrays: ['enforced_role','enforced_channel'],flag: 'enabled' },
    rapid_messages: { scalar: ['spam_limit','spam_window','spam_timeout'],arrays: ['spam_enforced_role','spam_enforced_channel'],flag: 'spam_enabled' },
    exemptions: { scalar: [],arrays: ['exempt_role','ignored_channel'] },
  };
  const spec=section && Object.hasOwn(fields,section)?fields[section]:undefined;
  if(!spec) throw new AutoModError('INVALID_INPUT');
  const scalar=['section','csrf','revision','reason',...spec.scalar],allowed=[...scalar,...spec.arrays,...(spec.flag?[spec.flag]:[])];
  if(scalar.some((key) => params.getAll(key).length!==1) || [...params.keys()].some((key) => !allowed.includes(key)) ||
    spec.flag && (params.getAll(spec.flag).length>1 || params.has(spec.flag) && params.get(spec.flag)!=='true')) throw new AutoModError('INVALID_INPUT');
  const revision=params.get('revision')!;
  if(!/^(0|[1-9]\d{0,9})$/.test(revision) || Number(revision)>2147483647) throw new AutoModError('INVALID_INPUT');
  if(!equal(params.get('csrf')!,autoModSectionProof(input.token,Number(revision),section!))) throw new AutoModError('CSRF');
  const current=await readAutoModSettings(input.pool,input.guildId,await input.readResources());
  if(current.revision!==Number(revision)) throw new AutoModError('STALE_SETTINGS');
  const changes={ enabled: current.blocked_enabled,words: current.blocked_words.join('\n'),timeoutSeconds: current.timeout_seconds,
    spamEnabled: current.spam_enabled ?? false,spamLimit: current.spam_limit ?? 5,spamWindowSeconds: current.spam_window_seconds ?? 5,spamTimeoutSeconds: current.spam_timeout_seconds ?? 600,
    exemptRoles: current.exempt_role_ids,ignoredChannels: current.ignored_channel_ids,enforcedRoles: current.enforced_role_ids,enforcedChannels: current.enforced_channel_ids,
    spamEnforcedRoles: current.spam_enforced_role_ids ?? [],spamEnforcedChannels: current.spam_enforced_channel_ids ?? [] };
  try {
    if(section==='blocked_words') {
      changes.enabled=params.has('enabled'); changes.words=params.get('words')!; changes.timeoutSeconds=parseTimeoutDuration(params.get('timeout')!);
      changes.enforcedRoles=params.getAll('enforced_role'); changes.enforcedChannels=params.getAll('enforced_channel');
    } else if(section==='rapid_messages') {
      if(!/^\d{1,2}$/.test(params.get('spam_limit')!) || !/^\d{1,2}$/.test(params.get('spam_window')!)) throw new AutoModError('INVALID_SPAM');
      changes.spamEnabled=params.has('spam_enabled'); changes.spamLimit=Number(params.get('spam_limit')); changes.spamWindowSeconds=Number(params.get('spam_window'));
      changes.spamTimeoutSeconds=parseTimeoutDuration(params.get('spam_timeout')!); changes.spamEnforcedRoles=params.getAll('spam_enforced_role'); changes.spamEnforcedChannels=params.getAll('spam_enforced_channel');
    } else {
      changes.exemptRoles=params.getAll('exempt_role'); changes.ignoredChannels=params.getAll('ignored_channel');
      changes.enforcedRoles=changes.enforcedRoles.filter((id) => changes.exemptRoles.includes(id)); changes.enforcedChannels=changes.enforcedChannels.filter((id) => changes.ignoredChannels.includes(id));
      changes.spamEnforcedRoles=changes.spamEnforcedRoles.filter((id) => changes.exemptRoles.includes(id)); changes.spamEnforcedChannels=changes.spamEnforcedChannels.filter((id) => changes.ignoredChannels.includes(id));
    }
  } catch(error) { if(error instanceof AutoModError) throw error; throw new AutoModError('INVALID_DURATION'); }
  // The service rechecks this same revision, session and staff access under its database lock.
  await saveAutoModSettings(input.pool,{ ...changes,guildId: input.guildId,actorId: input.actorId,token: input.token,revision: Number(revision),reason: params.get('reason')!,readRoles: input.readRoles,readResources: input.readResources });
}
