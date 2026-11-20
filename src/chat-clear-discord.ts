import { ChannelType, PermissionFlagsBits, REST, Routes } from 'discord.js';
import type { APIMessage, Client } from 'discord.js';
import type { ChatClearDependencies, ClearMessage } from './chat-clear-engine.js';
import type { ChatClearResources } from './chat-clear-settings.js';
const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.SendMessages];
export function chatClearResources(client: Client, guildId: string): () => Promise<ChatClearResources> {
  return async () => {
    const guild = await client.guilds.fetch({ guild: guildId, force: true });
    await guild.roles.fetch();
    const me = await guild.members.fetchMe({ force: true }), channels = await guild.channels.fetch();
    return { channels: [...channels.values()].flatMap(c => c?.type === ChannelType.GuildVoice
      ? [{ id: c.id, name: c.name, usable: c.permissionsFor(me).has(needed) }] : []) };
  };
}
function message(value: unknown, channelId: string): ClearMessage {
  const m = value as APIMessage;
  if (!m || m.channel_id !== channelId || !/^\d{17,20}$/.test(m.id) || typeof m.pinned !== 'boolean' || !Number.isInteger(m.type))
    throw new Error('INVALID_MESSAGE');
  return { id: m.id, pinned: m.pinned, type: m.type };
}
const missing = (e: unknown) => !!e && typeof e === 'object' && 'code' in e && Number(e.code) === 10008;
export function chatClearDependencies(client: Client, guildId: string, token: string, override?: Pick<REST,'get'|'delete'|'post'>): ChatClearDependencies {
  const rest = override ?? new REST({ version: '10', retries: 0, timeout: 15000 }).setToken(token);
  return {
    botId: () => { if (!client.user) throw new Error('BOT_NOT_READY'); return client.user.id; },
    canClear: async id => {
      const guild = await client.guilds.fetch({ guild: guildId, force: true }); await guild.roles.fetch();
      const me = await guild.members.fetchMe({ force: true }), channel = await guild.channels.fetch(id, { force: true });
      return !!channel && channel.guildId === guildId && channel.type === ChannelType.GuildVoice && channel.permissionsFor(me).has(needed);
    },
    list: async (channel, before) => {
      const result = await rest.get(Routes.channelMessages(channel), { query: new URLSearchParams({ before, limit: '100' }), signal: AbortSignal.timeout(15000) });
      if (!Array.isArray(result)) throw new Error('INVALID_MESSAGES');
      return result.map(m => message(m, channel));
    },
    read: async (channel, id) => {
      try { return message(await rest.get(Routes.channelMessage(channel, id), { signal: AbortSignal.timeout(15000) }), channel); }
      catch (e) { if (missing(e)) return null; throw e; }
    },
    remove: async (channel, id) => {
      try {
        const result = await rest.delete(Routes.channelMessage(channel, id), { signal: AbortSignal.timeout(15000) });
        if (result !== undefined && result !== null && !(result instanceof ArrayBuffer && result.byteLength === 0)) throw new Error('INVALID_DELETE_RESPONSE');
      } catch (e) { if (!missing(e)) throw e; }
    },
    notify: async (channel, seconds) => {
      const label = seconds === 300 ? '5 minutes' : seconds === 60 ? '1 minute' : '10 seconds';
      const m = await rest.post(Routes.channelMessages(channel), { body: {
        content: `This voice channel’s text chat will be cleared in about ${label}. Pinned messages will be kept.`,
        allowed_mentions: { parse: [] },
      }, signal: AbortSignal.timeout(15000) }) as APIMessage;
      if (m.channel_id !== channel || !/^\d{17,20}$/.test(m.id)) throw new Error('INVALID_NOTICE_RESPONSE');
      return m.id;
    },
  };
}
