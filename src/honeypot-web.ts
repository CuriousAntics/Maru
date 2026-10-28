import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { readHoneypotSettings, saveHoneypotSettings, HoneypotError } from './honeypot-settings.js';
import type { HoneypotResources } from './honeypot-settings.js';
import type { HoneypotRow } from './honeypot-engine.js';
import { layout } from './web-pages.js';
import { equal, escapeHtml as e, honeypotProof, logoutProof } from './web-security.js';
export async function handleHoneypotPage(request: IncomingMessage,options: {
  pool: Pick<Pool,'query'|'connect'>; guildId: string; actorId: string; token: string; origin: string; access: 'admin'|'moderator';
  readRoles: (id: string) => Promise<string[] | null>; readResources: () => Promise<HoneypotResources>;
},views: { html: (status: number,render: (nonce: string) => string) => void; redirect: (path: string) => void }): Promise<void> {
  let error: string | undefined,status=200;
  if(request.method==='POST') {
    if(options.access!=='admin') { views.html(403,(nonce) => layout('Access denied','<h1>Admin access required</h1>',nonce,logoutProof(options.token))); return; }
    try {
      if(request.headers.origin!==options.origin || request.headers['content-type']?.split(';')[0]?.trim()!=='application/x-www-form-urlencoded') throw new HoneypotError('REQUEST_REJECTED');
      let body=''; for await(const chunk of request) { body+=String(chunk); if(Buffer.byteLength(body)>16384) throw new HoneypotError('INVALID_SELECTION'); }
      const params=new URLSearchParams(body),single=['csrf','revision','enabled','warning','reason'],multi=['channel','exempt_role'];
      if(single.some((key) => params.getAll(key).length!==1) || [...params.keys()].some((key) => ![...single,...multi].includes(key)) || !/^(0|[1-9]\d{0,9})$/.test(params.get('revision')!) || !['true','false'].includes(params.get('enabled')!) || !['true','false'].includes(params.get('warning')!)) throw new HoneypotError('INVALID_SELECTION');
      const revision=Number(params.get('revision'));
      if(!equal(params.get('csrf')!,honeypotProof(options.token,revision))) throw new HoneypotError('REQUEST_REJECTED');
      await saveHoneypotSettings(options.pool,{ guildId: options.guildId,actorId: options.actorId,token: options.token,revision,
        enabled: params.get('enabled')==='true',warningConfirmed: params.get('warning')==='true',channels: params.getAll('channel'),exemptRoles: params.getAll('exempt_role'),reason: params.get('reason')!,readRoles: options.readRoles,readResources: options.readResources });
      views.redirect('/honeypot'); return;
    } catch(err) {
      if(!(err instanceof HoneypotError)) throw err;
      status=['ADMIN_REQUIRED','SESSION_EXPIRED','REQUEST_REJECTED'].includes(err.code)?403:409;
      error=({ ADMIN_REQUIRED: 'Your current roles do not allow settings changes.',SESSION_EXPIRED: 'Sign in again before saving.',REQUEST_REJECTED: 'Reload this page and use its save form.',STALE_SETTINGS: 'Settings changed. Reload before saving.',INVALID_REASON: 'Enter a reason from 1 to 500 characters.',WARNING_REQUIRED: 'Choose a trap channel and confirm that every selected channel contains a visible warning.',PERMISSIONS_OR_LOG: 'Maru needs Ban Members and a saved moderation log channel outside the trap channels.',INVALID_SELECTION: 'Choose available text channels and roles. Duplicate or invalid fields are rejected.' } as Record<string,string>)[err.code] ?? 'Settings could not be saved. Reload and try again.';
    }
  }
  const settings=await readHoneypotSettings(options.pool,options.guildId),resources=await options.readResources();
  const events=(await options.pool.query<HoneypotRow>(`SELECT * FROM honeypot_events WHERE guild_id=$1 ORDER BY created_at DESC,message_id DESC LIMIT 30`,[options.guildId])).rows;
  const selected=(ids: string[],id: string) => ids.includes(id)?' selected':'';
  const missing=settings.channel_ids.filter((id) => !resources.channels.some((c) => c.id===id)).map((id) => `<option value="${e(id)}" selected>Unavailable channel ${e(id)}</option>`).join('');
  const missingRoles=settings.exempt_role_ids.filter((id) => !resources.roles.some((r) => r.id===id)).map((id) => `<option value="${e(id)}" selected>Unavailable role ${e(id)}</option>`).join('');
  views.html(status,(nonce) => layout('Honeypot',`<div class="hero"><div class="eyebrow">Automatic protection</div><h1>Honeypot</h1><p>A human message in a selected trap channel triggers a softban: ban with 24 hours of message deletion, then immediately unban. No DM is sent. Posting here does not prove an account is a bot.</p></div>
    ${error?`<div class="notice">${e(error)}</div>`:''}<div class="notice">${settings.enabled?'On':'Off'} · Staff, bots, the server owner, and Administrators are always protected. Additional exemptions below belong to Honeypot; AutoMod exemptions are configured separately. Threads are not trap channels.</div>
    <section class="card"><h2>Trap settings</h2><form method="post" action="/honeypot"><input type="hidden" name="csrf" value="${e(honeypotProof(options.token,settings.revision))}"><input type="hidden" name="revision" value="${settings.revision}">
    <fieldset${options.access==='admin'?'':' disabled'}><legend>Softban protection</legend><label for="hp-enabled">Protection</label><select id="hp-enabled" name="enabled"><option value="false"${!settings.enabled?' selected':''}>Off</option><option value="true"${settings.enabled?' selected':''}>On</option></select>
    <label for="hp-channels">Trap channels (up to 20; Ctrl or Command selects multiple)</label><select id="hp-channels" name="channel" multiple size="7">${resources.channels.map((c) => `<option value="${e(c.id)}"${selected(settings.channel_ids,c.id)}>#${e(c.name)}${c.usable?'':' (Maru cannot view)'}</option>`).join('')}${missing}</select>
    <label for="hp-exempt">Additional exempt roles</label><select id="hp-exempt" name="exempt_role" multiple size="6">${resources.roles.map((r) => `<option value="${e(r.id)}"${selected(settings.exempt_role_ids,r.id)}>${e(r.name)}</option>`).join('')}${missingRoles}</select>
    <p>Keep your existing warning embed in every trap channel. Maru does not replace or edit it in this release. Suggested wording: “Do not post in this channel. Posting triggers removal from the server and deletion of your last 24 hours of messages. You can rejoin using a valid invite.”</p>
    <label for="hp-warning">Visible warning in every selected channel</label><select id="hp-warning" name="warning"><option value="false"${!settings.warning_confirmed?' selected':''}>Not confirmed</option><option value="true"${settings.warning_confirmed?' selected':''}>I have checked the warnings</option></select>
    <label for="hp-reason">Reason for this settings change</label><input id="hp-reason" name="reason" required maxlength="500"><p>Turning Off cancels unclaimed events. If a softban has already started, Maru still attempts to remove its own ban safely.</p><button type="submit">Save Honeypot</button></fieldset></form>${options.access==='moderator'?'<p>Only Admins and Mods with full access can change these settings.</p>':''}</section>
    <h2>Recent trap events</h2><p>Unconfirmed or rejected unbans need staff review. Check Discord before using /unban. Message content is not stored or copied.</p><div class="table-wrap"><table><thead><tr><th>Member / channel / message</th><th>Ban / unban</th><th>Result</th><th>Case</th></tr></thead><tbody>${events.map((v) => `<tr><td class="mono">${e(v.user_id)}<div>${e(v.channel_id)}</div><div>${e(v.message_id)}</div></td><td>${e(v.ban_status)} / ${e(v.unban_status)}</td><td>${e(v.note)}</td><td>${v.case_number?`<a href="/cases/${v.case_number}">#${v.case_number}</a>`:'No case'}</td></tr>`).join('') || '<tr><td colspan="4">No events recorded.</td></tr>'}</tbody></table></div>`,nonce,logoutProof(options.token)));
}
