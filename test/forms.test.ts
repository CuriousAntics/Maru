import assert from 'node:assert/strict';
import { test, before, beforeEach, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import type { Interaction } from 'discord.js';
import { PGlite } from '@electric-sql/pglite';
import { saveForm, startForm, loadDraft, submitFormStep, reviewForm, queueFormPost, validateForm, deleteForm, saveAndPublishForm, deleteFormResponses, responseDeletionStamp } from '../src/forms.js';
import type { Form, Question, Answer, Entry } from '../src/forms.js';
import { formModal, handleFormInteraction, downloadFormFile, formInteractionIdentity, formIdentityReader } from '../src/forms-discord.js';
import { answerColumns, answersTable, enrichFormIdentities, formUser } from '../src/form-responses.js';
import { deliverForms } from '../src/forms-worker.js';
import type { FormsDelivery } from '../src/forms-worker.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { formProof, digest, randomToken } from '../src/web-security.js';
const db=new PGlite(),guild='100000000000000001',actor='200000000000000001',user='200000000000000002',admin='300000000000000001',mod='300000000000000002',channel='400000000000000001',bot='500000000000000001';
let token:string,roles:string[]|null,id:string,failAudit:boolean,interaction=600000000000000000n;
async function query(sql:string,params?:unknown[]) {
  if(failAudit&&sql.includes('INSERT INTO audit_events'))throw new Error('audit failed');
  const r=await db.query(sql,params);return {rows:r.rows,rowCount:r.rows.length||r.affectedRows||0};
}
const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
const context=()=>({guildId:guild,actorId:actor,token,readRoles:async()=>roles});
const q=(patch:Partial<Question>={}):Question=>({label:'Why apply?',type:'paragraph',required:true,options:[],...patch});
const config=(patch:Partial<Form>={})=>({title:'Staff applications',description:'Apply here',enabled:true,questions:[q()],...patch});
const save=(patch:Partial<Form>={},revision=0)=>saveForm(pool,{...context(),id,revision,form:config(patch)});
const answer=(question=q(),value:string|string[]='My answer'):Answer=>({label:question.label,type:question.type,value});
const step=(entry:Entry,answers=[answer()],files:any[]=[])=>submitFormStep(pool,{guildId:guild,id:entry.id,userId:entry.user_id,step:entry.step,interactionId:String(++interaction),answers,files});
const getEntry=async(entryId:string)=> (await query('SELECT * FROM form_entries WHERE guild_id=$1 AND id=$2',[guild,entryId])).rows[0] as Entry;
async function submit(){await save();return step(await startForm(pool,guild,id,user));}
let handler:ReturnType<typeof createDashboardHandler>,base:string;
const server=createServer((req,res)=>void handler(req,res));
const request=(path='/forms',init:RequestInit={})=>fetch(base+path,{...init,redirect:'manual',headers:{cookie:`maru_session=${token}`,connection:'close',...init.headers}});
const post=(path:string,body:URLSearchParams,origin=base)=>request(path,{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body});
const builder=()=>new URLSearchParams({csrf:formProof(token,`build:${id}:0`),id,revision:'0',count:'1',title:'Applications',description:'Test',enabled:'true',q0_label:'Why?',q0_type:'paragraph',q0_required:'true',q0_options:'',action:'save'});
let deliveries:{kind:string;body:any}[],deliveryError:unknown;
const deps:FormsDelivery={readRoles:async()=>roles,readChannels:async()=>[{id:channel,usable:true}],post:async(_,body)=>{deliveries.push({kind:'post',body});if(deliveryError)throw deliveryError;return '700000000000000001';},dm:async(_,body)=>{deliveries.push({kind:'dm',body});if(deliveryError)throw deliveryError;return '700000000000000002';}};
before(async()=>{
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async()=>{
  id=randomUUID();token=randomToken();roles=[admin];failAudit=false;deliveries=[];deliveryError=undefined;
  await db.exec('TRUNCATE guild_settings CASCADE');await query('INSERT INTO guild_settings(guild_id) VALUES ($1)',[guild]);
  await query("INSERT INTO staff_roles(guild_id,role_id,access_level) VALUES ($1,$2,'admin'),($1,$3,'moderator')",[guild,admin,mod]);
  await query("INSERT INTO dashboard_sessions(token_hash,guild_id,user_id,display_name,expires_at) VALUES ($1,$2,$3,'Tester',NOW()+INTERVAL '1 hour')",[digest(token),guild,actor]);
  handler=createDashboardHandler({pool,guildId:guild,config:{origin:base,applicationId:bot,clientSecret:'fake',secure:false},isBotReady:()=>true,readMemberRoles:async()=>roles,readLogChannels:async()=>[{id:channel,name:'applications',usable:true}]});
});
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();});
test('save all five question types and serialize a Discord modal',async()=>{
  const questions=[q({type:'short'}),q(),q({type:'choice',options:['A','B']}),q({type:'checkboxes',options:['Red','Blue']}),q({type:'file'})];
  await save({questions});const e=await startForm(pool,guild,id,user),modal=formModal(e).toJSON();
  assert.equal(modal.components.length,5);assert.deepEqual(modal.components.map((v:any)=>v.component.type),[4,4,21,22,19]);
  assert.equal((modal.components[0] as any).component.max_length,300);
});
for(const patch of [{title:''},{title:'x'.repeat(46)},{description:'x'.repeat(1001)},{questions:[]},{questions:Array.from({length:26},()=>q())},{questions:[q({label:''})]},{questions:[q({type:'choice',options:['A']})]},{questions:[q({type:'choice',options:['A','A']})]},{questions:[q({type:'checkboxes',options:Array.from({length:11},(_,n)=>String(n))})]}])test('invalid builder configuration rejected '+JSON.stringify(patch).slice(0,70),async()=>{await assert.rejects(save(patch),/INVALID_INPUT/);});
test('only current Admin or full-access Mod can build; expired sessions denied',async()=>{
  for(const r of [null,[],[mod]]){roles=r;await assert.rejects(save(),/STAFF_REQUIRED/);}
  roles=[mod];await query('INSERT INTO staff_access_grants(guild_id,user_id,granted_by) VALUES ($1,$2,$2)',[guild,actor]);await save();
  await query('DELETE FROM dashboard_sessions');await assert.rejects(save({},1),/SESSION_EXPIRED/);
});
test('save conflicts and audit failure preserve the previous configuration',async()=>{
  failAudit=true;await assert.rejects(save());assert.equal((await query('SELECT * FROM forms')).rowCount,0);failAudit=false;
  await save();await assert.rejects(save({title:'Replacement'}),/STALE/);
  assert.equal((await query('SELECT title FROM forms')).rows[0].title,'Staff applications');
});
test('draft resumes by owner, expires, and cannot be continued by another member',async()=>{
  await save();const e=await startForm(pool,guild,id,user);assert.equal((await startForm(pool,guild,id,user)).id,e.id);
  await assert.rejects(loadDraft(pool,guild,e.id,actor),/EXPIRED/);
  await query("UPDATE form_entries SET expires_at=NOW()-INTERVAL '1 second'");await assert.rejects(loadDraft(pool,guild,e.id,user),/EXPIRED/);
  assert.notEqual((await startForm(pool,guild,id,user)).id,e.id);
});
test('edits invalidate old drafts while snapshots preserve finished responses',async()=>{
  const finished=await submit();await save({title:'New title'},1);
  assert.equal((await getEntry(finished.id)).snapshot.title,'Staff applications');
  const draft=await startForm(pool,guild,id,actor);await save({},2);
  await assert.rejects(step(draft),/EXPIRED/);assert.notEqual((await startForm(pool,guild,id,actor)).id,draft.id);
});
test('closed forms reject new drafts and outstanding section submissions',async()=>{
  await save();const draft=await startForm(pool,guild,id,user);await save({enabled:false},1);
  await assert.rejects(startForm(pool,guild,id,user),/CLOSED/);await assert.rejects(step(draft),/EXPIRED/);
});
test('long forms save sections, reject stale steps and submit only at completion',async()=>{
  const questions=Array.from({length:7},(_,n)=>q({label:'Question '+n}));await save({questions});let draft=await startForm(pool,guild,id,user);
  draft=await step(draft,questions.slice(0,5).map(q=>answer(q)));assert.equal(draft.state,'draft');assert.equal(draft.step,1);
  assert.match(formModal(draft).toJSON().title,/\(2\/2\)/);
  await assert.rejects(step({...draft,step:0},questions.slice(0,5).map(q=>answer(q))),/STALE/);
  const finished=await step(draft,questions.slice(5).map(q=>answer(q)));assert.equal(finished.state,'pending');assert.equal(finished.answers.length,7);
});
test('25-question form fits five steps including the final page',async()=>{
  const questions=Array.from({length:25},(_,n)=>q({label:'Question '+n}));await save({questions});let e=await startForm(pool,guild,id,user);
  for(let n=0;n<5;n++){assert.equal(formModal(e).toJSON().components.length,5);e=await step(e,questions.slice(n*5,n*5+5).map(q=>answer(q)));}
  assert.equal(e.state,'pending');assert.equal(e.step,5);
});
for(const bad of ['', 'x'.repeat(4001)])test('invalid required paragraph rejected '+bad.length,async()=>{await save();const e=await startForm(pool,guild,id,user);await assert.rejects(step(e,[answer(q(),bad)]),/INVALID_ANSWERS/);});
test('choices are restricted to configured options; checkbox duplicates rejected',async()=>{
  const questions=[q({type:'choice',options:['A','B']}),q({type:'checkboxes',options:['A','B']})];await save({questions});const e=await startForm(pool,guild,id,user);
  for(const values of [[['C'],['A']],[['A','B'],['A']],[['A'],['B','B']],[[],['A']]])await assert.rejects(step(e,questions.map((q,n)=>answer(q,values[n]!))),/INVALID_ANSWERS/);
  assert.equal((await step(e,questions.map(q=>answer(q,['B'])))).state,'pending');
});
test('optional answers serialize without forcing text, choices or uploads',async()=>{
  const questions=[q({required:false}),q({type:'choice',required:false,options:['A','B']}),q({type:'file',required:false})];await save({questions});
  const e=await startForm(pool,guild,id,user);await step(e,[answer(questions[0]!,''),answer(questions[1]!,[]),answer(questions[2]!,'')]);
});
test('files persist as bytes and expired draft cleanup removes their files',async()=>{
  const questions=[q({type:'file'}),...Array.from({length:5},()=>q())];await save({questions});const e=await startForm(pool,guild,id,user),fileId=randomUUID();
  const draft=await step(e,[{...answer(questions[0]!,''),fileId,filename:'test.txt'},...questions.slice(1,5).map(q=>answer(q))],[{id:fileId,filename:'test.txt',data:Buffer.from('file content')}]);
  assert.equal(Buffer.from((await query('SELECT data FROM form_files')).rows[0].data).toString(),'file content');
  await query("UPDATE form_entries SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[draft.id]);await deliverForms(pool,guild,deps);assert.equal((await query('SELECT * FROM form_files')).rowCount,0);
});
test('missing required files and oversized uploads do not save a section',async()=>{
  const question=q({type:'file'});await save({questions:[question]});const e=await startForm(pool,guild,id,user);
  await assert.rejects(step(e,[answer(question,'')]),/INVALID_ANSWERS/);const fileId=randomUUID();
  await assert.rejects(step(e,[{...answer(question,''),fileId,filename:'huge.bin'}],[{id:fileId,filename:'huge.bin',data:Buffer.alloc(10*1024*1024+1)}]),/FILE_SIZE/);
  assert.equal((await getEntry(e.id)).state,'draft');assert.equal((await query('SELECT * FROM form_files')).rowCount,0);
});
test('interaction replay saves once, even after review',async()=>{
  await save();const e=await startForm(pool,guild,id,user),i={guildId:guild,id:e.id,userId:user,step:0,interactionId:String(++interaction),answers:[answer()],files:[]};
  await submitFormStep(pool,i);await submitFormStep(pool,i);assert.equal((await query('SELECT * FROM form_entries')).rowCount,1);
  await reviewForm(pool,{...context(),id:e.id,revision:1,decision:'approved',message:''});assert.equal((await submitFormStep(pool,i)).state,'approved');
});
test('submission cooldown applies across forms even if both drafts opened earlier',async()=>{
  await save();const e=await startForm(pool,guild,id,user);const other=randomUUID();await saveForm(pool,{...context(),id:other,revision:0,form:config()});const otherDraft=await startForm(pool,guild,other,user);
  await step(e);await assert.rejects(step(otherDraft),/COOLDOWN/);
  await assert.rejects(startForm(pool,guild,id,user),/COOLDOWN/);
});
test('review is staff only, one decision wins, answers are absent from audit and DM',async()=>{
  const e=await submit();roles=[];await assert.rejects(reviewForm(pool,{...context(),id:e.id,revision:1,decision:'approved',message:''}),/STAFF_REQUIRED/);
  roles=[mod];await reviewForm(pool,{...context(),id:e.id,revision:1,decision:'rejected',message:'Please try again.'});
  await assert.rejects(reviewForm(pool,{...context(),id:e.id,revision:1,decision:'approved',message:''}),/STALE/);
  await deliverForms(pool,guild,deps);assert.equal((await getEntry(e.id)).dm_status,'sent');assert.match(deliveries[0]!.body.content,/Please try again/);
  assert.doesNotMatch(JSON.stringify(deliveries),/My answer/);assert.doesNotMatch(JSON.stringify((await query('SELECT details FROM audit_events')).rows),/My answer|Please try again/);
});
test('review audit failure rolls back decision and queued DM',async()=>{
  const e=await submit();failAudit=true;await assert.rejects(reviewForm(pool,{...context(),id:e.id,revision:1,decision:'approved',message:''}));
  assert.equal((await getEntry(e.id)).state,'pending');assert.equal((await getEntry(e.id)).dm_status,'none');
});
test('publication queue is idempotent, targets selected channel and suppresses mentions',async()=>{
  await save();const p={...context(),id:randomUUID(),formId:id,revision:1,channelId:channel,readChannels:deps.readChannels};
  await queueFormPost(pool,p);await queueFormPost(pool,p);await deliverForms(pool,guild,deps);await deliverForms(pool,guild,deps);
  assert.equal(deliveries.length,1);assert.deepEqual(deliveries[0]!.body.allowed_mentions,{parse:[]});assert.equal(deliveries[0]!.body.components[0].components[0].custom_id,`forms:start:${id}`);
  assert.equal((await query('SELECT status FROM form_publications')).rows[0].status,'sent');
});
test('publication validates channel, form revision, availability and current staff access',async()=>{
  await save();const p={...context(),id:randomUUID(),formId:id,revision:1,channelId:channel,readChannels:deps.readChannels};
  await assert.rejects(queueFormPost(pool,{...p,revision:0}),/STALE/);
  await assert.rejects(queueFormPost(pool,{...p,readChannels:async()=>[]}),/CHANNEL/);
  await queueFormPost(pool,p);roles=[];await deliverForms(pool,guild,deps);assert.equal(deliveries.length,0);assert.equal((await query('SELECT status FROM form_publications')).rows[0].status,'failed');
});
for(const err of [Object.assign(new Error('blocked'),{code:50007}),new Error('timeout')])test('notification outcome '+err.message+' is recorded without automatic resend',async()=>{
  const e=await submit();await reviewForm(pool,{...context(),id:e.id,revision:1,decision:'approved',message:''});deliveryError=err;
  await deliverForms(pool,guild,deps);await deliverForms(pool,guild,deps);assert.equal(deliveries.length,1);assert.equal((await getEntry(e.id)).dm_status,err.message==='blocked'?'failed':'unknown');
});
test('interrupted sends become unknown on restart and are not retried',async()=>{
  const e=await submit();await reviewForm(pool,{...context(),id:e.id,revision:1,decision:'approved',message:''});await query("UPDATE form_entries SET dm_status='sending',dm_started_at=NOW()-INTERVAL '3 minutes'");
  await deliverForms(pool,guild,deps);assert.equal((await getEntry(e.id)).dm_status,'unknown');assert.equal(deliveries.length,0);
});
test('website builds, preserves question order and queues publication',async()=>{
  let response=await post('/forms',builder());assert.equal(response.status,303);
  response=await request('/forms?edit='+id);const html=await response.text();assert.match(html,/Fill out form/);assert.match(html,/File upload/);assert.match(html,/Publish form post/);
  const p=builder();p.set('csrf',formProof(token,`build:${id}:1`));p.set('revision','1');p.set('action','publish');p.set('request_id',randomUUID());p.set('channel',channel);assert.equal((await post('/forms',p)).status,303);
  const build=builder();build.set('revision','2');build.set('csrf',formProof(token,`build:${id}:2`));build.set('action','add');
  const added=await post('/forms',build);assert.equal(added.status,200);assert.match(await added.text(),/Question 2/);assert.equal((await query('SELECT revision FROM forms')).rows[0].revision,2);
});
test('website rejects cross-origin requests, bad proofs and duplicate fields',async()=>{
  assert.equal((await post('/forms',builder(),'https://example.com')).status,403);
  const bad=builder();bad.set('csrf','bad');assert.equal((await post('/forms',bad)).status,403);
  const duplicate=builder();duplicate.append('title','Other title');assert.equal((await post('/forms',duplicate)).status,409);
  assert.equal((await query('SELECT * FROM forms')).rowCount,0);
});
test('website review escapes answers, validates proof and queues DM',async()=>{
  await save();const draft=await startForm(pool,guild,id,user);const e=await step(draft,[answer(q(),'<script>alert(1)</script>')]);
  let response=await request('/forms/responses/'+e.id);let html=await response.text();assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
  const p=new URLSearchParams({csrf:formProof(token,`review:${e.id}:1`),revision:'1',decision:'approved',message:'Welcome!'});
  assert.equal((await post('/forms/responses/'+e.id,p)).status,303);assert.equal((await getEntry(e.id)).dm_status,'pending');
});
test('website file downloads require current staff, hide drafts and use attachment headers',async()=>{
  const question=q({type:'file'});await save({questions:[question]});const draft=await startForm(pool,guild,id,user),fileId=randomUUID();
  await step(draft,[{...answer(question,''),fileId,filename:'notes.html'}],[{id:fileId,filename:'notes.html',data:Buffer.from('<b>file</b>')}]);
  const response=await request('/forms/files/'+fileId);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition')!,/^attachment;/);assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(await response.text(),'<b>file</b>');roles=[];assert.equal((await request('/forms/files/'+fileId)).status,403);
});
test('forms and files are scoped to the configured guild',async()=>{
  const e=await submit();const otherGuild='100000000000000002';await query('INSERT INTO guild_settings(guild_id) VALUES ($1)',[otherGuild]);
  await assert.rejects(loadDraft(pool,otherGuild,e.id,user),/EXPIRED/);
  await assert.rejects(startForm(pool,otherGuild,id,user),/CLOSED/);
});
test('file download accepts only Discord attachments, enforces actual size and refuses redirects',async()=>{
  let called=0;const fake=(async(_url:any,init:any)=>{called++;assert.equal(init.redirect,'error');return new Response('abc');}) as typeof fetch;
  assert.equal((await downloadFormFile('https://cdn.discordapp.com/attachments/1/2/test.txt?ex=abc',3,fake)).toString(),'abc');
  for(const url of ['https://example.com/file','http://cdn.discordapp.com/attachments/1/2/a','https://cdn.discordapp.com.evil.com/attachments/a','https://cdn.discordapp.com/not-attachments/a'])await assert.rejects(downloadFormFile(url,3,fake));
  assert.equal(called,1);await assert.rejects(downloadFormFile('https://cdn.discordapp.com/attachments/1/2/test.txt',2,fake),/FILE_SIZE/);
});
test('Discord button creates private draft and opens the next modal',async()=>{
  await save();const output:any[]=[];let deferred=false;
  const button=(customId:string)=>({customId,guildId:guild,member:{},user:{id:user,bot:false},isButton:()=>true,isModalSubmit:()=>false,get deferred(){return deferred;},replied:false,deferReply:async(v:any)=>{deferred=true;output.push(v);},editReply:async(v:any)=>output.push(v),reply:async(v:any)=>output.push(v),showModal:async(v:any)=>output.push(v.toJSON())}) as unknown as Interaction;
  assert.equal(await handleFormInteraction(button('forms:start:'+id),pool,guild),true);assert.equal(output[0].flags,64);assert.match(output[1].content,/Discord identity/);
  const next=output[1].components[0].components[0].custom_id;deferred=false;await handleFormInteraction(button(next),pool,guild);assert.match(output[2].custom_id,/^forms:submit:/);
});
test('Discord modal submission collects all five types and persists uploaded bytes once',async()=>{
  const {ModalSubmitFields,Collection}=await import('discord.js');
  const questions=[q({type:'short'}),q(),q({type:'choice',options:['A','B']}),q({type:'checkboxes',options:['Red','Blue']}),q({type:'file'})];await save({questions});
  const draft=await startForm(pool,guild,id,user);
  const fields=Reflect.construct(ModalSubmitFields,[
    [{type:18,component:{type:4,customId:'q0',value:'Short answer'}},
     {type:18,component:{type:4,customId:'q1',value:'Paragraph answer'}},
     {type:18,component:{type:21,customId:'q2',value:'1'}},
     {type:18,component:{type:22,customId:'q3',values:['0','1']}},
     {type:18,component:{type:19,customId:'q4',attachments:new Collection([['800000000000000001',{name:'portfolio.txt',size:9,url:'https://cdn.discordapp.com/attachments/1/2/portfolio.txt'}]])}}]
  ]);
  const replies:any[]=[],interactionId=String(++interaction);let deferred=false,downloads=0;
  const modal={id:interactionId,customId:`forms:submit:${draft.id}:0`,guildId:guild,member:{nick:'Mandy Server'},user:{id:user,bot:false,username:'mandy',globalName:'Mandy Global'},fields,isButton:()=>false,isModalSubmit:()=>true,get deferred(){return deferred;},replied:false,deferReply:async()=>{deferred=true;},editReply:async(v:any)=>replies.push(v),reply:async(v:any)=>replies.push(v)} as unknown as Interaction;
  const fetcher=(async()=>{downloads++;return new Response('Portfolio');}) as typeof fetch;
  await handleFormInteraction(modal,pool,guild,fetcher);
  const e=await getEntry(draft.id);assert.equal(e.state,'pending');assert.equal(e.username,'mandy');assert.equal(e.display_name,'Mandy Server');assert.deepEqual(e.answers.slice(0,4).map(a=>a.value),['Short answer','Paragraph answer',['B'],['Red','Blue']]);
  assert.match(replies[0].content,/submitted/);assert.equal(Buffer.from((await query('SELECT data FROM form_files')).rows[0].data).toString(),'Portfolio');
  await handleFormInteraction(modal,pool,guild,fetcher);assert.equal(downloads,1);assert.equal((await query('SELECT * FROM form_entries')).rowCount,1);
});
test('website reorders and removes questions while preserving unsaved input',async()=>{
  const p=builder();p.set('count','2');p.set('q0_label','First question');p.set('q1_label','Second question');p.set('q1_type','choice');p.set('q1_required','false');p.set('q1_options','A\nB');p.set('action','up:1');
  let response=await post('/forms',p),html=await response.text();assert.equal(response.status,200);assert.ok(html.indexOf('value="Second question"')<html.indexOf('value="First question"'));assert.equal((await query('SELECT * FROM forms')).rowCount,0);
  p.set('action','remove:0');response=await post('/forms',p);html=await response.text();assert.equal(response.status,200);assert.match(html,/value="Second question"/);assert.doesNotMatch(html,/value="First question"/);
});
test('ordinary Mods can review but cannot build or publish forms via HTTP',async()=>{
  const e=await submit();roles=[mod];assert.equal((await post('/forms',builder())).status,403);
  const p=new URLSearchParams({csrf:formProof(token,`review:${e.id}:1`),revision:'1',decision:'rejected',message:'Try next time'});assert.equal((await post('/forms/responses/'+e.id,p)).status,303);
});
test('draft attachment cannot be downloaded before final submission',async()=>{
  await save({questions:[q({type:'file'}),...Array.from({length:5},()=>q())]});const e=await startForm(pool,guild,id,user),fileId=randomUUID();
  await step(e,[{...answer(q({type:'file'}),''),fileId,filename:'draft.txt'},...Array.from({length:4},()=>answer())],[{id:fileId,filename:'draft.txt',data:Buffer.from('private draft')}]);
  assert.equal((await request('/forms/files/'+fileId)).status,404);assert.equal((await request('/forms/responses/'+e.id)).status,404);
});

const removeForm=(patch={})=>deleteForm(pool,{...context(),id,revision:1,retention:'keep',confirmation:'DELETE',...patch});
test('deleting a form hides it and closes old buttons while retaining reviewable responses',async()=>{
  const e=await submit();await removeForm();
  const form=(await query('SELECT * FROM forms')).rows[0];assert.equal(form.deleted,true);assert.equal(form.enabled,false);
  await assert.rejects(startForm(pool,guild,id,user),/CLOSED/);await assert.rejects(save({},2),/NOT_FOUND/);
  assert.equal((await getEntry(e.id)).state,'pending');assert.equal((await request('/forms/responses/'+e.id)).status,200);
  const html=await (await request('/forms?edit='+id)).text();assert.doesNotMatch(html,/Edit form/);assert.match(html,/Staff applications \(deleted\)/);
  await reviewForm(pool,{...context(),id:e.id,revision:1,decision:'approved',message:'Retained review'});
  await removeForm({retention:'purge'});assert.equal((await getEntry(e.id)).state,'approved');
});
test('deletion purges submitted responses and files only when explicitly selected',async()=>{
  const question=q({type:'file'});await save({questions:[question]});const e=await startForm(pool,guild,id,user),fileId=randomUUID();
  await step(e,[{...answer(question,''),fileId,filename:'sample.txt'}],[{id:fileId,filename:'sample.txt',data:Buffer.from('sample')}]);
  await removeForm({retention:'purge'});
  for(const table of ['form_entries','form_files','form_steps'])assert.equal((await query('SELECT * FROM '+table)).rowCount,0);
  assert.equal((await request('/forms/files/'+fileId)).status,404);
});
test('deletion always discards unfinished drafts and their files',async()=>{
  const questions=[q({type:'file'}),...Array.from({length:5},()=>q())];await save({questions});
  const draft=await startForm(pool,guild,id,user),fileId=randomUUID();
  await step(draft,[{...answer(questions[0]!,''),fileId,filename:'draft.txt'},...questions.slice(1,5).map(q=>answer(q))],[{id:fileId,filename:'draft.txt',data:Buffer.from('draft')}]);
  await removeForm();assert.equal((await query('SELECT * FROM form_entries')).rowCount,0);assert.equal((await query('SELECT * FROM form_files')).rowCount,0);
});
test('deleting requires current full access, confirmation and a live session',async()=>{
  await save();roles=[mod];await assert.rejects(removeForm(),/STAFF_REQUIRED/);roles=[admin];
  await assert.rejects(removeForm({confirmation:''}),/DELETE_CONFIRMATION/);await assert.rejects(removeForm({retention:'other'}),/DELETE_CONFIRMATION/);
  await query('DELETE FROM dashboard_sessions');await assert.rejects(removeForm(),/SESSION_EXPIRED/);
  assert.equal((await query('SELECT deleted FROM forms')).rows[0].deleted,false);
});
test('stale deletion and in-flight publication are rejected; audit failure rolls back deletion',async()=>{
  await save();await save({},1);await assert.rejects(removeForm(),/STALE/);
  const publication={...context(),id:randomUUID(),formId:id,revision:2,channelId:channel,readChannels:deps.readChannels};await queueFormPost(pool,publication);
  await query("UPDATE form_publications SET status='sending'");await assert.rejects(removeForm({revision:2}),/BUSY/);
  await query("UPDATE form_publications SET status='pending'");const e=await startForm(pool,guild,id,user);
  failAudit=true;await assert.rejects(removeForm({revision:2}));failAudit=false;
  assert.equal((await query('SELECT deleted FROM forms')).rows[0].deleted,false);assert.ok(await getEntry(e.id));assert.equal((await query('SELECT status FROM form_publications')).rows[0].status,'pending');
});
test('deletion cancels queued posts without sending them',async()=>{
  await save();await queueFormPost(pool,{...context(),id:randomUUID(),formId:id,revision:1,channelId:channel,readChannels:deps.readChannels});
  await removeForm();await deliverForms(pool,guild,deps);assert.deepEqual(deliveries,[]);assert.equal((await query('SELECT status FROM form_publications')).rows[0].status,'failed');
});
test('HTTP delete confirmation is separate, scoped, protected and defaults to keeping responses',async()=>{
  const e=await submit();let response=await request('/forms/delete/'+id);assert.equal(response.status,200);let html=await response.text();assert.match(html,/Saved submissions: 1/);assert.match(html,/<option value="keep">Keep/);
  const p=new URLSearchParams({csrf:formProof(token,`delete:${id}:1`),revision:'1',retention:'keep',confirmation:'DELETE'});
  assert.equal((await post('/forms/delete/'+id,p,'https://example.com')).status,403);
  const wrong=new URLSearchParams(p);wrong.set('csrf',formProof(token,`build:${id}:1`));assert.equal((await post('/forms/delete/'+id,wrong)).status,403);
  wrong.set('csrf',p.get('csrf')!);wrong.set('confirmation','');assert.equal((await post('/forms/delete/'+id,wrong)).status,409);
  roles=[mod];assert.equal((await request('/forms/delete/'+id)).status,403);assert.equal((await post('/forms/delete/'+id,p)).status,403);roles=[admin];
  assert.equal((await post('/forms/delete/'+id,p)).status,303);assert.equal((await request('/forms/responses/'+e.id)).status,200);
});
test('builder actions identify their question anchors and dashboard script uses its CSP nonce',async()=>{
  await save({questions:[q(),q({label:'Second question'})]});const response=await request('/forms?edit='+id),html=await response.text();
  assert.match(html,/id="question-0"/);assert.match(html,/data-scroll-anchor="question-2"/);assert.match(html,/formaction="[^"]+#question-2"/);
  const nonce=/<script nonce="([^"]+)">/.exec(html)?.[1];assert.ok(nonce);assert.match(response.headers.get('content-security-policy')!,new RegExp("script-src 'nonce-"+nonce+"'"));
});

test('retained submitted files remain downloadable after form deletion',async()=>{
  const question=q({type:'file'});await save({questions:[question]});const e=await startForm(pool,guild,id,user),fileId=randomUUID();
  await step(e,[{...answer(question,''),fileId,filename:'retained.txt'}],[{id:fileId,filename:'retained.txt',data:Buffer.from('retained bytes')}]);
  await removeForm();const response=await request('/forms/files/'+fileId);assert.equal(response.status,200);assert.equal(await response.text(),'retained bytes');
});

function publishBuilder(revision=1) {
  const p=builder();p.set('revision',String(revision));p.set('csrf',formProof(token,`build:${id}:${revision}`));p.set('action','publish');p.set('request_id',randomUUID());p.set('channel',channel);return p;
}
function addQuestion(p:URLSearchParams,n:number,question:Question) {
  p.set('q'+n+'_label',question.label);p.set('q'+n+'_type',question.type);p.set('q'+n+'_required',String(question.required));p.set('q'+n+'_options',question.options.join('\n'));
}
test('publish saves all newly added question types from the builder before queuing Discord',async()=>{
  await save();const p=publishBuilder(),questions=[q({type:'short'}),q({label:'New paragraph'}),q({type:'choice',label:'Area',options:['Art','Programming','Both']}),q({type:'checkboxes',label:'Tools',options:['Blender','Houdini']}),q({type:'file',label:'Upload sample'})];
  p.set('count','5');questions.forEach((q,n)=>addQuestion(p,n,q));
  assert.equal((await post('/forms?edit='+id,p)).status,303);
  const saved=(await query('SELECT * FROM forms')).rows[0];assert.equal(saved.revision,2);assert.deepEqual(saved.questions,questions);
  const publication=(await query('SELECT * FROM form_publications')).rows[0];assert.equal(publication.form_revision,2);
  await deliverForms(pool,guild,deps);assert.equal(deliveries.length,1);assert.deepEqual((await startForm(pool,guild,id,user)).snapshot.questions,questions);
  const page=await request('/forms?edit='+id+'&published=1');assert.match(await page.text(),/Saved all 5 questions/);
});
test('adding and moving unsaved questions then publishing retains every field and its order',async()=>{
  await save();const p=publishBuilder();p.set('action','add');assert.equal((await post('/forms',p)).status,200);
  p.set('count','2');addQuestion(p,0,q({label:'Original edited'}));addQuestion(p,1,q({label:'Added before publish',type:'choice',options:['A','B']}));p.set('action','up:1');
  let response=await post('/forms',p),html=await response.text();assert.ok(html.indexOf('value="Added before publish"')<html.indexOf('value="Original edited"'));
  addQuestion(p,0,q({label:'Added before publish',type:'choice',options:['A','B']}));addQuestion(p,1,q({label:'Original edited'}));p.set('action','publish');
  assert.equal((await post('/forms',p)).status,303);assert.deepEqual(((await query('SELECT questions FROM forms')).rows[0].questions as Question[]).map(q=>q.label),['Added before publish','Original edited']);
});
test('publish button and channel use the same builder form; Enter defaults to Save',async()=>{
  await save();const html=await (await request('/forms?edit='+id)).text();
  assert.equal((html.match(/id="form-builder"/g)??[]).length,1);assert.match(html,/<button name="action" value="publish" form="form-builder">Publish form post/);
  assert.match(html,/<select id="channel" name="channel" form="form-builder">/);
  const editor=html.slice(html.indexOf('<form id="form-builder"'));assert.match(editor.slice(0,editor.indexOf('</form>')),/<legend>[^<]+<\/legend><button name="action" value="save">/);
});
test('a new form can be saved and published in one operation',async()=>{
  const p=publishBuilder(0);assert.equal((await post('/forms?new=1',p)).status,303);
  assert.equal((await query('SELECT revision FROM forms')).rows[0].revision,1);assert.equal((await query('SELECT form_revision FROM form_publications')).rows[0].form_revision,1);
});
test('invalid publish channel retains unsaved questions and leaves saved settings unchanged',async()=>{
  await save();const p=publishBuilder();p.set('count','2');addQuestion(p,1,q({label:'Unsaved question'}));p.set('channel','');
  const response=await post('/forms',p);assert.equal(response.status,409);const html=await response.text();assert.match(html,/value="Unsaved question"/);assert.match(html,/Question 2/);
  assert.equal(((await query('SELECT questions FROM forms')).rows[0].questions as Question[]).length,1);assert.equal((await query('SELECT * FROM form_publications')).rowCount,0);
});
test('invalid choice options keep all current edits visible and do not queue an older version',async()=>{
  await save();const p=publishBuilder();p.set('count','2');addQuestion(p,1,q({label:'Choose one',type:'choice',options:['Only one option']}));
  const response=await post('/forms',p);assert.equal(response.status,409);const html=await response.text();assert.match(html,/value="Choose one"/);assert.match(html,/Only one option/);assert.equal((await query('SELECT * FROM form_publications')).rowCount,0);
});
test('save-and-publish rolls back all questions when its final audit event fails',async()=>{
  await save();
  const failing={...pool,connect:async()=>({query:async(sql:string,values?:unknown[])=>{if(sql.includes('INSERT INTO audit_events')&&values?.[2]==='FORM_POST_QUEUED')throw new Error('publication audit failed');return query(sql,values);},release(){}})} as unknown as Pool;
  await assert.rejects(saveAndPublishForm(failing,{...context(),id,revision:1,form:config({questions:[q(),q({label:'Must roll back'})]}),requestId:randomUUID(),channelId:channel,readChannels:deps.readChannels}));
  const saved=(await query('SELECT * FROM forms')).rows[0];assert.equal(saved.revision,1);assert.equal((saved.questions as Question[]).length,1);assert.equal((await query('SELECT * FROM form_publications')).rowCount,0);
});
test('double-clicking publish does not save a second revision or queue a duplicate post',async()=>{
  await save();const p=publishBuilder();assert.equal((await post('/forms',p)).status,303);assert.equal((await post('/forms',p)).status,303);
  assert.equal((await query('SELECT revision FROM forms')).rows[0].revision,2);assert.equal((await query('SELECT * FROM form_publications')).rowCount,1);
  await deliverForms(pool,guild,deps);await deliverForms(pool,guild,deps);assert.equal(deliveries.length,1);
});
test('closed or stale editor cannot save-and-publish over the current form',async()=>{
  await save();let p=publishBuilder();p.set('enabled','false');assert.equal((await post('/forms',p)).status,409);assert.equal((await query('SELECT enabled FROM forms')).rows[0].enabled,true);
  await save({title:'Changed in another tab'},1);p=publishBuilder();const response=await post('/forms',p);assert.equal(response.status,409);assert.equal((await query('SELECT title FROM forms')).rows[0].title,'Changed in another tab');assert.equal((await query('SELECT * FROM form_publications')).rowCount,0);
});
test('publish still requires current full staff access and builder CSRF proof',async()=>{
  await save();const p=publishBuilder();roles=[mod];assert.equal((await post('/forms',p)).status,403);roles=[admin];p.set('csrf',formProof(token,`publish:${id}:1`));assert.equal((await post('/forms',p)).status,403);
  assert.equal((await query('SELECT revision FROM forms')).rows[0].revision,1);assert.equal((await query('SELECT * FROM form_publications')).rowCount,0);
});

test('reusing a publish request with changed questions is rejected instead of silently losing edits',async()=>{
  await save();const p=publishBuilder();assert.equal((await post('/forms',p)).status,303);
  p.set('count','2');addQuestion(p,1,q({label:'Different questions on repeated request'}));const response=await post('/forms',p);assert.equal(response.status,409);assert.match(await response.text(),/Different questions on repeated request/);
  assert.equal((await query('SELECT * FROM form_publications')).rowCount,1);
});

async function namedSubmit(username='mandy',displayName='Mandy') {
  await save();const e=await startForm(pool,guild,id,user);
  return submitFormStep(pool,{guildId:guild,id:e.id,userId:user,step:0,interactionId:String(++interaction),answers:[answer()],files:[],identity:{username,displayName}});
}
function withIdentityReader(readFormIdentity:any) {
  handler=createDashboardHandler({pool,guildId:guild,config:{origin:base,applicationId:bot,clientSecret:'fake',secure:false},isBotReady:()=>true,readMemberRoles:async()=>roles,readFormIdentity});
}
test('submission records display name and username from Discord, alongside the stable user ID',async()=>{
  const e=await namedSubmit();assert.equal(e.username,'mandy');assert.equal(e.display_name,'Mandy');assert.equal(e.user_id,user);assert.equal(e.identity_source,'submission');
  let calls=0;withIdentityReader(async()=>{calls++;return {username:'renamed',displayName:'New name'};});
  const response=await request('/forms/responses/'+e.id),html=await response.text();assert.equal(response.status,200);assert.match(html,/@mandy/);assert.match(html,/Mandy/);assert.match(html,new RegExp(user));assert.equal(calls,0);
});
test('submission-time identity is captured at the final section and replay does not replace it',async()=>{
  const questions=Array.from({length:6},()=>q());await save({questions});let entry=await startForm(pool,guild,id,user);
  entry=await step(entry,questions.slice(0,5).map(q=>answer(q)));assert.equal(entry.username,null);
  const input={guildId:guild,id:entry.id,userId:user,step:1,interactionId:String(++interaction),answers:[answer()],files:[],identity:{username:'final_name',displayName:'Final name'}};
  await submitFormStep(pool,input);await submitFormStep(pool,{...input,identity:{username:'later_name',displayName:'Later'}});assert.equal((await getEntry(entry.id)).username,'final_name');
});
test('Discord identity prefers server nickname, then global display name, then username',()=>{
  const i=(member:any,userPatch={})=>({member,user:{id:user,username:'mandy',globalName:'Mandy Global',...userPatch}}) as any;
  assert.deepEqual(formInteractionIdentity(i({nickname:'Server Nick'})),{username:'mandy',displayName:'Server Nick'});
  assert.equal(formInteractionIdentity(i({nick:'API Nick'}))?.displayName,'API Nick');assert.equal(formInteractionIdentity(i({nick:null}))?.displayName,'Mandy Global');assert.equal(formInteractionIdentity(i({}, {globalName:null}))?.displayName,'mandy');
});
test('legacy ID-only submissions get labelled lookup names without changing saved answers',async()=>{
  const e=await submit();let calls=0;withIdentityReader(async(uid:string)=>{calls++;assert.equal(uid,user);return {username:'mandy_now',displayName:'Mandy Today'};});
  const html=await (await request('/forms/responses/'+e.id)).text();assert.match(html,/@mandy_now/);assert.match(html,/Name retrieved after submission/);assert.match(html,/My answer/);
  assert.equal((await getEntry(e.id)).identity_source,'lookup');await request('/forms/responses/'+e.id);assert.equal(calls,1);
});
test('unavailable legacy profiles keep answers accessible and back off repeated lookups',async()=>{
  const e=await submit();let calls=0;withIdentityReader(async()=>{calls++;throw new Error('unavailable');});
  let response=await request('/forms/responses/'+e.id);assert.equal(response.status,200);assert.match(await response.text(),/Name unavailable/);
  response=await request('/forms/responses/'+e.id);assert.equal(response.status,200);assert.equal(calls,1);assert.equal((await getEntry(e.id)).username,null);
});
test('legacy identity enrichment is scoped to the configured guild and only submitted responses',async()=>{
  const e=await submit(),otherGuild='100000000000000009';await query('INSERT INTO guild_settings(guild_id) VALUES ($1)',[otherGuild]);
  await query("INSERT INTO forms(guild_id,id,title,description,questions,enabled,revision,updated_by) VALUES ($1,$2,'Other','',$3::jsonb,TRUE,1,$4)",[otherGuild,id,JSON.stringify([q()]),actor]);
  await query("INSERT INTO form_entries(guild_id,id,form_id,user_id,snapshot,state,submitted_at) VALUES ($1,$2,$3,$4,$5::jsonb,'pending',NOW())",[otherGuild,randomUUID(),id,user,JSON.stringify(config())]);
  await enrichFormIdentities(pool,guild,[e],async()=>({username:'mandy',displayName:'Mandy'}));
  assert.equal((await getEntry(e.id)).username,'mandy');assert.equal((await query('SELECT username FROM form_entries WHERE guild_id=$1',[otherGuild])).rows[0].username,null);
});
test('answers table displays one response per row with identity and question-answer columns',async()=>{
  await namedSubmit();const response=await request('/forms?view=answers&status=all&form='+id),html=await response.text();assert.equal(response.status,200);assert.match(html,/Form answers — scroll horizontally/);assert.match(html,/<th>Why apply\?/);assert.match(html,/My answer/);assert.match(html,/@mandy/);assert.match(html,/Open response/);
});
test('answer columns match labels and types across reordered, renamed and removed questions',()=>{
  const current=[q({label:'B'}),q({label:'Renamed A'})],old=[q({label:'A'}),q({label:'B'})];const columns=answerColumns(current,[old]);
  assert.deepEqual(columns.map(c=>c.label),['B','Renamed A','A']);
  const e={id:randomUUID(),user_id:user,submitted_at:new Date(),state:'pending',dm_status:'none',answers:[answer(old[0]!,'Old A answer'),answer(old[1]!,'B answer')]} as Entry;
  const html=answersTable([e],columns),row=html.slice(html.indexOf('<tbody>'));assert.ok(row.indexOf('B answer')<row.indexOf('Old A answer'));assert.match(row,/>—<\/span>/);
});
test('duplicate question labels get separate numbered columns rather than overwriting answers',()=>{
  const columns=answerColumns([q({label:'Same'}),q({label:'Same'})],[]);assert.equal(columns.length,2);assert.notEqual(columns[0]!.key,columns[1]!.key);
  const e={id:randomUUID(),user_id:user,submitted_at:new Date(),state:'pending',dm_status:'none',answers:[answer(q({label:'Same'}),'First'),answer(q({label:'Same'}),'Second')]} as Entry;
  const html=answersTable([e],columns);assert.match(html,/Same \(2\)/);assert.match(html,/First/);assert.match(html,/Second/);
});
test('answer tables include file downloads, checkbox values and expandable full paragraphs',()=>{
  const questions=[q({type:'file',label:'File'}),q({type:'checkboxes',label:'Tools',options:['Blender','Houdini']}),q({label:'Paragraph'})],fileId=randomUUID();
  const text='Long paragraph '.repeat(30),e={id:randomUUID(),user_id:user,submitted_at:new Date(),state:'pending',dm_status:'none',answers:[{...answer(questions[0]!,''),fileId,filename:'sample.txt'},answer(questions[1]!,['Blender','Houdini']),answer(questions[2]!,text)]} as Entry;
  const html=answersTable([e],answerColumns(questions,[]));assert.match(html,new RegExp('/forms/files/'+fileId));assert.match(html,/Blender\nHoudini/);assert.match(html,/<details>/);assert.ok(html.includes(text));
});
test('form table headers stay consistent across status filters and include earlier questions',async()=>{
  const e=await submit();await reviewForm(pool,{...context(),id:e.id,revision:1,decision:'approved',message:''});await save({questions:[q({label:'Changed question'})]},1);
  for(const status of ['all','pending','approved']){const html=await (await request('/forms?view=answers&status='+status+'&form='+id)).text();assert.match(html,/<th>Changed question/);assert.match(html,/<th>Why apply\?/);}
});
test('identity and answer table values are HTML escaped',async()=>{
  const e=await namedSubmit('<script>name</script>','<img src=x onerror=alert(1)>');await query('UPDATE form_entries SET answers=$3::jsonb WHERE guild_id=$1 AND id=$2',[guild,e.id,JSON.stringify([answer(q(),'<script>answer</script>')])]);
  const html=await (await request('/forms?view=answers&status=all&form='+id)).text();assert.doesNotMatch(html,/<script>name|<script>answer|<img src=x/);assert.match(html,/&lt;script&gt;answer/);assert.match(html,/@&lt;script&gt;name/);
});
test('name reader uses current member identity and falls back to account lookup for departed users',async()=>{
  const calls:string[]=[];let departed=false;const client={rest:{get:async(route:string)=>{calls.push(route);if(route.includes('/members/')){if(departed)throw {code:10007};return {nick:'Server name',user:{id:user,username:'mandy',global_name:'Global'}};}return {id:user,username:'mandy',global_name:'Global'};}}} as any;
  const read=formIdentityReader(client,guild);assert.deepEqual(await read(user),{username:'mandy',displayName:'Server name'});assert.equal(calls.length,1);departed=true;assert.deepEqual(await read(user),{username:'mandy',displayName:'Global'});assert.equal(calls.length,3);
});
test('name reader rejects mismatched account IDs and handles lookup errors without guessing',async()=>{
  assert.equal(await formIdentityReader({rest:{get:async()=>({user:{id:actor,username:'wrong'}})}} as any,guild)(user),null);
  assert.equal(await formIdentityReader({rest:{get:async()=>{throw new Error('network');}}} as any,guild)(user),null);
});
test('answers table stays staff-only and supports retained responses of deleted forms',async()=>{
  await namedSubmit();await removeForm();let response=await request('/forms?view=answers&status=all&form='+id);assert.equal(response.status,200);assert.match(await response.text(),/My answer/);roles=[];assert.equal((await request('/forms?view=answers&status=all&form='+id)).status,403);
});
test('answers-table pagination retains its form, status and view filters',async()=>{
  await save();const snapshot=JSON.stringify({...config(),id,revision:1});
  for(let n=0;n<51;n++)await query("INSERT INTO form_entries(guild_id,id,form_id,user_id,snapshot,answers,state,submitted_at,username,display_name,identity_source) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'pending',NOW()-($7::integer*INTERVAL '1 second'),'mandy','Mandy','submission')",[guild,randomUUID(),id,user,snapshot,JSON.stringify([answer()]),n]);
  const html=await (await request('/forms?view=answers&status=pending&form='+id)).text();assert.match(html,new RegExp('form='+id+'&amp;view=answers&amp;page=1'));
  const next=await (await request('/forms?view=answers&status=pending&form='+id+'&page=1')).text();assert.match(next,/My answer/);assert.match(next,new RegExp('status=pending&amp;form='+id+'&amp;view=answers'));
});

async function deletionInput(mode:'one'|'all',target:string) {
  const entries=(await query(`SELECT id,revision FROM form_entries WHERE guild_id=$1 AND ${mode==='one'?'id':'form_id'}=$2 AND state<>'draft'`,[guild,target])).rows as Entry[];
  return {...context(),id:target,mode,stamp:responseDeletionStamp(entries),confirmation:'DELETE'};
}
async function deletionPost(path:string) {
  const response=await request(path);assert.equal(response.status,200);const html=await response.text();
  const value=(name:string)=>{const match=[...html.matchAll(new RegExp(`name="${name}" value="([^"]+)"`,'g'))].at(-1);assert.ok(match,name);return match[1]!;};
  return new URLSearchParams({csrf:value('csrf'),stamp:value('stamp'),confirmation:'DELETE'});
}
test('delete one response removes answers, files, steps and queued DM while preserving form and other entries',async()=>{
  const question=q({type:'file'});await save({questions:[question]});
  const draft=await startForm(pool,guild,id,user),fileId=randomUUID();
  const entry=await step(draft,[{...answer(question,''),fileId,filename:'delete.txt'}],[{id:fileId,filename:'delete.txt',data:Buffer.from('private bytes')}]);
  const other=await startForm(pool,guild,id,actor);
  await reviewForm(pool,{...context(),id:entry.id,revision:1,decision:'approved',message:'Private review'});
  const input=await deletionInput('one',entry.id);const result=await deleteFormResponses(pool,input);
  assert.equal(result.count,1);assert.equal(result.formId,id);assert.equal(await getEntry(entry.id),undefined);assert.ok(await getEntry(other.id));
  assert.equal((await query('SELECT * FROM form_files')).rowCount,0);assert.equal((await query('SELECT * FROM form_steps')).rowCount,0);
  assert.equal((await request('/forms/files/'+fileId)).status,404);assert.equal((await request('/forms/responses/'+entry.id)).status,404);
  await deliverForms(pool,guild,deps);assert.deepEqual(deliveries,[]);
  assert.equal((await query('SELECT enabled FROM forms')).rows[0].enabled,true);
  const event=(await query("SELECT details FROM audit_events WHERE event_type='FORM_RESPONSES_DELETED'")).rows[0].details;
  assert.deepEqual(event,{form_id:id,mode:'one',entry_id:entry.id,removed_entries:1});assert.doesNotMatch(JSON.stringify(event),/private|delete.txt|Private review/);
  await assert.rejects(deleteFormResponses(pool,input),/NOT_FOUND/);
});
test('bulk deletion covers every page and status, preserves drafts, other forms and other guilds',async()=>{
  const e=await submit();const draft=await startForm(pool,guild,id,actor);
  await query(`INSERT INTO form_entries(guild_id,id,form_id,user_id,snapshot,state,submitted_at)
    SELECT $1,gen_random_uuid(),$2,$3,$4::jsonb,CASE WHEN n%2=0 THEN 'approved' ELSE 'rejected' END,NOW() FROM generate_series(1,60) n`,[guild,id,user,JSON.stringify(e.snapshot)]);
  const otherForm=randomUUID();await saveForm(pool,{...context(),id:otherForm,revision:0,form:config()});
  const otherDraft=await startForm(pool,guild,otherForm,actor);const otherResponse=await step(otherDraft);
  const otherGuild='100000000000000009';await query('INSERT INTO guild_settings(guild_id) VALUES ($1)',[otherGuild]);
  await query("INSERT INTO forms(guild_id,id,title,description,questions,revision,updated_by) VALUES ($1,$2,'Other','',$3::jsonb,1,$4)",[otherGuild,id,JSON.stringify([q()]),actor]);
  await query("INSERT INTO form_entries(guild_id,id,form_id,user_id,snapshot,state,submitted_at) VALUES ($1,$2,$3,$4,$5::jsonb,'pending',NOW())",[otherGuild,e.id,id,user,JSON.stringify(e.snapshot)]);
  const result=await deleteFormResponses(pool,await deletionInput('all',id));assert.equal(result.count,61);
  assert.ok(await getEntry(draft.id));assert.ok(await getEntry(otherResponse.id));assert.equal((await query('SELECT * FROM form_entries WHERE guild_id=$1',[otherGuild])).rowCount,1);
  assert.equal((await query('SELECT enabled FROM forms WHERE guild_id=$1 AND id=$2',[guild,id])).rows[0].enabled,true);
});
test('retained responses can be deleted after their form is deleted',async()=>{
  const e=await submit();await removeForm();
  const html=await (await request('/forms?form='+id+'&status=all')).text();assert.match(html,new RegExp('/forms/delete-responses/'+id));
  const path='/forms/delete-responses/'+id;assert.equal((await post(path,await deletionPost(path))).status,303);
  assert.equal(await getEntry(e.id),undefined);assert.equal((await query('SELECT deleted FROM forms')).rows[0].deleted,true);
});
test('bulk confirmation rejects new submissions and review changes without removing any response',async()=>{
  const e=await submit();let input=await deletionInput('all',id);
  const another=await step(await startForm(pool,guild,id,actor));
  await assert.rejects(deleteFormResponses(pool,input),/RESPONSES_CHANGED/);assert.ok(await getEntry(e.id));assert.ok(await getEntry(another.id));
  input=await deletionInput('all',id);await reviewForm(pool,{...context(),id:e.id,revision:1,decision:'approved',message:''});
  await assert.rejects(deleteFormResponses(pool,input),/RESPONSES_CHANGED/);assert.ok(await getEntry(e.id));
});
test('individual deletion rejects stale review revisions, drafts and cross-guild targets',async()=>{
  const e=await submit(),input=await deletionInput('one',e.id);await reviewForm(pool,{...context(),id:e.id,revision:1,decision:'rejected',message:''});
  await assert.rejects(deleteFormResponses(pool,input),/RESPONSES_CHANGED/);
  const draft=await startForm(pool,guild,id,actor);await assert.rejects(deleteFormResponses(pool,await deletionInput('one',draft.id)),/NOT_FOUND/);
  const otherGuild='100000000000000009';await query('INSERT INTO guild_settings(guild_id) VALUES ($1)',[otherGuild]);
  await query("INSERT INTO dashboard_sessions(token_hash,guild_id,user_id,display_name,expires_at) VALUES ($1,$2,$3,'Other',NOW()+INTERVAL '1 hour')",[digest('other-token'),otherGuild,actor]);
  await query("INSERT INTO staff_roles(guild_id,role_id,access_level) VALUES ($1,$2,'admin')",[otherGuild,admin]);
  await assert.rejects(deleteFormResponses(pool,{...await deletionInput('one',e.id),guildId:otherGuild,token:'other-token'}),/NOT_FOUND/);
});
test('response deletion requires full access, a live session and explicit confirmation',async()=>{
  const e=await submit(),input=await deletionInput('one',e.id);
  for(const r of [null,[],[mod]]){roles=r;await assert.rejects(deleteFormResponses(pool,input),/STAFF_REQUIRED/);}
  roles=[admin];for(const patch of [{confirmation:''},{confirmation:'delete'},{mode:'wrong'},{stamp:'bad'}])await assert.rejects(deleteFormResponses(pool,{...input,...patch} as typeof input),/RESPONSE_DELETE_CONFIRMATION/);
  await query('DELETE FROM dashboard_sessions');await assert.rejects(deleteFormResponses(pool,input),/SESSION_EXPIRED/);assert.ok(await getEntry(e.id));
});
test('full-access Mods can delete responses',async()=>{
  const e=await submit();roles=[mod];await query('INSERT INTO staff_access_grants(guild_id,user_id,granted_by) VALUES ($1,$2,$2)',[guild,actor]);
  const path='/forms/delete-response/'+e.id;assert.equal((await post(path,await deletionPost(path))).status,303);assert.equal(await getEntry(e.id),undefined);
});
test('response deletion waits for sending DMs and audit failures roll back files and entries',async()=>{
  const question=q({type:'file'});await save({questions:[question]});const draft=await startForm(pool,guild,id,user),fileId=randomUUID();
  const e=await step(draft,[{...answer(question,''),fileId,filename:'keep.txt'}],[{id:fileId,filename:'keep.txt',data:Buffer.from('retain on rollback')}]);
  await reviewForm(pool,{...context(),id:e.id,revision:1,decision:'approved',message:''});await query("UPDATE form_entries SET dm_status='sending'");
  for(const mode of ['one','all'] as const)await assert.rejects(deleteFormResponses(pool,await deletionInput(mode,mode==='one'?e.id:id)),/RESPONSE_DELETE_BUSY/);
  await query("UPDATE form_entries SET dm_status='pending'");const input=await deletionInput('all',id);failAudit=true;await assert.rejects(deleteFormResponses(pool,input),/audit failed/);failAudit=false;
  assert.ok(await getEntry(e.id));assert.equal((await query('SELECT * FROM form_files')).rowCount,1);assert.equal((await query('SELECT * FROM form_steps')).rowCount,1);
});
test('HTTP deletion uses separate escaped confirmation pages and scope-specific CSRF proofs',async()=>{
  const e=await submit();const path='/forms/delete-response/'+e.id,p=await deletionPost(path);
  assert.ok(await getEntry(e.id));assert.match(await (await request('/forms/responses/'+e.id)).text(),new RegExp(path));
  assert.equal((await post(path,p,'https://example.com')).status,403);
  const wrong=new URLSearchParams(p);wrong.set('csrf',formProof(token,`review:${e.id}:1`));assert.equal((await post(path,wrong)).status,403);
  wrong.set('csrf',p.get('csrf')!);wrong.set('confirmation','');assert.equal((await post(path,wrong)).status,409);
  const extra=new URLSearchParams(p);extra.set('mode','all');assert.equal((await post(path,extra)).status,409);
  const duplicate=new URLSearchParams(p);duplicate.append('confirmation','DELETE');assert.equal((await post(path,duplicate)).status,409);
  assert.equal((await post('/forms/delete-responses/'+id,p)).status,403);
  roles=[mod];assert.equal((await request(path)).status,403);assert.equal((await post(path,p)).status,403);
  assert.doesNotMatch(await (await request('/forms/responses/'+e.id)).text(),/Delete response…/);
  roles=[admin];assert.equal((await post(path,p)).status,303);assert.equal((await request(path)).status,404);
});
test('HTTP stale bulk confirmation shows new count and requires a new proof',async()=>{
  const e=await submit();const path='/forms/delete-responses/'+id,old=await deletionPost(path);
  await step(await startForm(pool,guild,id,actor));const response=await post(path,old),html=await response.text();
  assert.equal(response.status,409);assert.match(html,/Responses changed/);assert.match(html,/Submitted responses to delete: 2/);assert.ok(await getEntry(e.id));
  const p=await deletionPost(path);assert.equal((await post(path,p)).status,303);assert.equal((await query("SELECT * FROM form_entries WHERE state<>'draft'")).rowCount,0);
  assert.equal((await post(path,old)).status,409);assert.doesNotMatch(await (await request(path)).text(),/Permanently delete all responses<\/button>/);
});
test('delete confirmation escapes titles and identities, missing bulk form returns 404',async()=>{
  const e=await submit();await query("UPDATE forms SET title='<img src=x>' WHERE guild_id=$1 AND id=$2",[guild,id]);
  await query("UPDATE form_entries SET username='<script>name',display_name='<img src=x>' WHERE guild_id=$1 AND id=$2",[guild,e.id]);
  const html=await (await request('/forms/delete-response/'+e.id)).text();assert.doesNotMatch(html,/<img src=x>|<script>name/);assert.match(html,/&lt;img src=x&gt;/);
  assert.equal((await request('/forms/delete-responses/'+randomUUID())).status,404);
});
