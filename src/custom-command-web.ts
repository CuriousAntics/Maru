import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { CustomCommandError, customName, saveCustomCommand } from './custom-commands.js';
import type { CustomCommand } from './custom-commands.js';
import { customCommandProof, equal, escapeHtml as e, logoutProof } from './web-security.js';
import { layout } from './web-pages.js';
export async function handleCustomCommandPage(request: IncomingMessage,o: {
  pool: Pick<Pool,'query'|'connect'>; guildId: string; actorId: string; token: string; origin: string;
  access: 'admin'|'moderator'; readRoles: (id: string) => Promise<string[] | null>;
},views: { html: (status: number,render: (nonce: string) => string) => void; redirect: (path: string) => void }) {
  let error: string | undefined, status = 200;
  if (request.method === 'POST') try {
    if (o.access !== 'admin') throw new CustomCommandError('ADMIN_REQUIRED');
    if (request.headers.origin !== o.origin || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') throw new CustomCommandError('REQUEST_REJECTED');
    let body = ''; for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body)>32768) throw new CustomCommandError('INVALID_INPUT'); }
    const p = new URLSearchParams(body),keys = ['csrf','scope','revision','name','description','response','enabled','inline','reason','action'];
    if (keys.some(k => p.getAll(k).length !== 1) || [...p.keys()].some(k => !keys.includes(k)) ||
        !/^(0|[1-9]\d{0,9})$/.test(p.get('revision')!) || !['true','false'].includes(p.get('enabled')!) || !['true','false'].includes(p.get('inline')!) ||
        !['save','remove'].includes(p.get('action')!)) throw new CustomCommandError('INVALID_INPUT');
    const revision = Number(p.get('revision')),scope = p.get('scope')!;
    if (scope !== '$new' && scope !== p.get('name') || scope === '$new' && revision !== 0 ||
        !equal(p.get('csrf')!,customCommandProof(o.token,scope,revision))) throw new CustomCommandError('REQUEST_REJECTED');
    await saveCustomCommand(o.pool,{guildId:o.guildId,actorId:o.actorId,token:o.token,name:p.get('name')!,revision,
      description:p.get('description')!,response:p.get('response')!,enabled:p.get('enabled')==='true',inlineEnabled:p.get('inline')==='true',remove:p.get('action')==='remove',reason:p.get('reason')!,readRoles:o.readRoles});
    views.redirect('/custom-commands'); return;
  } catch (err) {
    if (!(err instanceof CustomCommandError)) throw err;
    status = ['ADMIN_REQUIRED','SESSION_EXPIRED','REQUEST_REJECTED'].includes(err.code)?403:409;
    error = ({ADMIN_REQUIRED:'Only Admins and Mods with full access can manage commands.',SESSION_EXPIRED:'Sign in again before saving.',REQUEST_REJECTED:'Reload and use this page’s form.',
      STALE_SETTINGS:'This command changed. Reload before saving.',BUSY:'Discord synchronization is running. Wait a moment and reload.',LIMIT:'Up to 80 custom commands can be configured.',
      INVALID_INPUT:'Use a unique lowercase name (1–32 letters, numbers, hyphens or underscores), a description (1–100 characters), response (1–2000 characters), and change reason (1–500 characters). Built-in command names are reserved.',NOT_FOUND:'The command no longer exists.'} as Record<string,string>)[err.code] ?? 'The command could not be saved.';
  }
  const rows = (await o.pool.query<CustomCommand>('SELECT * FROM custom_commands WHERE guild_id=$1 ORDER BY name',[o.guildId])).rows;
  const recent = (await o.pool.query<{message_id:string;channel_id:string;command_name:string;status:string;note:string}>(
    'SELECT message_id,channel_id,command_name,status,note FROM inline_command_jobs WHERE guild_id=$1 ORDER BY created_at DESC,message_id DESC LIMIT 20',[o.guildId])).rows;
  const editName = new URL(request.url ?? '/custom-commands','http://localhost').searchParams.get('edit');
  const edit = editName && customName(editName)?rows.find(r => r.name === editName):undefined;
  const scope = edit?.name ?? '$new',revision = edit?.revision ?? 0;
  views.html(status,nonce => layout('Custom commands',`<div class="hero"><div class="eyebrow">Saved responses</div><h1>Custom commands and autoresponses</h1><p>Members select Maru’s /command to receive saved text, emojis or media links. Commands are available to everyone wherever Discord permits using Maru’s commands.</p></div>
    ${error?`<div class="notice">${e(error)}</div>`:''}<section class="card"><h2>${edit?'Edit /'+e(edit.name):'Add a command'}</h2>
    <form method="post" action="/custom-commands"><input type="hidden" name="csrf" value="${e(customCommandProof(o.token,scope,revision))}"><input type="hidden" name="scope" value="${e(scope)}"><input type="hidden" name="revision" value="${revision}">
    <fieldset${o.access==='admin'?'':' disabled'}><legend>Command response</legend><label for="cmd-name">Command name (without /)</label><input id="cmd-name" name="name" required pattern="[a-z0-9_-]{1,32}" maxlength="32" value="${e(edit?.name ?? '')}"${edit?' readonly':''}>
    <label for="cmd-description">Description in Discord’s command picker</label><input id="cmd-description" name="description" required maxlength="100" value="${e(edit?.description ?? '')}">
    <label for="cmd-response">Response</label><textarea id="cmd-response" name="response" required maxlength="2000" rows="6">${e(edit?.response ?? '')}</textarea><p>Paste text, custom emoji codes or a media link. Responses are public; mentions do not ping people or roles. Discord controls whether links display a preview.</p>
    <label for="cmd-enabled">Availability</label><select id="cmd-enabled" name="enabled"><option value="false"${!edit?.enabled?' selected':''}>Off</option><option value="true"${edit?.enabled?' selected':''}>On — available to everyone</option></select>
    <label for="cmd-inline">Also respond to /trigger in ordinary messages</label><select id="cmd-inline" name="inline"><option value="false"${!edit?.inline_enabled?' selected':''}>Off</option><option value="true"${edit?.inline_enabled?' selected':''}>On — reuse this command’s response</option></select>
    <p>When both Availability and this option are On, a whole /trigger anywhere in a new message sends the same saved response. Matching ignores capitalization. The original message stays. Bots and webhooks are ignored. One reply per message, with a five-second cooldown per member across these autoresponses. Links are excluded from trigger matching. Edits do not trigger replies.</p>
    <label for="cmd-reason">Reason for this change</label><input id="cmd-reason" name="reason" required maxlength="500"><button name="action" value="save">Save command</button>${edit?'<button class="secondary" name="action" value="remove">Remove command</button>':''}</fieldset></form>
    ${edit?'<p><a href="/custom-commands">Add another command</a></p>':''}<p>New commands default Off. Turning Off stops new replies; a reply already claimed may finish. Discord’s command picker updates after synchronization. Names cannot be edited; remove and recreate to rename.</p></section>
    <h2>Configured commands</h2><div class="table-wrap"><table><thead><tr><th>Command</th><th>Availability</th><th>In-message trigger</th><th>Discord synchronization</th><th>Manage</th></tr></thead><tbody>${rows.map(r => `<tr><td>/${e(r.name)}<div>${e(r.description)}</div></td><td>${r.deleted?'Removed':r.enabled?'On':'Off'}</td><td>${r.enabled && r.inline_enabled && !r.deleted?'On':'Off'}</td><td>${e(r.sync_status)} · ${e(r.sync_note)}</td><td><a href="/custom-commands?edit=${encodeURIComponent(r.name)}">Edit</a></td></tr>`).join('') || '<tr><td colspan="5">No custom commands configured.</td></tr>'}</tbody></table></div>
    <h2>Recent in-message responses</h2><div class="table-wrap"><table><thead><tr><th>Trigger / source</th><th>Result</th></tr></thead><tbody>${recent.map(r => `<tr><td>/${e(r.command_name)} · <a href="https://discord.com/channels/${e(o.guildId)}/${e(r.channel_id)}/${e(r.message_id)}">Original message</a></td><td>${e(r.status)} · ${e(r.note)}</td></tr>`).join('') || '<tr><td colspan="2">No in-message responses recorded.</td></tr>'}</tbody></table></div>
    <p>Keep Dyno’s existing commands until you finish testing Maru. Choose the Maru app in Discord’s command picker when both bots offer the same name.</p>`,nonce,logoutProof(o.token)));
}
