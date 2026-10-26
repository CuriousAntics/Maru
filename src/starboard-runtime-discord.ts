import { ChannelType, PermissionFlagsBits, REST, Routes } from 'discord.js';
import type { APIMessage, APIUser, Client } from 'discord.js';
import type { StarboardDependencies, StarboardPost, StarboardSource } from './starboard-engine.js';
import { isDiscordMissing, StarboardRuntimeError } from './starboard-engine.js';

export function reactionKey(emoji: { id?: string | null; name?: string | null }): string {
  return emoji.id ? `c:${emoji.id}` : `u:${(emoji.name ?? '').normalize('NFC').replace(/\uFE0F/g,'')}`;
}
export async function countReactionVotes(source: StarboardSource,key: string,
  fetchPage: (emoji: string,type: number,after?: string) => Promise<APIUser[]>): Promise<number> {
  const users = new Set<string>();
  for (const reaction of source.reactions.filter((entry) => entry.key === key)) {
    for (const type of [0,1]) {
      if ((type === 0 ? reaction.normal : reaction.burst) === 0) continue;
      let after: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= 500) throw new StarboardRuntimeError('REACTION_LIMIT');
        const batch = await fetchPage(reaction.apiEmoji,type,after);
        if (!Array.isArray(batch) || batch.length > 100 || batch.some((user) => !/^\d{17,20}$/.test(user.id) || (user.bot !== undefined && typeof user.bot !== 'boolean'))) {
          throw new StarboardRuntimeError('INVALID_REACTION_RESPONSE');
        }
        for (const user of batch) if (user.id !== source.authorId && !user.bot) users.add(user.id);
        if (batch.length < 100) break;
        const next = batch.reduce((max,user) => BigInt(user.id) > BigInt(max) ? user.id : max,batch[0]!.id);
        if (after && BigInt(next) <= BigInt(after)) throw new StarboardRuntimeError('INVALID_REACTION_CURSOR');
        after = next;
      }
    }
  }
  return users.size;
}
export function starboardRuntimeDependencies(client: Client,guildId: string,token: string,writerOverride?: Pick<REST,'post'|'patch'|'delete'|'get'>): StarboardDependencies {
  const writer = writerOverride ?? new REST({ version: '10',retries: 0,timeout: 15000 }).setToken(token);
  const botId = () => { if (!client.user) throw new StarboardRuntimeError('BOT_NOT_READY'); return client.user.id; };
  const get = (route: Parameters<REST['get']>[0],query?: URLSearchParams,signal = AbortSignal.timeout(15000)) => writer.get(route,{ query,signal });
  const owned = (message: APIMessage,entry: StarboardPost) => message.author?.id === botId() && !message.webhook_id &&
    message.channel_id === entry.destination_channel_id && message.embeds?.some((embed) => embed.footer?.text === entry.marker);
  async function channels() {
    const guild = await client.guilds.fetch({ guild: guildId,force: true });
    await guild.roles.fetch(); const me = await guild.members.fetchMe({ force: true });
    return { guild,me };
  }
  return { botId,
    readSource: async (channelId,messageId) => {
      try {
        const { guild,me } = await channels(); const channel = await guild.channels.fetch(channelId,{ force: true });
        if (!channel) return null;
        if (![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type) ||
            !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory])) throw new StarboardRuntimeError('SOURCE_UNAVAILABLE');
        const message = await get(Routes.channelMessage(channelId,messageId)) as APIMessage;
        if (message.id !== messageId || message.channel_id !== channelId ||
            !message.author?.id || !Number.isFinite(Date.parse(message.timestamp))) throw new StarboardRuntimeError('INVALID_SOURCE_RESPONSE');
        return { id: message.id,channelId,authorId: message.author.id,authorName: message.author.global_name ?? message.author.username,
          content: message.content,timestamp: message.timestamp,
          attachments: message.attachments.map((file) => ({ name: file.filename,url: file.url,image: file.content_type?.startsWith('image/') ?? false,spoiler: file.filename.startsWith('SPOILER_') })),
          reactions: (message.reactions ?? []).map((reaction) => ({ key: reactionKey(reaction.emoji),
            apiEmoji: reaction.emoji.id ? `${reaction.emoji.name}:${reaction.emoji.id}` : reaction.emoji.name!,
            normal: reaction.count_details?.normal ?? reaction.count,burst: reaction.count_details?.burst ?? 0 })),
        };
      } catch (error) { if (isDiscordMissing(error)) return null; throw error; }
    },
    countVotes: (source,key) => {
      const signal = AbortSignal.timeout(45000);
      return countReactionVotes(source,key,async (emoji,type,after) => await get(Routes.channelMessageReaction(source.channelId,source.id,encodeURIComponent(emoji)),
        new URLSearchParams({ limit: '100',type: String(type),...(after ? { after } : {}) }),signal) as APIUser[]);
    },
    validateDestination: async (sourceId,destinationId) => {
      const { guild,me } = await channels();
      const source = await guild.channels.fetch(sourceId,{ force: true }); const destination = await guild.channels.fetch(destinationId,{ force: true });
      if (!source || !destination || ![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(destination.type) ||
          !source.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]) ||
          !destination.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks])) throw new StarboardRuntimeError('DESTINATION_UNAVAILABLE');
      if ('nsfw' in source && source.nsfw && (!('nsfw' in destination) || !destination.nsfw)) throw new StarboardRuntimeError('NSFW_DESTINATION');
    },
    inspectPost: async (entry) => {
      try {
        const message = await get(Routes.channelMessage(entry.destination_channel_id,entry.post_message_id!)) as APIMessage;
        if (!owned(message,entry)) throw new StarboardRuntimeError('POST_OWNERSHIP_MISMATCH'); return true;
      } catch (error) { if (isDiscordMissing(error)) return false; throw error; }
    },
    findCreated: async (entry) => {
      let before: string | undefined;
      const since = new Date(entry.attempted_at).getTime()-5000;
      try {
        for (let page = 0; page < 20; page++) {
          const batch = await get(Routes.channelMessages(entry.destination_channel_id),new URLSearchParams({ limit: '100',...(before ? { before } : {}) })) as APIMessage[];
          if (!Array.isArray(batch)) throw new StarboardRuntimeError('INVALID_HISTORY_RESPONSE');
          const found = batch.filter((message) => owned(message,entry));
          if (found.length > 1) throw new StarboardRuntimeError('DUPLICATE_HIGHLIGHT_REVIEW');
          if (found[0]) return found[0].id;
          if (!batch.length) return null;
          const oldest = batch.reduce((min,message) => BigInt(message.id) < BigInt(min) ? message.id : min,batch[0]!.id);
          if (batch.length < 100 || Number((BigInt(oldest)>>22n)+1420070400000n) < since) return null;
          if (before && BigInt(oldest) >= BigInt(before)) throw new StarboardRuntimeError('INVALID_HISTORY_CURSOR');
          before = oldest;
        }
        throw new StarboardRuntimeError('HISTORY_REVIEW_REQUIRED');
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && Number(error.code) === 10003) throw new StarboardRuntimeError('DESTINATION_DELETED');
        throw error;
      }
    },
    createPost: async (channelId,body) => {
      const message = await writer.post(Routes.channelMessages(channelId),{ body,signal: AbortSignal.timeout(15000) }) as APIMessage;
      if (message.channel_id !== channelId || message.author?.id !== botId() || !/^\d{17,20}$/.test(message.id) ||
          !message.embeds?.some((embed) => embed.footer?.text === body.embeds?.[0]?.footer?.text)) throw new StarboardRuntimeError('INVALID_CREATE_RESPONSE');
      return message.id;
    },
    editPost: async (entry,body) => {
      const { nonce: _nonce,enforce_nonce: _enforce,...editable } = body;
      const message = await writer.patch(Routes.channelMessage(entry.destination_channel_id,entry.post_message_id!),{ body: editable,signal: AbortSignal.timeout(15000) }) as APIMessage;
      if (message.id !== entry.post_message_id || !owned(message,entry)) throw new StarboardRuntimeError('INVALID_EDIT_RESPONSE');
    },
    deletePost: async (entry) => {
      try {
        const result = await writer.delete(Routes.channelMessage(entry.destination_channel_id,entry.post_message_id!),{ signal: AbortSignal.timeout(15000) });
        if (result !== undefined && result !== null && !(result instanceof ArrayBuffer && result.byteLength === 0)) throw new StarboardRuntimeError('INVALID_DELETE_RESPONSE');
      } catch (error) { if (!isDiscordMissing(error)) throw error; }
    },
  };
}
