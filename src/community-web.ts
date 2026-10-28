import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { readCommunitySettings, saveCommunitySettings, requestCommunityCapture, CommunityError } from './community-settings.js';
import type { CommunityResources } from './community-settings.js';
import { communityTotals } from './community-engine.js';
import { layout } from './web-pages.js';
import { communityProof, equal, escapeHtml as e, logoutProof } from './web-security.js';
export async function handleCommunityPage(request: IncomingMessage,o: { pool: Pick<Pool,'query'|'connect'>; guildId: string; actorId: string; token: string; origin: string;
 access: 'admin'|'moderator'; readRoles: (id: string) => Promise<string[] | null>; readResources: () => Promise<CommunityResources> },v: { html: (status: number,render: (nonce: string) => string) => void; redirect: (url: string) => void }) {
 let error: string | undefined,status=200;
 if(request.method==='POST') try {
 if(o.access!=='admin') throw new CommunityError('ADMIN_REQUIRED');
 if(request.headers.origin!==o.origin || request.headers['content-type']?.split(';')[0]?.trim()!=='application/x-www-form-urlencoded') throw new CommunityError('REQUEST_REJECTED');
 let body=''; for await(const chunk of request) { body+=String(chunk); if(Buffer.byteLength(body)>16384) throw new CommunityError('INVALID_INPUT'); }
 const p=new URLSearchParams(body),action=p.get('action'),single=action==='capture'?['action','csrf','revision','reason']:['action','csrf','revision','reason','tracking','roles','nomad','community','messages','voice_minutes','days'];
 const multi=action==='capture'?[]:['excluded','afk'];
 if(!['save','capture'].includes(action ?? '') || single.some((key) => p.getAll(key).length!==1) || [...p.keys()].some((key) => ![...single,...multi].includes(key)) || !/^(0|[1-9]\d{0,9})$/.test(p.get('revision')!)) throw new CommunityError('INVALID_INPUT');
 const revision=Number(p.get('revision')); if(!equal(p.get('csrf')!,communityProof(o.token,revision,action!))) throw new CommunityError('REQUEST_REJECTED');
 const common={ guildId: o.guildId,actorId: o.actorId,token: o.token,revision,reason: p.get('reason')!,readRoles: o.readRoles,readResources: o.readResources };
 if(action==='capture') await requestCommunityCapture(o.pool,common);
 else {
 if(['tracking','roles'].some((key) => !['true','false'].includes(p.get(key)!)) || ['messages','voice_minutes','days'].some((key) => !/^\d{1,8}$/.test(p.get(key)!))) throw new CommunityError('INVALID_INPUT');
 await saveCommunitySettings(o.pool,{ ...common,tracking: p.get('tracking')==='true',assignRoles: p.get('roles')==='true',nomad: p.get('nomad') || null,community: p.get('community') || null,
 excluded: p.getAll('excluded'),afk: p.getAll('afk'),messages: Number(p.get('messages')),voiceSeconds: Number(p.get('voice_minutes'))*60,days: Number(p.get('days')) });
 }
 v.redirect('/community'); return;
 } catch(err) {
 if(!(err instanceof CommunityError)) throw err;
 status=['ADMIN_REQUIRED','SESSION_EXPIRED','REQUEST_REJECTED'].includes(err.code)?403:409;
 error=({ ADMIN_REQUIRED: 'Current Admin access is required.',SESSION_EXPIRED: 'Sign in again before saving.',REQUEST_REJECTED: 'Reload this page and use its own form.',STALE_SETTINGS: 'Settings changed. Reload before saving.',EVENTS_DISABLED: 'Community event intake is disabled. Follow the documented Discord intent setup before enabling it.',INVALID_ROLES: 'Choose two distinct member roles below Maru, without staff permissions or integration management.',INVALID_CHANNELS: 'Choose available channels in this server.',INVALID_INPUT: 'Use the current form, valid limits, and distinct channel selections.',INVALID_REASON: 'Enter a reason from 1 to 500 characters.',CAPTURE_BUSY: 'A capture is already pending or running.' } as Record<string,string>)[err.code] ?? 'The change could not be saved.';
 }
 const s=await readCommunitySettings(o.pool,o.guildId),res=await o.readResources();
 const capture=(await o.pool.query<{ status: string; captured: number }>('SELECT status,captured FROM community_capture WHERE guild_id=$1',[o.guildId])).rows[0];
 const members=(await o.pool.query<{ user_id: string; earned_at: Date; earned_source: string }>('SELECT user_id,earned_at,earned_source FROM community_members WHERE guild_id=$1 AND earned_at IS NOT NULL ORDER BY earned_at DESC,user_id LIMIT 20',[o.guildId])).rows;
 const jobs=(await o.pool.query<{ user_id: string; note: string }>('SELECT user_id,note FROM community_role_jobs WHERE guild_id=$1 ORDER BY updated_at DESC,user_id LIMIT 20',[o.guildId])).rows;
 const params=new URL(request.url ?? '/community',o.origin).searchParams,memberId=params.get('member') ?? '';
 let progress='';
 if(memberId) {
 if(!/^\d{17,20}$/.test(memberId) || params.getAll('member').length!==1) { status=400; error='Enter one valid Discord member ID.'; }
 else { const total=await communityTotals(o.pool,o.guildId,memberId,s); const earned=!!(await o.pool.query('SELECT 1 FROM community_members WHERE guild_id=$1 AND user_id=$2 AND earned_at IS NOT NULL',[o.guildId,memberId])).rowCount;
 progress=`<div class="notice">Member ${e(memberId)}: ${total.messages} messages · ${(total.voiceSeconds/60).toFixed(2)} voice minutes in ${s.window_days} days · ${earned?'Community permanently earned':'Not recorded as earned'}. Totals contain only activity Maru has observed or explicitly imported.</div>`; }
 }
 const toggle=(name: string,on: boolean) => `<select id="cr-${name}" name="${name}"><option value="false"${on?'':' selected'}>Off</option><option value="true"${on?' selected':''}>On</option></select>`;
 const roles=(name: string,id: string | null) => `<select id="cr-${name}" name="${name}"><option value="">Not selected</option>${res.roles.map((r) => `<option value="${e(r.id)}"${r.id===id?' selected':''}>${e(r.name)}${r.usable?'':' (unavailable or staff permissions)'}</option>`).join('')}${id && !res.roles.some((r) => r.id===id)?`<option value="${e(id)}" selected>Unavailable role ${e(id)}</option>`:''}</select>`;
 const channels=(name: string,list: { id: string; name: string }[],selected: string[]) => `<select id="cr-${name}" name="${name}" multiple size="6">${list.map((c) => `<option value="${e(c.id)}"${selected.includes(c.id)?' selected':''}>#${e(c.name)}</option>`).join('')}${selected.filter((id) => !list.some((c) => c.id===id)).map((id) => `<option value="${e(id)}" selected>Unavailable channel ${e(id)}</option>`).join('')}</select>`;
 v.html(status,(nonce) => layout('Community roles',`<div class="hero"><div class="eyebrow">Membership and engagement</div><h1>Community roles</h1><p>Nomad on joining. Community after either message or voice activity qualifies. Community is permanent and restored on return; Maru adds Community before removing Nomad.</p></div>
 ${error?`<div class="notice">${e(error)}</div>`:''}<div class="notice">Event intake: ${res.eventsReady?'available':'disabled in deployment settings'} · Tracking: ${s.tracking_enabled?'On':'Off'} · Role changes: ${s.roles_enabled?'On':'Off'}. Offline time is not counted.</div>
 <section class="card"><form method="post" action="/community"><input type="hidden" name="action" value="save"><input type="hidden" name="csrf" value="${e(communityProof(o.token,s.revision,'save'))}"><input type="hidden" name="revision" value="${s.revision}"><fieldset${o.access==='admin'?'':' disabled'}><legend>Role and activity settings</legend>
 <label for="cr-tracking">Activity tracking</label>${toggle('tracking',s.tracking_enabled)}<label for="cr-roles">Automatic role changes</label>${toggle('roles',s.roles_enabled)}
 <label for="cr-nomad">Nomad role</label>${roles('nomad',s.nomad_role_id)}<label for="cr-community">Community role</label>${roles('community',s.community_role_id)}
 <label for="cr-messages">Message threshold</label><input id="cr-messages" name="messages" type="number" min="1" max="100000" required value="${s.message_threshold}">
 <label for="cr-voice">Eligible voice minutes (either threshold qualifies)</label><input id="cr-voice" name="voice_minutes" type="number" min="1" max="129600" required value="${s.voice_seconds/60}">
 <label for="cr-days">Rolling window in days</label><input id="cr-days" name="days" type="number" min="1" max="90" required value="${s.window_days}">
 <label for="cr-excluded">Message channels that do not count (also excludes their threads)</label>${channels('excluded',res.channels,s.excluded_channel_ids)}
 <label for="cr-afk">Additional AFK / excluded voice channels</label>${channels('afk',res.voiceChannels,s.afk_channel_ids)}
 <p>The server's configured AFK channel is always excluded from new voice credit. Muted, deafened, suppressed, bot, and solo participation earn no time. At least two humans must be present; a muted human can be present but earns no credit.</p>
 <label for="cr-reason">Reason for this settings change</label><input id="cr-reason" name="reason" required maxlength="500"><button>Save Community settings</button></fieldset></form></section>
 <section class="card"><h2>Preserve existing Community holders</h2><p>Capture the members who currently hold the selected Community role. This records permanent eligibility, including while automatic role changes are Off. It does not import unearned StatBot message or voice progress. Keep StatBot until that separate migration is resolved.</p>
 <p>Capture: ${capture?`${e(capture.status)} · ${capture.captured} holders observed`:'Not requested'}</p>
 ${o.access==='admin'?`<form method="post" action="/community"><input type="hidden" name="action" value="capture"><input type="hidden" name="revision" value="${s.revision}"><input type="hidden" name="csrf" value="${e(communityProof(o.token,s.revision,'capture'))}"><label for="cr-capture-reason">Reason for capturing current holders</label><input id="cr-capture-reason" name="reason" required maxlength="500"><button>Capture current Community holders</button></form>`:''}</section>
 <section class="card"><h2>Member progress</h2><form method="get" action="/community"><label for="cr-member">Discord member ID</label><input id="cr-member" name="member" value="${e(memberId)}" pattern="[0-9]{17,20}" required><button>Look up progress</button></form>${progress}</section>
 <h2>Recently earned</h2><div class="table-wrap"><table><thead><tr><th>Member</th><th>Source</th><th>Earned UTC</th></tr></thead><tbody>${members.map((m) => `<tr><td>${e(m.user_id)}</td><td>${e(m.earned_source)}</td><td>${e(new Date(m.earned_at).toISOString())}</td></tr>`).join('') || '<tr><td colspan="3">No permanent eligibility recorded.</td></tr>'}</tbody></table></div>
 <h2>Recent role work</h2><div class="table-wrap"><table><thead><tr><th>Member</th><th>Result</th></tr></thead><tbody>${jobs.map((j) => `<tr><td>${e(j.user_id)}</td><td>${e(j.note)}</td></tr>`).join('') || '<tr><td colspan="2">No role work recorded.</td></tr>'}</tbody></table></div>`,nonce,logoutProof(o.token)));
}
