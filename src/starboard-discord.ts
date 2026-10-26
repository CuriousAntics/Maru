import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Client } from 'discord.js';
import type { StarboardResources } from './starboard-settings.js';

export function starboardResources(client: Client, guildId: string): () => Promise<StarboardResources> {
  return async () => {
    const guild = await client.guilds.fetch({ guild: guildId,force: true });
    await guild.roles.fetch();
    const me = await guild.members.fetchMe({ force: true });
    const channels = await guild.channels.fetch();
    const emojis = await guild.emojis.fetch();
    return {
      channels: [...channels.values()].flatMap((channel) => {
        if (!channel || ![ChannelType.GuildText,ChannelType.GuildAnnouncement].includes(channel.type)) return [];
        const permissions = channel.permissionsFor(me);
        return [{ id: channel.id,name: channel.name,
          sourceUsable: permissions.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]),
          destinationUsable: permissions.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ReadMessageHistory]),
        }];
      }).sort((a,b) => a.name.localeCompare(b.name)),
      emojis: [...emojis.values()].map((emoji) => ({ id: emoji.id,name: emoji.name ?? 'emoji',animated: emoji.animated,
        usable: emoji.available !== false && (!emoji.roles.cache.size || emoji.roles.cache.some((role) => me.roles.cache.has(role.id))),
      })),
    };
  };
}
