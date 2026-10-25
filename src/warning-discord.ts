import { Routes } from 'discord.js';
import type { Client, RESTGetAPIGuildMemberResult, RESTPostAPIChannelMessageJSONBody,
  RESTPostAPIChannelMessageResult } from 'discord.js';
import { WarningError } from './warnings.js';
import type { WarningDependencies } from './warnings.js';

export function warningDependencies(
  client: Client, guildId: string, readLogChannels: WarningDependencies['readLogChannels']
): WarningDependencies {
  async function send(channelId: string, body: RESTPostAPIChannelMessageJSONBody) {
    const message = await client.rest.post(Routes.channelMessages(channelId), {
      body, signal: AbortSignal.timeout(15000),
    }) as RESTPostAPIChannelMessageResult;
    return { id: message.id };
  }
  return {
    readLogChannels,
    readActorRoles: async (actorId) => {
      try {
        const member = await client.rest.get(Routes.guildMember(guildId, actorId)) as RESTGetAPIGuildMemberResult;
        return member.roles;
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10007) return null;
        throw error;
      }
    },
    readContext: async (actorId, targetId) => {
      const guild = await client.guilds.fetch({ guild: guildId, force: true });
      await guild.roles.fetch();
      let actor;
      try { actor = await guild.members.fetch({ user: actorId, force: true }); }
      catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10007) throw new WarningError('STAFF_REQUIRED');
        throw error;
      }
      let target;
      try { target = await guild.members.fetch({ user: targetId, force: true }); }
      catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10007) throw new WarningError('TARGET_NOT_MEMBER');
        throw error;
      }
      return {
        actorRoleIds: [...actor.roles.cache.keys()], targetRoleIds: [...target.roles.cache.keys()],
        targetIsBot: target.user.bot, targetIsOwner: targetId === guild.ownerId,
        actorAboveTarget: actorId === guild.ownerId || actor.roles.highest.comparePositionTo(target.roles.highest) > 0,
        guildName: guild.name,
      };
    },
    sendDM: async (targetId, body) => {
      const channel = await client.rest.post(Routes.userChannels(), {
        body: { recipient_id: targetId }, signal: AbortSignal.timeout(15000),
      }) as { id: string };
      return send(channel.id, body);
    },
    sendLog: send,
  };
}
