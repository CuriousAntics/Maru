import { ChannelType, PermissionFlagsBits, REST, Routes } from 'discord.js';
import type { APIAttachment, APIInvite, APIMessage, Client, RESTPatchAPIGuildMemberResult } from 'discord.js';
import { createImageFingerprinter } from './image-fingerprints.js';
import { AutoModError } from './automod-settings.js';
import type { AutoModResources } from './automod-settings.js';
import type { AutoModDependencies } from './automod-engine.js';
export function imageUploads(attachments: APIAttachment[]) {
  return attachments.filter((a) => a.content_type?.startsWith('image/') || !a.content_type && /\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|apng|svg)$/i.test(a.filename)).map((a) => ({ id: a.id,url: a.url,size: a.size }));
}
const missing=(error: unknown) => error && typeof error==='object' && 'code' in error && [10003,10008].includes(Number(error.code));
export function autoModResources(client: Client,guildId: string): () => Promise<AutoModResources> {
  return async () => {
    const guild=await client.guilds.fetch({ guild: guildId,force: true }); const roles=await guild.roles.fetch(); const me=await guild.members.fetchMe({ force: true }); const channels=await guild.channels.fetch();
    return { roles: [...roles.values()].filter((role) => role.id!==guildId).map((role) => ({ id: role.id,name: role.name })),
      channels: [...channels.values()].flatMap((channel) => channel && (channel.isTextBased() || [ChannelType.GuildForum,ChannelType.GuildMedia].includes(channel.type))?[{ id: channel.id,name: channel.name }]:[]),
      canDelete: me.permissions.has(PermissionFlagsBits.ManageMessages),canTimeout: me.permissions.has(PermissionFlagsBits.ModerateMembers) };
  };
}
export function autoModDependencies(client: Client,guildId: string,token: string,writerOverride?: Pick<REST,'get'|'delete'|'patch'|'post'>): AutoModDependencies {
  const writer=writerOverride ?? new REST({ version: '10',retries: 0,timeout: 15000 }).setToken(token);
  const botId=() => { if(!client.user) throw new AutoModError('BOT_NOT_READY'); return client.user.id; };
  return { botId,resolveInvite: async (code) => {
    try {
      const invite=await writer.get(Routes.invite(code),{ signal: AbortSignal.timeout(3000) }) as APIInvite;
      return invite.code===code && /^\d{17,20}$/.test(invite.guild?.id ?? '')?invite.guild!.id:null;
    } catch { return null; }
  },imageFingerprints: createImageFingerprinter(),
    readMessage: async (channel,id) => {
      try { const source=await writer.get(Routes.channelMessage(channel,id),{ signal: AbortSignal.timeout(15000) }) as APIMessage;
        if(source.id!==id || source.channel_id!==channel || !source.author?.id || typeof source.content!=='string') throw new AutoModError('INVALID_MESSAGE');
        return { ...(imageUploads(source.attachments ?? []).length?{ images: imageUploads(source.attachments ?? []) }:{}),id: source.id,channelId: channel,userId: source.author.id,content: source.content,bot: !!source.author.bot,webhook: !!source.webhook_id };
      } catch(error) { if(missing(error)) return null; throw error; }
    },
    readContext: async (channelId,userId) => {
      const guild=await client.guilds.fetch({ guild: guildId,force: true }); await guild.roles.fetch(); const me=await guild.members.fetchMe({ force: true });
      const target=await guild.members.fetch({ user: userId,force: true }).catch((error: unknown) => { if(error && typeof error==='object' && 'code' in error && Number(error.code)===10007) return null; throw error; });
      const channel=await guild.channels.fetch(channelId,{ force: true }).catch((error: unknown) => { if(missing(error)) return null; throw error; });
      const supported=channel?.isTextBased();
      return { guildName: guild.name,roleIds: target?[...target.roles.cache.keys()]:[],parentId: channel?.isThread()?channel.parentId:null,
        owner: userId===guild.ownerId,canDelete: !!supported && !!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages]),
        canTimeout: !!target && !target.user.bot && userId!==guild.ownerId && !target.permissions.has(PermissionFlagsBits.Administrator) &&
          me.permissions.has(PermissionFlagsBits.ModerateMembers) && me.roles.highest.comparePositionTo(target.roles.highest)>0,
        timeoutUntil: target?.communicationDisabledUntil?.toISOString() ?? null };
    },
    deleteMessage: async (channel,id) => {
      try { const result=await writer.delete(Routes.channelMessage(channel,id),{ signal: AbortSignal.timeout(15000),reason: 'Maru automatic moderation rule' });
        if(result!==null && result!==undefined && !(result instanceof ArrayBuffer && result.byteLength===0)) throw new AutoModError('DELETE_UNCONFIRMED');
      } catch(error) { if(!missing(error)) throw error; }
    },
    applyTimeout: async (userId,until,number) => {
      const result=await writer.patch(Routes.guildMember(guildId,userId),{ body: { communication_disabled_until: until },reason: `Maru automatic timeout case #${number}`,signal: AbortSignal.timeout(15000) }) as RESTPatchAPIGuildMemberResult;
      return { targetId: result.user?.id ?? '',until: result.communication_disabled_until ?? null };
    },
    sendLog: async (channel,body) => {
      const result=await writer.post(Routes.channelMessages(channel),{ body,signal: AbortSignal.timeout(15000) }) as APIMessage;
      if(result.channel_id!==channel || result.author?.id!==botId()) throw new AutoModError('LOG_UNCONFIRMED'); return result.id;
    },
  };
}
