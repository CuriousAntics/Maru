import { answerColumns, answersTable, enrichFormIdentities, formUser } from './form-responses.js';
import type { ReadFormIdentity } from './form-responses.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import { FormError, uuid, saveForm, saveAndPublishForm, reviewForm, deleteForm } from './forms.js';
import type { Form, Entry, Question, StaffContext } from './forms.js';
import { equal, escapeHtml as e, formProof, logoutProof } from './web-security.js';
import { layout } from './web-pages.js';
type Options = StaffContext & {pool:Pick<Pool,'query'|'connect'>;origin:string;access:'admin'|'moderator';readIdentity?:ReadFormIdentity;readChannels?:()=>Promise<{id:string;name:string;usable:boolean}[]>};
type Views = {html:(status:number,render:(nonce:string)=>string)=>void;redirect:(path:string)=>void;download:(filename:string,data:Buffer)=>void};
const types = {short:'Short answer',paragraph:'Paragraph',choice:'Multiple choice — choose one',checkboxes:'Checkboxes — choose several',file:'File upload'};
const blank = (): Question => ({label:'',type:'short',required:true,options:[]});
const hidden = (name:string,value:unknown) => `<input type="hidden" name="${name}" value="${e(value)}">`;
const time = (value:Date|null) => value?e(new Date(value).toISOString().replace('T',' ').slice(0,19))+' UTC':'—';
const errors: Record<string,string> = {CLOSED:'Set Accept responses to On before publishing. Your edits are still shown below.',DELETE_CONFIRMATION:'Type DELETE and choose whether to keep or delete submitted responses.',INVALID_INPUT:'Check the title, questions and options. Choice questions need 2–10 distinct options. Required labels cannot be blank.',STALE:'This form or response changed. Reload before saving. Turn the form On before publishing.',SESSION_EXPIRED:'Sign in again before saving.',STAFF_REQUIRED:'Current staff access is required. Only Admins and Mods with full access can build and publish forms.',REQUEST_REJECTED:'Reload and use this page’s controls.',CHANNEL:'Choose an available channel with bot permissions.',LIMIT:'Up to 50 forms can be configured.',NOT_FOUND:'This item is unavailable.',BUSY:'Another change is running. Try again shortly.'};
async function params(request:IncomingMessage,o:Options): Promise<URLSearchParams> {
  if (request.headers.origin!==o.origin || request.headers['content-type']?.split(';')[0]?.trim()!=='application/x-www-form-urlencoded') throw new FormError('REQUEST_REJECTED');
  const chunks:Buffer[]=[]; let size=0;
  for await (const chunk of request) { const b=Buffer.from(chunk); size+=b.length; if (size>100000) throw new FormError('INVALID_INPUT'); chunks.push(b); }
  const p=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  for (const key of p.keys()) if (p.getAll(key).length!==1) throw new FormError('INVALID_INPUT');
  return p;
}
function proof(p:URLSearchParams,o:Options,scope:string) {
  if (!equal(p.get('csrf')??'',formProof(o.token,scope))) throw new FormError('REQUEST_REJECTED');
}
function revision(p:URLSearchParams) { const v=p.get('revision')??''; if (!/^(0|[1-9]\d{0,9})$/.test(v) || Number(v)>=2147483647) throw new FormError('INVALID_INPUT'); return Number(v); }
export async function handleFormsPage(request:IncomingMessage,o:Options,views:Views) {
  const url=new URL(request.url??'/forms','http://localhost'),path=url.pathname;
  const deletion=/^\/forms\/delete\/([0-9a-f-]{36})$/.exec(path);
  const detail=/^\/forms\/responses\/([0-9a-f-]{36})$/.exec(path),file=/^\/forms\/files\/([0-9a-f-]{36})$/.exec(path);
  let error:string|undefined,status=200,editor:Form|undefined,selectedChannel='',publicationId=randomUUID() as string;
  const render=(title:string,body:string)=>views.html(status,nonce=>layout(title,body,nonce,logoutProof(o.token)));
  if (file) {
    if (!uuid(file[1]!)) throw new FormError('NOT_FOUND');
    const f=(await o.pool.query<{filename:string;data:Buffer}>(`SELECT f.filename,f.data FROM form_files f JOIN form_entries e ON e.guild_id=f.guild_id AND e.id=f.entry_id
      WHERE f.guild_id=$1 AND f.id=$2 AND e.state<>'draft'`,[o.guildId,file[1]])).rows[0];
    if (!f) {status=404;render('File unavailable','<h1>File unavailable</h1>');return;}
    views.download(f.filename,Buffer.from(f.data)); return;
  }
  try {
    if (request.method==='POST') {
      const p=await params(request,o),rev=revision(p);
      if (deletion) {
        proof(p,o,`delete:${deletion[1]}:${rev}`);
        if ([...p.keys()].some(k=>!['csrf','revision','retention','confirmation'].includes(k))) throw new FormError('INVALID_INPUT');
        await deleteForm(o.pool,{...o,id:deletion[1]!,revision:rev,retention:p.get('retention') as 'keep'|'purge',confirmation:p.get('confirmation')??''});
        views.redirect('/forms');return;
      }
      if (detail) {
        proof(p,o,`review:${detail[1]}:${rev}`);
        if ([...p.keys()].some(k=>!['csrf','revision','decision','message'].includes(k))) throw new FormError('INVALID_INPUT');
        await reviewForm(o.pool,{...o,id:detail[1]!,revision:rev,decision:p.get('decision') as 'approved'|'rejected',message:p.get('message')??''});
        views.redirect(path);return;
      }
      const id=p.get('id')??'',action=p.get('action')??'';
      if (!uuid(id)) throw new FormError('INVALID_INPUT');
      proof(p,o,`build:${id}:${rev}`);
      if (o.access!=='admin') throw new FormError('STAFF_REQUIRED');
      if (!/^(?:save|publish|add|up:\d{1,2}|down:\d{1,2}|remove:\d{1,2})$/.test(action) || !/^(?:[1-9]|1\d|2[0-5])$/.test(p.get('count')??'')) throw new FormError('INVALID_INPUT');
      const count=Number(p.get('count'));
      const allowed=new Set(['csrf','id','revision','action','count','title','description','enabled','request_id','channel']);
      const questions:Question[]=[];
      for (let n=0;n<count;n++) {
        for(const key of ['label','type','required','options']) allowed.add(`q${n}_${key}`);
        const type=p.get(`q${n}_type`) as Question['type'],required=p.get(`q${n}_required`);
        if (!Object.hasOwn(types,type) || !['true','false'].includes(required??'')) throw new FormError('INVALID_INPUT');
        const label=p.get(`q${n}_label`)??'',options=p.get(`q${n}_options`)??'';
        if(label.length>100 || options.length>1100) throw new FormError('INVALID_INPUT');
        questions.push({label:label.trim(),type,required:required==='true',options:['choice','checkboxes'].includes(type)?options.split(/\r?\n/).map(v=>v.trim()).filter(Boolean):[]});
      }
      if ([...p.keys()].some(k=>!allowed.has(k)) || !['true','false'].includes(p.get('enabled')??'')) throw new FormError('INVALID_INPUT');
      selectedChannel=p.get('channel')??'';
      publicationId=p.get('request_id')??publicationId;
      if(!uuid(publicationId))throw new FormError('INVALID_INPUT');
      editor={id,revision:rev,title:p.get('title')??'',description:p.get('description')??'',enabled:p.get('enabled')==='true',questions};
      if (editor.title.length>45 || editor.description.length>1000) throw new FormError('INVALID_INPUT');
      if (action==='save') { await saveForm(o.pool,{...o,id,revision:rev,form:editor});views.redirect('/forms?edit='+id+'&saved=1');return; }
      if (action==='publish') {
        if(!p.has('request_id'))throw new FormError('REQUEST_REJECTED');
        if(!o.readChannels)throw new FormError('CHANNEL');
        await saveAndPublishForm(o.pool,{...o,id,revision:rev,form:editor,requestId:publicationId,channelId:selectedChannel,readChannels:o.readChannels});
        views.redirect('/forms?edit='+id+'&published=1');return;
      }
      if(action==='add') { if(questions.length>=25)throw new FormError('INVALID_INPUT');questions.push(blank()); }
      else {
        const [operation,index]=action.split(':'),n=Number(index);
        if(n<0||n>=questions.length)throw new FormError('INVALID_INPUT');
        if(operation==='remove') {if(questions.length<2)throw new FormError('INVALID_INPUT');questions.splice(n,1);}
        else {const to=operation==='up'?n-1:n+1;if(to<0||to>=questions.length)throw new FormError('INVALID_INPUT');[questions[n],questions[to]]=[questions[to]!,questions[n]!];}
      }
    }
  } catch (err) {
    if (!(err instanceof FormError)) {
      if (!editor) throw err;
      console.error('Form save or publication could not be confirmed.');
      status=503;error='Maru could not confirm this save. Your edits are still shown below. Check the saved form and Recent publications before retrying.';
    } else {
      status=['REQUEST_REJECTED','STAFF_REQUIRED','SESSION_EXPIRED'].includes(err.code)?403:409;
      error=errors[err.code]??'This change could not be saved.';
    }
  }
  if (deletion) {
    if (o.access!=='admin') {status=403;render('Staff access required','<h1>Full access required</h1>');return;}
    const f=uuid(deletion[1]!)?(await o.pool.query<Form>('SELECT * FROM forms WHERE guild_id=$1 AND id=$2 AND NOT deleted',[o.guildId,deletion[1]])).rows[0]:undefined;
    if(!f){status=404;render('Form unavailable','<h1>Form unavailable</h1><a href="/forms">Back to forms</a>');return;}
    const counts=(await o.pool.query<{responses:string;drafts:string}>("SELECT count(*) FILTER (WHERE state<>'draft') AS responses,count(*) FILTER (WHERE state='draft') AS drafts FROM form_entries WHERE guild_id=$1 AND form_id=$2",[o.guildId,f.id])).rows[0]!;
    render('Delete form',`<div class="hero"><h1>Delete ${e(f.title)}?</h1><p>This removes the form from Your forms and stops new responses through all its Discord posts. Existing Discord posts remain visible. Unfinished drafts and their files will be deleted.</p></div>
      ${error?`<div class="notice" role="alert">${e(errors[error]??error)}</div>`:''}
      <section class="card"><p>Saved submissions: ${e(counts.responses)} · Unfinished drafts: ${e(counts.drafts)}</p><form method="post" action="${path}">
      ${hidden('csrf',formProof(o.token,`delete:${f.id}:${f.revision}`))}${hidden('revision',f.revision)}
      <label for="retention">What should happen to submitted responses?</label><select id="retention" name="retention"><option value="keep">Keep submitted responses and their files</option><option value="purge">Permanently delete submitted responses and their files</option></select>
      <p>Kept responses remain available under Submissions, including pending reviews. Permanently deleted responses and files cannot be restored here.</p>
      <label for="confirmation">Type DELETE to confirm</label><input id="confirmation" name="confirmation" required pattern="DELETE" autocomplete="off"><p><button>Delete form</button> <a href="/forms?edit=${f.id}">Cancel</a></p></form></section>`);return;
  }
  const notice=error?`<div class="notice" role="alert">${e(error)}</div>`:'';
  if (detail) {
    if (!uuid(detail[1]!)) {status=404;render('Response unavailable','<h1>Response unavailable</h1>');return;}
    const entry=(await o.pool.query<Entry>("SELECT * FROM form_entries WHERE guild_id=$1 AND id=$2 AND state<>'draft'",[o.guildId,detail[1]])).rows[0];
    if(!entry){status=404;render('Response unavailable','<h1>Response unavailable</h1>');return;}
    await enrichFormIdentities(o.pool,o.guildId,[entry],o.readIdentity);
    render('Form response',`<div class="hero"><h1>${e(entry.snapshot.title)}</h1><p>${e(entry.state)} · ${time(entry.submitted_at)}</p><div>Submitted by ${formUser(entry)}</div><p>Reference ${e(entry.id)}</p></div>${notice}
      ${entry.answers.map(a=>`<section class="card"><h2>${e(a.label)}</h2>${a.fileId?`<a href="/forms/files/${e(a.fileId)}">Download ${e(a.filename)}</a>`:`<p class="case-reason">${e(Array.isArray(a.value)?a.value.join('\n'):a.value||'No answer')}</p>`}</section>`).join('')}
      ${entry.state==='pending'?`<section class="card"><h2>Review submission</h2><form method="post" action="${e(path)}">${hidden('csrf',formProof(o.token,`review:${entry.id}:${entry.revision}`))}${hidden('revision',entry.revision)}<label for="message">Optional message to the submitter</label><textarea id="message" name="message" maxlength="1000" rows="5"></textarea><p>This message and your decision will be sent by DM. It is visible to the submitter.</p><button name="decision" value="approved">Approve and notify</button> <button class="secondary" name="decision" value="rejected">Reject and notify</button></form></section>`:`<section class="card"><h2>Review result</h2><p>${e(entry.state)} by ${e(entry.reviewed_by)} · ${time(entry.reviewed_at)}</p><p class="case-reason">${e(entry.decision_message||'No additional message')}</p><p>Decision DM: ${e(entry.dm_status)}</p><p>Sent means Discord confirmed delivery. Failed means delivery was rejected. Unknown means it may have arrived; Maru will not automatically resend it.</p></section>`}<p><a href="/forms">Back to forms and responses</a></p>`);return;
  }
  const allForms=(await o.pool.query<Form>('SELECT * FROM forms WHERE guild_id=$1 ORDER BY updated_at DESC,id',[o.guildId])).rows;
  const forms=allForms.filter(f=>!f.deleted);
  if(!editor) {
    const id=url.searchParams.get('edit');
    editor=id?forms.find(f=>f.id===id):undefined;
    if(url.searchParams.has('new'))editor={id:randomUUID(),revision:0,title:'',description:'',questions:[blank()],enabled:false};
  }
  const filter=url.searchParams.get('status')??'pending',formFilter=url.searchParams.get('form')??'';
  const pageRaw=url.searchParams.get('page')??'0',page=/^\d{1,5}$/.test(pageRaw)?Number(pageRaw):0;
  const state=['pending','approved','rejected','all'].includes(filter)?filter:'pending';
  const entries=(await o.pool.query<Entry>(`SELECT id,form_id,user_id,username,display_name,identity_source,name_lookup_after,answers,state,submitted_at,dm_status,snapshot->>'title' AS title FROM form_entries
    WHERE guild_id=$1 AND state<>'draft' AND ($2='all' OR state=$2) AND ($3='' OR form_id::text=$3) ORDER BY submitted_at DESC,id DESC LIMIT 51 OFFSET $4`,[o.guildId,state,uuid(formFilter)?formFilter:'',page*50])).rows as (Entry & {title:string})[];
  await enrichFormIdentities(o.pool,o.guildId,entries.slice(0,50),o.readIdentity);
  const view=url.searchParams.get('view')==='answers'?'answers':'list';
  const selectedForm=allForms.find(f=>f.id===formFilter);
  let responseTable='';
  if(view==='answers' && selectedForm) {
    const schemas=(await o.pool.query<{questions:Question[]}>(`SELECT DISTINCT snapshot->'questions' AS questions FROM form_entries
      WHERE guild_id=$1 AND form_id=$2 AND state<>'draft' ORDER BY questions`,[o.guildId,selectedForm.id])).rows;
    responseTable=answersTable(entries.slice(0,50),answerColumns(selectedForm.questions,schemas.map(s=>s.questions)));
  }
  let editorHtml='';
  if(editor) {
    const f=editor;
    const publications=f.revision?(await o.pool.query<{channel_id:string;message_id:string|null;status:string}>('SELECT channel_id,message_id,status FROM form_publications WHERE guild_id=$1 AND form_id=$2 ORDER BY created_at DESC LIMIT 10',[o.guildId,f.id])).rows:[];
    const channels=o.readChannels?await o.readChannels().catch(()=>[]):[];
    editorHtml=`<section class="card"><h2>${f.revision?'Edit form':'Create form'}</h2>${request.method==='GET'&&(url.searchParams.has('saved')||url.searchParams.has('published'))?`<div class="notice" role="status">Saved all ${f.questions.length} questions.${url.searchParams.has('published')?' Your Discord post is queued; check Recent publications below.':''}</div>`:''}<p>Save form saves every question below. Publish form post saves every question and queues that version for Discord. Editing a saved form requires members with unfinished drafts to restart. Existing responses keep their original questions and answers.</p>
      <form id="form-builder" method="post" action="/forms?edit=${f.id}">${hidden('request_id',publicationId)}${hidden('csrf',formProof(o.token,`build:${f.id}:${f.revision}`))}${hidden('id',f.id)}${hidden('revision',f.revision)}${hidden('count',f.questions.length)}
      <fieldset${o.access==='admin'?'':' disabled'}><legend>Form builder · ${f.questions.length} questions</legend><button name="action" value="save">Save form</button><label for="title">Title</label><input id="title" name="title" required maxlength="45" value="${e(f.title)}"><label for="description">Description</label><textarea id="description" name="description" maxlength="1000" rows="4">${e(f.description)}</textarea>
      <label for="enabled">Accept responses</label><select id="enabled" name="enabled"><option value="false"${!f.enabled?' selected':''}>Off — closed</option><option value="true"${f.enabled?' selected':''}>On — open</option></select>
      ${f.questions.map((q,n)=>`<section class="card" id="question-${n}"><h3>Question ${n+1}</h3><label for="q${n}_label">Question</label><input id="q${n}_label" name="q${n}_label" required maxlength="100" value="${e(q.label)}"><label for="q${n}_type">Answer type</label><select id="q${n}_type" name="q${n}_type">${Object.entries(types).map(([value,label])=>`<option value="${value}"${value===q.type?' selected':''}>${label}</option>`).join('')}</select>
      <label for="q${n}_required">Required?</label><select id="q${n}_required" name="q${n}_required"><option value="true"${q.required?' selected':''}>Yes</option><option value="false"${!q.required?' selected':''}>No</option></select>
      <label for="q${n}_options">Choice options, one per line</label><textarea id="q${n}_options" name="q${n}_options" maxlength="1100" rows="4">${e(q.options.join('\n'))}</textarea><p>For Multiple choice and Checkboxes: 2–10 distinct options, up to 100 characters each. Other types ignore this field.</p>
      ${n?`<button class="secondary" name="action" value="up:${n}" data-scroll-anchor="question-${n-1}" formaction="/forms?edit=${f.id}#question-${n-1}" formnovalidate>Move up</button>`:''} ${n<f.questions.length-1?`<button class="secondary" name="action" value="down:${n}" data-scroll-anchor="question-${n+1}" formaction="/forms?edit=${f.id}#question-${n+1}" formnovalidate>Move down</button>`:''} ${f.questions.length>1?`<button class="secondary" name="action" value="remove:${n}" formnovalidate>Remove question</button>`:''}</section>`).join('')}
      ${f.questions.length<25?`<button class="secondary" name="action" value="add" data-scroll-anchor="question-${f.questions.length}" formaction="/forms?edit=${f.id}#question-${f.questions.length}" formnovalidate>Add question</button>`:''} <button name="action" value="save">Save form</button></fieldset></form>
      <p>Up to 25 questions, in sections of five inside Discord. Short answers: 300 characters; paragraphs: 4,000. File questions accept one file, up to 10 MiB each and 20 MiB total. Files are saved with the response and downloaded through this staff website.</p></section>
      ${o.access==='admin'?`<section class="card"><h2>Post to Discord</h2><p>Publish saves all questions currently in the builder and creates a new Discord post with a Fill out form button. Set Accept responses to On above. Old posts open the current saved version; closing the form stops new answers through every post.</p>
      <label for="channel">Channel</label><select id="channel" name="channel" form="form-builder"><option value="">Choose channel</option>${channels.filter(c=>c.usable).map(c=>`<option value="${e(c.id)}"${c.id===selectedChannel?' selected':''}>#${e(c.name)}</option>`).join('')}</select>
      <button name="action" value="publish" form="form-builder">Publish form post</button><h3>Recent publications</h3>${publications.map(p=>`<p>${e(p.status)} · ${p.message_id?`<a href="https://discord.com/channels/${e(o.guildId)}/${e(p.channel_id)}/${e(p.message_id)}">View Discord post</a>`:e(p.channel_id)}</p>`).join('')||'<p>No publications yet.</p>'}<p>Unknown means delivery was not confirmed. Check Discord before publishing again.</p></section>
      ${f.revision?`<section class="card"><h2>Delete form</h2><p>Remove this form and choose whether to keep its submitted responses.</p><a class="button" href="/forms/delete/${f.id}">Delete form…</a></section>`:''}`:''}`;
  }
  const nextParams=new URLSearchParams({status:state,form:formFilter,view,page:String(page+1)});
  render('Forms',`<div class="hero"><div class="eyebrow">Applications, reports, signups and suggestions</div><h1>Forms and responses</h1><p>Build on the website, collect private answers inside Discord, and review submissions here.</p></div>${notice}
    <section class="card"><h2>Your forms</h2>${o.access==='admin'?'<p><a class="button" href="/forms?new=1">Create form</a></p>':'<p>Admins and Mods with full access can create and publish forms. All configured staff can review responses.</p>'}
    ${forms.map(f=>`<p><a href="/forms?edit=${f.id}">${e(f.title)}</a> · ${f.enabled?'Open':'Closed'} · ${f.questions.length} questions · <a href="/forms?status=all&form=${f.id}&view=answers">Answers table</a></p>`).join('')||'<p>No forms yet.</p>'}</section>${editorHtml}
    <section class="card"><h2>Submissions</h2><form method="get" action="/forms"><label for="status">Status</label><select id="status" name="status">${['pending','approved','rejected','all'].map(s=>`<option${state===s?' selected':''}>${s}</option>`).join('')}</select><label for="form-filter">Form</label><select id="form-filter" name="form"><option value="">All forms</option>${allForms.map(f=>`<option value="${f.id}"${f.id===formFilter?' selected':''}>${e(f.title)}${f.deleted?' (deleted)':''}</option>`).join('')}</select><label for="view">View</label><select id="view" name="view"><option value="list"${view==='list'?' selected':''}>Submission list</option><option value="answers"${view==='answers'?' selected':''}>Answers table — choose one form</option></select><button>Filter responses</button></form>
    ${view==='answers'&&!selectedForm?'<p>Choose a form above to see its answers in a table.</p>':''}${responseTable||`<div class="table-wrap"><table><thead><tr><th>Form / reference</th><th>Discord user</th><th>Status / decision DM</th><th>Submitted</th></tr></thead><tbody>${entries.slice(0,50).map(r=>`<tr><td><a href="/forms/responses/${r.id}">${e(r.title)}</a><div class="small">${e(r.id)}</div></td><td>${formUser(r)}</td><td>${e(r.state)} · ${e(r.dm_status)}</td><td>${time(r.submitted_at)}</td></tr>`).join('')||'<tr><td colspan="4">No responses match this filter.</td></tr>'}</tbody></table></div>`}${entries.length>50?`<p><a href="/forms?${e(nextParams)}">Older responses</a></p>`:''}${page?`<p><a href="/forms?${e(new URLSearchParams({status:state,form:formFilter,view}))}">Newest responses</a></p>`:''}</section>`);
}
