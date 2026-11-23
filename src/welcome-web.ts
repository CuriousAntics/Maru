import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { WelcomeError, readWelcomeSettings, renderWelcome, saveWelcomeSettings } from './welcome.js';
import type { WelcomeJob, WelcomeResources, WelcomeSettings } from './welcome.js';
import { equal, escapeHtml as e, formProof, logoutProof } from './web-security.js';
import { layout } from './web-pages.js';
export async function handleWelcomePage(request:IncomingMessage,o:{pool:Pick<Pool,'query'|'connect'>;guildId:string;actorId:string;token:string;origin:string;access:'admin'|'moderator';readRoles:(id:string)=>Promise<string[]|null>;resources:()=>Promise<WelcomeResources>},views:{html:(status:number,render:(nonce:string)=>string)=>void;redirect:(path:string)=>void}) {
  let status=200,error='',draft:WelcomeSettings|undefined;
  if(request.method==='POST')try{
    if(o.access!=='admin')throw new WelcomeError('ADMIN_REQUIRED');
    if(request.headers.origin!==o.origin||request.headers['content-type']?.split(';')[0]?.trim()!=='application/x-www-form-urlencoded')throw new WelcomeError('REQUEST_REJECTED');
    const chunks:Buffer[]=[];let size=0;for await(const chunk of request){const b=Buffer.from(chunk);size+=b.length;if(size>12000)throw new WelcomeError('INVALID_INPUT');chunks.push(b);}
    const p=new URLSearchParams(Buffer.concat(chunks).toString('utf8')),keys=['csrf','revision','enabled','channel','info_channel','template'];
    if(keys.some(k=>p.getAll(k).length!==1)||[...p.keys()].some(k=>!keys.includes(k))||!/^(0|[1-9]\d{0,9})$/.test(p.get('revision')!)||!['true','false'].includes(p.get('enabled')!))throw new WelcomeError('INVALID_INPUT');
    const revision=Number(p.get('revision'));if(!equal(p.get('csrf')!,formProof(o.token,`welcome:${revision}`)))throw new WelcomeError('REQUEST_REJECTED');
    draft={enabled:p.get('enabled')==='true',channel_id:p.get('channel')||null,info_channel_id:p.get('info_channel')||null,template:p.get('template')!,revision};
    await saveWelcomeSettings(o.pool,{...o,revision,enabled:draft.enabled,channelId:draft.channel_id,infoChannelId:draft.info_channel_id,template:draft.template,resources:o.resources});
    views.redirect('/welcome?saved=1');return;
  }catch(err){
    if(!(err instanceof WelcomeError))throw err;
    status=['ADMIN_REQUIRED','SESSION_EXPIRED','REQUEST_REJECTED'].includes(err.code)?403:409;
    error=({ADMIN_REQUIRED:'Only Admins and Mods with full access can change welcomes.',SESSION_EXPIRED:'Sign in again before saving.',REQUEST_REJECTED:'Reload and use this page’s controls.',STALE:'Settings changed in another session. Your edits are shown below. Reload before saving again.',TEMPLATE:'Use 1–1,000 characters and only {server_name}, {member}, and {channel} as placeholders. The completed message must fit within 2,000 characters.',EVENTS_DISABLED:'Member events are not enabled for this deployment. Follow the setup note below before turning welcomes On.',CHANNEL:'Choose an available welcome channel where Maru can view and send messages, and an information channel Maru can view.',INVALID_INPUT:'Check the channels and message, then try again.',BUSY:'Another settings change is running. Try again shortly.'} as Record<string,string>)[err.code]??'Welcome settings could not be saved.';
  }
  const saved=await readWelcomeSettings(o.pool,o.guildId),s=draft??saved;
  let resources:WelcomeResources={eventsReady:false,serverName:'Your server',channels:[]},resourceError=false;
  try{resources=await o.resources();}catch{resourceError=true;}
  const jobs=(await o.pool.query<WelcomeJob>('SELECT * FROM welcome_jobs WHERE guild_id=$1 ORDER BY created_at DESC,user_id LIMIT 30',[o.guildId])).rows;
  const select=(name:string,value:string|null,post:boolean)=>`<select id="${name}" name="${name}"><option value="">Choose channel</option>${resources.channels.map(c=>`<option value="${e(c.id)}"${c.id===value?' selected':''}>#${e(c.name)}${(post?c.postable:c.linkable)?'':' (missing permissions)'}</option>`).join('')}${value&&!resources.channels.some(c=>c.id===value)?`<option value="${e(value)}" selected>Unavailable channel ${e(value)}</option>`:''}</select>`;
  let preview='';try{preview=renderWelcome(s.template,resources.serverName,o.actorId,s.info_channel_id??o.guildId).replace(/<@\d+>/g,'@you').replace(/<#\d+>/g,'#'+(resources.channels.find(c=>c.id===s.info_channel_id)?.name??'information-channel'));}catch{preview='Fix the message template to preview it.';}
  views.html(status,nonce=>layout('Welcome messages',`<div class="hero"><div class="eyebrow">Member greetings</div><h1>Welcome messages</h1><p>Greet new human members in a server channel. No DMs or goodbye messages are sent.</p></div>
    ${error?`<div class="notice" role="alert">${e(error)}</div>`:''}${request.method==='GET'&&new URL(request.url??'/welcome','http://localhost').searchParams.has('saved')?'<div class="notice" role="status">Welcome settings saved.</div>':''}
    <div class="notice">Saved welcomes: ${saved.enabled?'On':'Off'}. ${resourceError?'Discord channel details are temporarily unavailable.':resources.eventsReady?'Member events are enabled.':'Member events need deployment setup before enabling welcomes.'}</div>
    <section class="card"><h2>Welcome settings</h2><form method="post" action="/welcome"><input type="hidden" name="csrf" value="${e(formProof(o.token,`welcome:${s.revision}`))}"><input type="hidden" name="revision" value="${s.revision}">
    <fieldset${o.access==='admin'?'':' disabled'}><legend>New member message</legend><label for="enabled">Welcome messages</label><select id="enabled" name="enabled"><option value="false"${!s.enabled?' selected':''}>Off</option><option value="true"${s.enabled?' selected':''}>On</option></select>
    <label for="channel">Post welcome messages in</label>${select('channel',s.channel_id,true)}<label for="info_channel">Information channel linked in the message</label>${select('info_channel',s.info_channel_id,false)}
    <p>Choose channels new members can access. Maru checks its own permissions; a channel mention does not grant members access.</p>
    <label for="template">Welcome message</label><textarea id="template" name="template" maxlength="1000" rows="5" required>${e(s.template)}</textarea><p>Placeholders: {server_name} = server name; {member} = joining member’s mention; {channel} = clickable information channel. Only the joining member can be pinged. Other typed mentions do not notify anyone.</p><button>Save welcome settings</button></fieldset></form></section>
    <section class="card"><h2>Text preview</h2><p class="case-reason">${e(preview)}</p><p>Uses your identity as an example. Saving updates this preview; it does not send a message to Discord.</p></section>
    ${!resources.eventsReady?'<section class="card"><h2>Member event setup</h2><p>Enable Server Members Intent for this bot in the Discord Developer Portal, then set WELCOME_EVENTS_ENABLED=true in Railway and redeploy. If Community member events are already enabled, no additional intent change is needed. Configure the channels and message while welcomes are Off.</p></section>':''}
    <section class="card"><h2>Recent welcomes</h2><p>Sent means Discord confirmed delivery. Failed means Discord rejected the request. Unknown means it may have arrived; Maru will not automatically resend it. Cancelled means the join or settings were no longer eligible. Changing settings cancels queued welcomes; a request already dispatched may finish.</p>
    <div class="table-wrap"><table><thead><tr><th>Member / joined UTC</th><th>Channel</th><th>Status</th></tr></thead><tbody>${jobs.map(j=>`<tr><td>${e(j.user_id)}<div>${e(new Date(j.joined_at).toISOString())}</div></td><td>${e(j.channel_id)}</td><td>${e(j.status)}${j.message_id?` · <a href="https://discord.com/channels/${e(o.guildId)}/${e(j.channel_id)}/${e(j.message_id)}">View message</a>`:''}</td></tr>`).join('')||'<tr><td colspan="3">No welcomes recorded.</td></tr>'}</tbody></table></div></section>`,nonce,logoutProof(o.token)));
}
