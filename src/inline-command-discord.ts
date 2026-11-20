import { PermissionFlagsBits, REST, Routes } from 'discord.js';
import type { APIMessage, Client } from 'discord.js';
import type { InlineDependencies } from './inline-commands.js';
import { digest } from './web-security.js';
export function inlineCommandDependencies(client: Client,guildId: string,token: string,override?: Pick<REST,'get'|'post'>): InlineDependencies {
  const rest=override ?? new REST({version:'10',retries:0,timeout:15000}).setToken(token);
  return {
    read:async(channelId,messageId)=>{
      const guild=await client.guilds.fetch(guildId),channel=await guild.channels.fetch(channelId,{force:true});
      if(!channel || channel.guildId!==guildId || !channel.isTextBased())return null;
      const me=await guild.members.fetchMe({force:true});
      if(!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,
        channel.isThread()?PermissionFlagsBits.SendMessagesInThreads:PermissionFlagsBits.SendMessages]))return null;
      try {
        const m=await rest.get(Routes.channelMessage(channelId,messageId),{signal:AbortSignal.timeout(15000)}) as APIMessage;
        if(m.id!==messageId || m.channel_id!==channelId || !m.author?.id || typeof m.content!=='string')throw new Error('INVALID_MESSAGE');
        return {id:m.id,channelId,guildId,userId:m.author.id,content:m.content,bot:!!m.author.bot,webhook:!!m.webhook_id};
      } catch(e){if(e && typeof e==='object' && 'code' in e && [10003,10008].includes(Number(e.code)))return null;throw e;}
    },
    send:async(channelId,messageId,response)=>{
      const m=await rest.post(Routes.channelMessages(channelId),{body:{content:response,allowed_mentions:{parse:[],replied_user:false},
        message_reference:{message_id:messageId,channel_id:channelId,guild_id:guildId,fail_if_not_exists:true},
        nonce:digest(`inline:${guildId}:${messageId}`).slice(0,25),enforce_nonce:true},signal:AbortSignal.timeout(15000)}) as APIMessage;
      if(m.channel_id!==channelId || m.author?.id!==client.user?.id || !/^\d{17,20}$/.test(m.id))throw new Error('INVALID_REPLY');return m.id;
    },
  };
}
