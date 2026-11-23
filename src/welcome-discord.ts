import { ChannelType, PermissionFlagsBits, REST, Routes } from 'discord.js';
import type { APIMessage, Client, RESTGetAPIGuildMemberResult } from 'discord.js';
import { digest } from './web-security.js';
import type { WelcomeDependencies } from './welcome.js';
export function welcomeDependencies(client:Client,guildId:string,token:string,eventsReady:boolean,override?:Pick<REST,'get'|'post'>):WelcomeDependencies {
  const rest=override??new REST({version:'10',retries:0,timeout:15000}).setToken(token);
  return {
    resources:async()=>{
      const guild=await client.guilds.fetch(guildId),me=await guild.members.fetchMe({force:true}),channels=await guild.channels.fetch();
      return {eventsReady,serverName:guild.name,channels:[...channels.values()].flatMap(c=>{
        if(!c||c.guildId!==guildId||![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(c.type))return [];
        const perms=c.permissionsFor(me);return [{id:c.id,name:c.name,postable:!!perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]),linkable:!!perms?.has(PermissionFlagsBits.ViewChannel)}];
      })};
    },
    member:async userId=>{
      try{const m=await rest.get(Routes.guildMember(guildId,userId),{signal:AbortSignal.timeout(10000)}) as RESTGetAPIGuildMemberResult;
        if(m.user?.id!==userId||!m.joined_at)throw new Error('INVALID_MEMBER');return {joinedAt:m.joined_at,bot:!!m.user.bot};}
      catch(e){if(e&&typeof e==='object'&&'code'in e&&Number(e.code)===10007)return null;throw e;}
    },
    send:async(job,content)=>{
      const m=await rest.post(Routes.channelMessages(job.channel_id),{body:{content,allowed_mentions:{parse:[],users:[job.user_id],roles:[],replied_user:false},
        nonce:digest(`welcome:${guildId}:${job.user_id}:${new Date(job.joined_at).toISOString()}`).slice(0,25),enforce_nonce:true},signal:AbortSignal.timeout(15000)}) as APIMessage;
      if(m.channel_id!==job.channel_id||m.author?.id!==client.user?.id||!/^\d{17,20}$/.test(m.id))throw new Error('INVALID_MESSAGE');return m.id;
    },
  };
}
