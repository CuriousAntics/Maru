import assert from 'node:assert/strict';
import { test, before, beforeEach, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import type { Interaction } from 'discord.js';
import { PGlite } from '@electric-sql/pglite';
import { saveForm, startForm, loadDraft, submitFormStep, reviewForm, queueFormPost, validateForm } from '../src/forms.js';
import type { Form, Question, Answer, Entry } from '../src/forms.js';
import { formModal, handleFormInteraction, downloadFormFile } from '../src/forms-discord.js';
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
  const p=new URLSearchParams({csrf:formProof(token,`publish:${id}:1`),id,revision:'1',action:'publish',request_id:randomUUID(),channel});assert.equal((await post('/forms',p)).status,303);
  const build=builder();build.set('revision','1');build.set('csrf',formProof(token,`build:${id}:1`));build.set('action','add');
  const added=await post('/forms',build);assert.equal(added.status,200);assert.match(await added.text(),/Question 2/);assert.equal((await query('SELECT revision FROM forms')).rows[0].revision,1);
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
  const modal={id:interactionId,customId:`forms:submit:${draft.id}:0`,guildId:guild,member:{},user:{id:user,bot:false},fields,isButton:()=>false,isModalSubmit:()=>true,get deferred(){return deferred;},replied:false,deferReply:async()=>{deferred=true;},editReply:async(v:any)=>replies.push(v),reply:async(v:any)=>replies.push(v)} as unknown as Interaction;
  const fetcher=(async()=>{downloads++;return new Response('Portfolio');}) as typeof fetch;
  await handleFormInteraction(modal,pool,guild,fetcher);
  const e=await getEntry(draft.id);assert.equal(e.state,'pending');assert.deepEqual(e.answers.slice(0,4).map(a=>a.value),['Short answer','Paragraph answer',['B'],['Red','Blue']]);
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
