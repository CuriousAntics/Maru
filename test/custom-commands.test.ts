import assert from 'node:assert/strict';
import { test, before, beforeEach, after } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import type { ChatInputCommandInteraction, Client, REST } from 'discord.js';
import { PGlite } from '@electric-sql/pglite';
import { saveCustomCommand, customName } from '../src/custom-commands.js';
import { syncCustomCommand } from '../src/custom-command-sync.js';
import type { CustomCommandSync, RemoteCommand } from '../src/custom-command-sync.js';
import { customCommandSync } from '../src/custom-command-discord.js';
import { handleCustomCommand } from '../src/handle-custom-command.js';
import { createDashboardHandler } from '../src/dashboard.js';
import { customCommandProof, digest, randomToken } from '../src/web-security.js';
const db = new PGlite(), guild='100000000000000001', actor='200000000000000001',admin='300000000000000001',mod='300000000000000002',bot='400000000000000001',remote='500000000000000001';
let token: string, roles: string[] | null, failAudit: boolean, failOutcome: boolean, calls: string[], commands: RemoteCommand[];
let failCreate: boolean, loseCreate: boolean;
async function query(sql: string,params?: unknown[]) {
  if (failAudit && sql.includes('INSERT INTO audit_events')) throw new Error('audit failed');
  if (failOutcome && sql.includes('SET discord_id=$3')) throw new Error('outcome failed');
  const r = await db.query(sql,params); return {rows:r.rows,rowCount:r.rows.length || r.affectedRows || 0};
}
const pool = {query,connect:async()=>({query,release(){}})} as unknown as Pool;
const deps: CustomCommandSync = {
  list:async()=>commands.map(c=>({...c})),
  create:async(name)=>{calls.push('create');if(failCreate)throw new Error('forbidden');const c={id:remote,name,type:1};commands.push(c);if(loseCreate)throw new Error('lost');return c;},
  edit:async(id,name)=>{calls.push('edit');return{id,name,type:1};},
  remove:async(id)=>{calls.push('remove:'+id);commands=commands.filter(c=>c.id!==id);},
};
const input=(patch={})=>({guildId:guild,actorId:actor,token,name:'magic',revision:0,description:'Show a magic GIF',response:'https://example.com/magic.gif',enabled:false,remove:false,reason:'Configure response',readRoles:async()=>roles,...patch});
async function row(name='magic') {return(await query('SELECT * FROM custom_commands WHERE guild_id=$1 AND name=$2',[guild,name])).rows[0] as any;}
async function enable() {await saveCustomCommand(pool,input({enabled:true}));await syncCustomCommand(pool,guild,deps);}
let handler: ReturnType<typeof createDashboardHandler>,base: string;
const server=createServer((req,res)=>{void handler(req,res);});
async function request(init: RequestInit={},path='/custom-commands') {return fetch(base+path,{...init,redirect:'manual',headers:{cookie:`maru_session=${token}`,connection:'close',...init.headers}});}
const form=()=>new URLSearchParams({csrf:customCommandProof(token,'$new',0),scope:'$new',revision:'0',name:'magic',description:'Magic',response:'https://example.com/magic.gif',enabled:'false',reason:'Add command',action:'save'});
before(async()=>{
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async()=>{
  roles=[admin];token=randomToken();failAudit=false;failOutcome=false;calls=[];commands=[];failCreate=false;loseCreate=false;
  await db.exec('TRUNCATE guild_settings CASCADE');await query('INSERT INTO guild_settings(guild_id) VALUES ($1)',[guild]);
  await query("INSERT INTO staff_roles(guild_id,role_id,access_level) VALUES ($1,$2,'admin'),($1,$3,'moderator')",[guild,admin,mod]);
  await query("INSERT INTO dashboard_sessions(token_hash,guild_id,user_id,display_name,expires_at) VALUES ($1,$2,$3,'Tester',NOW()+INTERVAL '1 hour')",[digest(token),guild,actor]);
  handler=createDashboardHandler({pool,guildId:guild,config:{origin:base,applicationId:bot,clientSecret:'fake',secure:false},isBotReady:()=>true,readMemberRoles:async()=>roles});
});
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();});
test('saved commands default Off and do not register until enabled',async()=>{
  await saveCustomCommand(pool,input());assert.equal((await row()).enabled,false);await syncCustomCommand(pool,guild,deps);assert.deepEqual(calls,[]);assert.equal((await row()).sync_status,'synced');
});
test('current Admin access and live session required; full-access Mod accepted',async()=>{
  for(const rs of [null,[],[mod]]){roles=rs;await assert.rejects(saveCustomCommand(pool,input()),/ADMIN_REQUIRED/);}
  roles=[mod];await query('INSERT INTO staff_access_grants(guild_id,user_id,granted_by) VALUES ($1,$2,$2)',[guild,actor]);await saveCustomCommand(pool,input());
  await query('DELETE FROM dashboard_sessions');await assert.rejects(saveCustomCommand(pool,input({revision:1})),/SESSION_EXPIRED/);
});
test('built-in moderation names and invalid input are rejected',async()=>{
  for(const name of ['ping','ban','unban','warn','case','timeout','untimeout','staff-check','staff-access','Magic','bad name','/magic','x'.repeat(33)]){
    assert.equal(customName(name),false);await assert.rejects(saveCustomCommand(pool,input({name})),/INVALID_INPUT/);
  }
  for(const patch of [{description:''},{description:'x'.repeat(101)},{response:''},{response:'x'.repeat(2001)},{reason:''},{revision:-1}])await assert.rejects(saveCustomCommand(pool,input(patch)),/INVALID_INPUT/);
});
test('audit failure rolls back the save and content is absent from audit details',async()=>{
  failAudit=true;await assert.rejects(saveCustomCommand(pool,input()));assert.equal(await row(),undefined);failAudit=false;
  await saveCustomCommand(pool,input());assert.doesNotMatch(JSON.stringify((await query('SELECT details FROM audit_events')).rows),/magic.gif/);
});
test('stale saves and edits during synchronization rejected',async()=>{
  await saveCustomCommand(pool,input());await assert.rejects(saveCustomCommand(pool,input()),/STALE_SETTINGS/);
  await query("UPDATE custom_commands SET sync_status='running',sync_started_at=NOW()");await assert.rejects(saveCustomCommand(pool,input({revision:1})),/BUSY/);
});
test('up to 80 nonremoved commands; removal frees a slot',async()=>{
  for(let n=0;n<80;n++)await saveCustomCommand(pool,input({name:'c'+n}));
  await assert.rejects(saveCustomCommand(pool,input()),/LIMIT/);
  await saveCustomCommand(pool,input({name:'c0',revision:1,remove:true}));await saveCustomCommand(pool,input());assert.ok(await row());
});
test('registration creates only one custom command and preserves unrelated moderation commands',async()=>{
  commands=[{id:'500000000000000002',name:'ban',type:1},{id:'500000000000000003',name:'something',type:2}];
  await enable();assert.deepEqual(calls,['create']);assert.equal((await row()).discord_id,remote);assert.equal(commands.length,3);
  assert.equal(await syncCustomCommand(pool,guild,deps),false);assert.deepEqual(calls,['create']);
});
test('edits update by the recorded ID and disabling removes only that ID',async()=>{
  await enable();await saveCustomCommand(pool,input({revision:1,enabled:true,response:'New response'}));await syncCustomCommand(pool,guild,deps);
  assert.deepEqual(calls,['create','edit']);await saveCustomCommand(pool,input({revision:2}));await syncCustomCommand(pool,guild,deps);
  assert.deepEqual(calls,['create','edit','remove:'+remote]);assert.equal((await row()).discord_id,null);
});
test('off immediately blocks response while Discord removal is still pending',async()=>{
  await enable();await saveCustomCommand(pool,input({revision:1}));let response:any;
  const interaction={commandName:'magic',commandId:remote,guildId:guild,member:{},user:{bot:false},deferReply:async()=>{},editReply:async(body:any)=>{response=body;}} as unknown as ChatInputCommandInteraction;
  await handleCustomCommand(interaction,pool,guild);assert.match(response.content,/Off/);
});
test('removing the entry is durable and removal failure remains visible and retryable',async()=>{
  await enable();await saveCustomCommand(pool,input({revision:1,remove:true}));await syncCustomCommand(pool,guild,{...deps,remove:async()=>{throw new Error('lost');}});
  assert.equal((await row()).sync_status,'error');assert.equal((await row()).deleted,true);
  assert.match(await(await request({},'/custom-commands?edit=magic')).text(),/Remove command/);
  await saveCustomCommand(pool,input({revision:2,remove:true}));await syncCustomCommand(pool,guild,deps);assert.equal((await row()).discord_id,null);
});
test('collision never upserts or deletes an unknown same-name command',async()=>{
  commands=[{id:remote,name:'magic',type:1}];await saveCustomCommand(pool,input({enabled:true}));await syncCustomCommand(pool,guild,deps);
  assert.deepEqual(calls,[]);assert.equal((await row()).sync_status,'error');assert.match((await row()).sync_note,/already exists/);
});
test('changed remote ownership fails closed without modifying the remote command',async()=>{
  await enable();commands[0]!.name='ban';await saveCustomCommand(pool,input({revision:1,remove:true}));await syncCustomCommand(pool,guild,deps);
  assert.deepEqual(calls,['create']);assert.equal((await row()).sync_status,'error');
});
test('unknown create outcome is not automatically repeated, and explicit retry cannot overwrite the collision',async()=>{
  loseCreate=true;await saveCustomCommand(pool,input({enabled:true}));await syncCustomCommand(pool,guild,deps);
  assert.equal((await row()).discord_id,null);assert.equal((await row()).sync_status,'error');loseCreate=false;
  await syncCustomCommand(pool,guild,deps);assert.deepEqual(calls,['create']);
  await saveCustomCommand(pool,input({revision:1,enabled:true}));await syncCustomCommand(pool,guild,deps);assert.deepEqual(calls,['create']);
});
test('interrupted operation after restart becomes visible error, never silently replayed',async()=>{
  await saveCustomCommand(pool,input({enabled:true}));await query("UPDATE custom_commands SET sync_status='running',sync_started_at=NOW()-INTERVAL '2 minutes'");
  await syncCustomCommand(pool,guild,deps);assert.deepEqual(calls,[]);assert.equal((await row()).sync_status,'error');
});
test('lost outcome save leaves durable claim and does not duplicate registration',async()=>{
  failOutcome=true;await saveCustomCommand(pool,input({enabled:true}));await assert.rejects(syncCustomCommand(pool,guild,deps));
  assert.equal((await row()).sync_status,'running');failOutcome=false;await syncCustomCommand(pool,guild,deps);assert.deepEqual(calls,['create']);
});
test('missing previously owned command can be recreated, but malformed Discord responses are rejected',async()=>{
  await enable();commands=[];await saveCustomCommand(pool,input({revision:1,enabled:true}));await syncCustomCommand(pool,guild,deps);assert.deepEqual(calls,['create','create']);
  await saveCustomCommand(pool,input({revision:2,enabled:true}));await syncCustomCommand(pool,guild,{...deps,list:async()=>[{} as RemoteCommand]});assert.equal((await row()).sync_status,'error');
});
test('public saved response works without staff roles and does not ping or delete anything',async()=>{
  await enable();await saveCustomCommand(pool,input({revision:1,enabled:true,response:'<:magic:123456789012345678> @everyone https://example.com/gif'}));
  roles=[];const outputs:any[]=[];let deferred:any='not called';
  const interaction={commandName:'magic',commandId:remote,guildId:guild,member:{},user:{bot:false},deferReply:async(options:any)=>{deferred=options;},editReply:async(body:any)=>{outputs.push(body);}} as unknown as ChatInputCommandInteraction;
  await handleCustomCommand(interaction,pool,guild);assert.equal(deferred,undefined);assert.equal(outputs.length,1);assert.match(outputs[0].content,/<:magic:/);assert.deepEqual(outputs[0].allowedMentions,{parse:[]});
});
test('foreign guild, DM, bot, stale ID and reserved names cannot run saved responses',async()=>{
  await enable();for(const patch of [{guildId:'100000000000000002'},{member:null},{user:{bot:true}},{commandId:'500000000000000099'},{commandName:'ban'}]){
    let content='';const interaction={commandName:'magic',commandId:remote,guildId:guild,member:{},user:{bot:false},...patch,deferReply:async()=>{},editReply:async(body:any)=>{content=body.content;}} as unknown as ChatInputCommandInteraction;
    await handleCustomCommand(interaction,pool,guild);assert.doesNotMatch(content,/magic.gif/);
  }
});
test('lost response is neither overwritten by an error nor duplicated as a followup',async()=>{
  await enable();let edits=0;const interaction={commandName:'magic',commandId:remote,guildId:guild,member:{},user:{bot:false},deferReply:async()=>{},editReply:async()=>{edits++;throw new Error('lost');}} as unknown as ChatInputCommandInteraction;
  await handleCustomCommand(interaction,pool,guild);assert.equal(edits,1);
});
test('HTTP form authenticates and rejects cross-origin, duplicate or forged fields',async()=>{
  let p=form();p.set('csrf','bad');assert.equal((await request({method:'POST',body:p,headers:{origin:base}})).status,403);
  assert.equal((await request({method:'POST',body:form(),headers:{origin:'https://elsewhere.invalid'}})).status,403);
  p=form();p.append('enabled','true');assert.equal((await request({method:'POST',body:p,headers:{origin:base}})).status,409);
  roles=[mod];assert.equal((await request({method:'POST',body:form(),headers:{origin:base}})).status,403);
  roles=[admin];assert.equal((await request({method:'POST',body:form(),headers:{origin:base}})).status,303);
});
test('dashboard escapes response HTML and supports a literal /new command name',async()=>{
  await saveCustomCommand(pool,input({name:'new',description:'<script>',response:'</textarea><script>bad</script>'}));
  const html=await(await request({},'/custom-commands?edit=new')).text();assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>bad/);
  const p=form();p.set('scope','new');p.set('name','new');p.set('revision','1');p.set('csrf',customCommandProof(token,'new',1));
  assert.equal((await request({method:'POST',body:p,headers:{origin:base}})).status,303);
});
test('Discord adapter uses per-command routes and does not bulk-overwrite registrations',async()=>{
  const routes:any[]=[];const rest={get:async(route:string)=>{routes.push(route);return[];},post:async(route:string,o:any)=>{routes.push([route,o.body]);return{id:remote,name:'magic',type:1};},patch:async(route:string,o:any)=>{routes.push([route,o.body]);return{id:remote,name:'magic',type:1};},delete:async(route:string)=>{routes.push(route);}} as unknown as REST;
  const d=customCommandSync({user:{id:bot}} as unknown as Client,guild,'fake',rest);await d.list();await d.create('magic','Magic');await d.edit(remote,'magic','Changed');await d.remove(remote);
  assert.equal(routes[0],`/applications/${bot}/guilds/${guild}/commands`);assert.equal(routes[2][0],`/applications/${bot}/guilds/${guild}/commands/${remote}`);assert.equal(routes[1][1].default_member_permissions,null);assert.deepEqual(routes[2][1].options,[]);
});
