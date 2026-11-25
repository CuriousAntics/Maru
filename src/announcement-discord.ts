import {ChannelType,PermissionFlagsBits,REST,Routes} from 'discord.js';
import type {APIEmbed,APIMessage,Client,RESTGetAPIGuildMemberResult} from 'discord.js';
import {AnnouncementError,postContent} from './announcements.js';
import type {AnnouncementRun,AnnouncementFile,PostDependencies} from './announcements.js';
import {digest} from './web-security.js';
export function editableEmbeds(embeds:APIEmbed[]):APIEmbed[]{return embeds.filter(e=>!e.type||e.type==='rich').map(e=>({...(e.title?{title:e.title}:{}),...(e.description?{description:e.description}:{}),...(e.url?{url:e.url}:{}),...(e.color!==undefined?{color:e.color}:{}),...(e.timestamp?{timestamp:e.timestamp}:{}),...(e.fields?{fields:e.fields}:{}),...(e.author?{author:{name:e.author.name,...(e.author.url?{url:e.author.url}:{}),...(e.author.icon_url?{icon_url:e.author.icon_url}:{})}}:{}),...(e.footer?{footer:{text:e.footer.text,...(e.footer.icon_url?{icon_url:e.footer.icon_url}:{})}}:{}),...(e.image?{image:{url:e.image.url}}:{}),...(e.thumbnail?{thumbnail:{url:e.thumbnail.url}}:{})}));}
export function announcementDependencies(client:Client,guildId:string,token:string,override?:Pick<REST,'get'|'post'|'patch'>):PostDependencies{
  const rest=override??new REST({version:'10',retries:0,timeout:20000}).setToken(token);
  const read=async(channel:string,message:string)=>{
    const guild=await client.guilds.fetch(guildId),c=await guild.channels.fetch(channel,{force:true}),me=await guild.members.fetchMe({force:true});
    if(!c||c.guildId!==guildId||!c.isTextBased()||!c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]))throw new AnnouncementError('CHANNEL');
    const m=await rest.get(Routes.channelMessage(channel,message),{signal:AbortSignal.timeout(15000)}) as APIMessage;
    if(m.id!==message||m.channel_id!==channel||m.author?.id!==client.user?.id||m.webhook_id&&m.webhook_id!==client.user?.id)throw new AnnouncementError('NOT_OWN_MESSAGE');
    if((m.flags??0)&32768)throw new AnnouncementError('COMPONENT_MESSAGE');
    return {id:m.id,channelId:m.channel_id,content:m.content,embeds:editableEmbeds(m.embeds),attachments:m.attachments.map(a=>({id:a.id,filename:a.filename})),hash:digest(JSON.stringify([m.content,m.embeds,m.attachments.map(a=>[a.id,a.filename]),m.components,m.edited_timestamp]))};
  };
  const write=async(run:AnnouncementRun,files:AnnouncementFile[],edit:boolean)=>{
    if(edit&&(await read(run.channel_id,run.target_id!)).hash!==run.expected_hash)throw new AnnouncementError('MESSAGE_CHANGED'); // Reconfirm authorship at dispatch, including imported message links.
    const attachments=[...(edit?run.payload.retained:[]),...files.map((f,n)=>({id:n,filename:f.filename}))];
    const body={content:postContent(run.payload),embeds:run.payload.embeds,attachments,allowed_mentions:edit?{parse:[],roles:[],users:[],replied_user:false}:{parse:run.payload.everyone||run.payload.here?['everyone']:[],roles:run.payload.roles,users:[],replied_user:false},...(!edit?{nonce:digest('announcement:'+run.id).slice(0,25),enforce_nonce:true}:{})};
    const options={body,files:files.map((f,n)=>({data:Buffer.from(f.data),name:f.filename,key:`files[${n}]`})),signal:AbortSignal.timeout(20000)};
    const m=await(edit?rest.patch(Routes.channelMessage(run.channel_id,run.target_id!),options):rest.post(Routes.channelMessages(run.channel_id),options)) as APIMessage;
    if(!/^\d{17,20}$/.test(m.id)||m.channel_id!==run.channel_id||m.author?.id!==client.user?.id)throw new Error('INVALID_MESSAGE');return m.id;
  };
  return {read,send:(r,f)=>write(r,f,false),edit:(r,f)=>write(r,f,true),readRoles:async user=>{try{const m=await rest.get(Routes.guildMember(guildId,user),{signal:AbortSignal.timeout(15000)}) as RESTGetAPIGuildMemberResult;return m.roles;}catch(e){if(e&&typeof e==='object'&&'code'in e&&Number(e.code)===10007)return null;throw e;}},
    resources:async extra=>{const guild=await client.guilds.fetch(guildId);await guild.roles.fetch();const me=await guild.members.fetchMe({force:true}),channels=new Map<string,import('discord.js').GuildBasedChannel|null>(await guild.channels.fetch());if(extra&&!channels.has(extra)){const additional=await guild.channels.fetch(extra,{force:true});if(additional)channels.set(extra,additional);}return {roles:[...guild.roles.cache.values()].filter(r=>r.id!==guildId).map(r=>({id:r.id,name:r.name,mentionable:r.mentionable})),channels:[...channels.values()].flatMap(c=>{if(!c||!c.isTextBased())return [];const p=c.permissionsFor(me);return [{id:c.id,name:c.name,usable:!!p?.has([PermissionFlagsBits.ViewChannel,c.isThread()?PermissionFlagsBits.SendMessagesInThreads:PermissionFlagsBits.SendMessages]),canMention:!!p?.has(PermissionFlagsBits.MentionEveryone),canUpload:!!p?.has(PermissionFlagsBits.AttachFiles),canEmbed:!!p?.has(PermissionFlagsBits.EmbedLinks)}];})};}};
}
