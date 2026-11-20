import assert from 'node:assert/strict';
import { test, before, beforeEach, after } from 'node:test';
import { readFile,readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import type { Client,REST } from 'discord.js';
import { PGlite } from '@electric-sql/pglite';
import { inlineTriggers,parseInlineEvent,enqueueInlineEvent,processInlineCommand } from '../src/inline-commands.js';
import type { InlineDependencies,InlineSource } from '../src/inline-commands.js';
import { inlineCommandDependencies } from '../src/inline-command-discord.js';
import { saveCustomCommand } from '../src/custom-commands.js';
import { customCommandProof,digest,randomToken } from '../src/web-security.js';
import { createDashboardHandler } from '../src/dashboard.js';
const db=new PGlite(),guild='100000000000000001',actor='200000000000000001',admin='300000000000000001',mod='300000000000000002',channel='400000000000000001',member='500000000000000001',message='600000000000000001',bot='700000000000000001';
let token:string,roles:string[]|null,failClaim:boolean,failOutcome:boolean;
let sources:Map<string,InlineSource>,sent:{channel:string;message:string;content:string}[],readHook:(()=>Promise<void>)|undefined,loseSend:boolean;
async function query(sql:string,values?:unknown[]){
  if(failClaim && sql.includes('SET status=$3,note=$4,claimed_at'))throw new Error('claim failed');
  if(failOutcome && sql.includes('SET status=$3,note=$4,response_id'))throw new Error('outcome failed');
  const r=await db.query(sql,values);return{rows:r.rows,rowCount:r.rows.length||r.affectedRows||0};
}
const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
const deps:InlineDependencies={read:async(_c,id)=>{await readHook?.();return sources.get(id)??null;},send:async(c,m,content)=>{sent.push({channel:c,message:m,content});if(loseSend)throw new Error('lost');return'800000000000000001';}};
const input=(patch={})=>({guildId:guild,actorId:actor,token,name:'magic',revision:0,description:'Magic',response:'Saved response',enabled:true,inlineEnabled:true,remove:false,reason:'Configure inline response',readRoles:async()=>roles,...patch});
function packet(content='That was /magic!',patch:Record<string,unknown>={}){return{t:'MESSAGE_CREATE',d:{guild_id:guild,id:message,channel_id:channel,author:{id:member},type:0,content,timestamp:new Date().toISOString(),...patch}};}
async function configure(patch={}){await saveCustomCommand(pool,input(patch));await query("UPDATE custom_commands SET updated_at=NOW()-INTERVAL '1 second'");}
async function queue(content='That was /magic!',messageId=message,user=member){
  const event=parseInlineEvent(packet(content,{id:messageId,author:{id:user}}),guild);assert.ok(event);
  sources.set(messageId,{id:messageId,channelId:channel,guildId:guild,userId:user,content,bot:false,webhook:false});
  await enqueueInlineEvent(pool,guild,event);return event;
}
async function job(){return(await query('SELECT * FROM inline_command_jobs ORDER BY message_id LIMIT 1')).rows[0] as any;}
let handler:ReturnType<typeof createDashboardHandler>,base:string;
const server=createServer((req,res)=>{void handler(req,res);});
const form=()=>new URLSearchParams({csrf:customCommandProof(token,'$new',0),scope:'$new',revision:'0',name:'magic',description:'Magic',response:'Shared response',enabled:'true',inline:'true',reason:'Configure response',action:'save'});
async function request(init:RequestInit={}){return fetch(base+'/custom-commands',{...init,redirect:'manual',headers:{cookie:`maru_session=${token}`,connection:'close',...init.headers}});}
before(async()=>{
  for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async()=>{
  token=randomToken();roles=[admin];failClaim=false;failOutcome=false;sources=new Map();sent=[];readHook=undefined;loseSend=false;
  await db.exec('TRUNCATE guild_settings CASCADE');await query('INSERT INTO guild_settings(guild_id) VALUES ($1)',[guild]);
  await query("INSERT INTO staff_roles(guild_id,role_id,access_level) VALUES ($1,$2,'admin'),($1,$3,'moderator')",[guild,admin,mod]);
  await query("INSERT INTO dashboard_sessions(token_hash,guild_id,user_id,display_name,expires_at) VALUES ($1,$2,$3,'Tester',NOW()+INTERVAL '1 hour')",[digest(token),guild,actor]);
  handler=createDashboardHandler({pool,guildId:guild,config:{origin:base,applicationId:bot,clientSecret:'fake',secure:false},isBotReady:()=>true,readMemberRoles:async()=>roles});
});
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();});
test('whole slash words match anywhere and ignore capitalization; no bare or partial-word matches',()=>{
  for(const text of ['/magic','That was /magic!','(/MAGIC)','🪄/magic','a\n/magic?'])assert.deepEqual(inlineTriggers(text),['magic']);
  for(const text of ['magic','/magical','/magicé','/magic_thing','/magic-thing','a/magic','//magic','/magic/path','/ban'])assert.ok(!inlineTriggers(text).includes('magic'));
  assert.deepEqual(inlineTriggers('/magic /MAGIC /other /magic'),['magic','other']);
});
test('URLs including path and query triggers are excluded',()=>{
  for(const text of ['https://example.com/magic','https://example.com/?q=/magic','www.example.com/a?/magic'])assert.deepEqual(inlineTriggers(text),[]);
  assert.deepEqual(inlineTriggers('https://example.com/?q=/magic then /other'),['other']);
});
test('trigger extraction is bounded to 20 unique command names',()=>{
  assert.equal(inlineTriggers(Array.from({length:40},(_,i)=>'/c'+i).join(' ')).length,20);
  assert.deepEqual(inlineTriggers('/'+'a'.repeat(40)),[]);
});
test('only fresh human creates in this guild qualify, including replies',()=>{
  assert.ok(parseInlineEvent(packet(),guild));assert.ok(parseInlineEvent(packet('/magic',{type:19}),guild));
  const invalid=[{guild_id:'100000000000000002'},{author:{id:bot,bot:true}},{webhook_id:'800000000000000002'},{content:'magic'},{id:'bad'},{channel_id:null},{timestamp:'bad'},
    {timestamp:new Date(Date.now()-120000).toISOString()},{timestamp:new Date(Date.now()+60000).toISOString()},{type:20},{content:'a'.repeat(8001)}];
  for(const patch of invalid)assert.equal(parseInlineEvent(packet('/magic',patch),guild),null);
  assert.equal(parseInlineEvent({...packet(),t:'MESSAGE_UPDATE'},guild),null);
});
test('migration defaults existing commands to in-message Off and omitted field keeps the current choice',async()=>{
  await configure({inlineEnabled:undefined});assert.equal((await query('SELECT inline_enabled FROM custom_commands')).rows[0]?.inline_enabled,false);
  await queue();assert.equal(await job(),undefined);
  await saveCustomCommand(pool,input({revision:1,inlineEnabled:true}));
  await saveCustomCommand(pool,input({revision:2,inlineEnabled:undefined}));assert.equal((await query('SELECT inline_enabled FROM custom_commands')).rows[0]?.inline_enabled,true);
});
test('matched human message gets the existing response and original stays untouched',async()=>{
  await configure();await queue();await processInlineCommand(pool,guild,deps);
  assert.deepEqual(sent,[{channel,message,content:'Saved response'}]);assert.ok(sources.has(message));assert.equal((await job()).status,'sent');
  assert.doesNotMatch(JSON.stringify(await job()),/That was|Saved response/);
});
test('duplicate events and repeat processing never send twice, even across restart',async()=>{
  await configure();const event=await queue();await enqueueInlineEvent(pool,guild,event);await processInlineCommand(pool,guild,deps);await enqueueInlineEvent(pool,guild,event);
  assert.equal(await processInlineCommand(pool,guild,{...deps}),false);assert.equal(sent.length,1);
});
test('one reply per message: first enabled matching trigger wins, unknown and disabled words ignored',async()=>{
  await configure();await saveCustomCommand(pool,input({name:'other',response:'Other response'}));await query("UPDATE custom_commands SET updated_at=NOW()-INTERVAL '1 second'");
  await queue('/unknown /other /magic /other');await processInlineCommand(pool,guild,deps);assert.equal(sent[0]?.content,'Other response');assert.equal((await query('SELECT * FROM inline_command_jobs')).rowCount,1);
});
test('master Off, inline Off, removed and unconfigured commands do not enqueue',async()=>{
  for(const patch of [{enabled:false},{inlineEnabled:false},{remove:true}]){
    await configure();await saveCustomCommand(pool,input({revision:1,...patch}));await query("UPDATE custom_commands SET updated_at=NOW()-INTERVAL '1 second'");
    await queue();assert.equal(await job(),undefined);await query('DELETE FROM custom_commands');
  }
});
test('settings revision changes cancel queued work; edits reuse new response only for new messages',async()=>{
  await configure();await queue();await saveCustomCommand(pool,input({revision:1,response:'Changed response'}));await processInlineCommand(pool,guild,deps);assert.equal(sent.length,0);
  await query("UPDATE custom_commands SET updated_at=NOW()-INTERVAL '1 second'");await queue('/magic','600000000000000002');await processInlineCommand(pool,guild,deps);assert.equal(sent[0]?.content,'Changed response');
});
test('pre-enable timestamps cannot gain new credit',async()=>{
  await configure();const event=parseInlineEvent(packet(),guild);assert.ok(event);await query("UPDATE custom_commands SET updated_at=NOW()+INTERVAL '1 second'");await enqueueInlineEvent(pool,guild,event);assert.equal(await job(),undefined);
});
test('missing, edited, foreign or replaced source is not answered',async()=>{
  const changes=[()=>sources.delete(message),()=>{sources.get(message)!.content='edited';},()=>{sources.get(message)!.guildId='100000000000000002';},()=>{sources.get(message)!.userId=actor;},()=>{sources.get(message)!.bot=true;},()=>{sources.get(message)!.webhook=true;}];
  for(const change of changes){await configure();await queue();change();await processInlineCommand(pool,guild,deps);assert.equal(sent.length,0);assert.equal((await job()).status,'skipped');await query('DELETE FROM inline_command_jobs');await query('DELETE FROM inline_command_cooldowns');await query('DELETE FROM custom_commands');}
});
test('Off after claim but before send is rechecked',async()=>{
  await configure();await queue();readHook=async()=>{await saveCustomCommand(pool,input({revision:1,inlineEnabled:false}));};await processInlineCommand(pool,guild,deps);assert.equal(sent.length,0);assert.equal((await job()).status,'skipped');
});
test('five-second cooldown applies across commands and channels for one member, not other members',async()=>{
  await configure();await queue();await processInlineCommand(pool,guild,deps);
  await queue('/magic','600000000000000002');await processInlineCommand(pool,guild,deps);assert.equal(sent.length,1);
  await queue('/magic','600000000000000003',actor);await processInlineCommand(pool,guild,deps);assert.equal(sent.length,2);
  await query("UPDATE inline_command_cooldowns SET claimed_at=NOW()-INTERVAL '6 seconds'");await queue('/magic','600000000000000004');await processInlineCommand(pool,guild,deps);assert.equal(sent.length,3);
});
test('stale queued work is skipped',async()=>{
  await configure();await queue();await query("UPDATE inline_command_jobs SET event_at=NOW()-INTERVAL '2 minutes'");await processInlineCommand(pool,guild,deps);assert.equal(sent.length,0);assert.equal((await job()).status,'skipped');
});
test('failed database claim prevents external effects and rolls back cooldown',async()=>{
  await configure();await queue();failClaim=true;await assert.rejects(processInlineCommand(pool,guild,deps));assert.equal(sent.length,0);assert.equal((await job()).status,'pending');assert.equal((await query('SELECT * FROM inline_command_cooldowns')).rowCount,0);
});
test('lost send is unconfirmed with no automatic retry',async()=>{
  await configure();await queue();loseSend=true;await processInlineCommand(pool,guild,deps);assert.equal((await job()).status,'unconfirmed');loseSend=false;
  await processInlineCommand(pool,guild,deps);assert.equal(sent.length,1);
});
test('restart after a lost outcome write never repeats the external send',async()=>{
  await configure();await queue();failOutcome=true;await assert.rejects(processInlineCommand(pool,guild,deps));assert.equal((await job()).status,'sending');failOutcome=false;
  await query("UPDATE inline_command_jobs SET claimed_at=NOW()-INTERVAL '2 minutes'");await processInlineCommand(pool,guild,deps);assert.equal((await job()).status,'unconfirmed');assert.equal(sent.length,1);
});
test('HTTP saves inline choice with existing authorization, strict fields and CSRF',async()=>{
  const p=form();p.set('inline','invalid');assert.equal((await request({method:'POST',body:p,headers:{origin:base}})).status,409);
  roles=[mod];assert.equal((await request({method:'POST',body:form(),headers:{origin:base}})).status,403);
  roles=[admin];assert.equal((await request({method:'POST',body:form(),headers:{origin:base}})).status,303);
  assert.equal((await query('SELECT inline_enabled FROM custom_commands')).rows[0]?.inline_enabled,true);
  assert.match(await(await request()).text(),/In-message trigger/);
});
test('Discord reply uses saved response, stable nonce and no pings, with source-missing fallback disabled',async()=>{
  const posts:any[]=[];const rest={post:async(_route:string,o:any)=>{posts.push(o.body);return{id:'800000000000000001',channel_id:channel,author:{id:bot}};}} as unknown as REST;
  const d=inlineCommandDependencies({user:{id:bot}} as unknown as Client,guild,'fake',rest);
  await d.send(channel,message,'@everyone <:magic:123456789012345678>');await d.send(channel,message,'response');
  assert.deepEqual(posts[0].allowed_mentions,{parse:[],replied_user:false});assert.equal(posts[0].message_reference.message_id,message);assert.equal(posts[0].message_reference.fail_if_not_exists,true);
  assert.equal(posts[0].nonce,posts[1].nonce);assert.equal(posts[0].enforce_nonce,true);
});
test('Discord adapter validates guild and channel permissions, and rejects mismatched source',async()=>{
  let usable=true;const client={guilds:{fetch:async()=>({channels:{fetch:async()=>({guildId:guild,isTextBased:()=>true,isThread:()=>false,permissionsFor:()=>({has:()=>usable})})},members:{fetchMe:async()=>({})}})}} as unknown as Client;
  const rest={get:async()=>({id:message,channel_id:channel,author:{id:member},content:'/magic'})} as unknown as REST;
  const d=inlineCommandDependencies(client,guild,'fake',rest);assert.equal((await d.read(channel,message))?.content,'/magic');usable=false;assert.equal(await d.read(channel,message),null);usable=true;
  const bad={get:async()=>({id:message,channel_id:'400000000000000002',author:{id:member},content:'/magic'})} as unknown as REST;
  await assert.rejects(inlineCommandDependencies(client,guild,'fake',bad).read(channel,message));
});
