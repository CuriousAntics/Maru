import { PermissionFlagsBits, REST, Routes } from 'discord.js';
import type { Client, GuildMember, RESTPostAPIChannelMessageResult } from 'discord.js';
import { BanError } from './bans.js';
import type { BanDependencies } from './bans.js';
import type { WarningDependencies } from './warnings.js';

export function banDependencies(client: Client, guildId: string, token: string, warnings: WarningDependencies,
  writerOverride?: Pick<REST,'put' | 'delete' | 'post'>): BanDependencies {
  // Do not retry mutations after an ambiguous network/server response.
  const writer = writerOverride ?? new REST({ version: '10',retries: 0,timeout: 15000 }).setToken(token);
  return { ...warnings,
    readBanContext: async (actorId,targetId,action) => {
      const guild = await client.guilds.fetch({ guild: guildId,force: true });
      await guild.roles.fetch();
      let actor: GuildMember;
      try { actor = await guild.members.fetch({ user: actorId,force: true }); }
      catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10007) throw new BanError('STAFF_REQUIRED');
        throw error;
      }
      const me = await guild.members.fetchMe({ force: true });
      // Authorize before reading the ban list; permission/lookup failures fail closed.
      if (!actor.permissions.has(PermissionFlagsBits.BanMembers)) throw new BanError('ACTOR_PERMISSION');
      if (!me.permissions.has(PermissionFlagsBits.BanMembers)) throw new BanError('BOT_PERMISSION');
      let isBanned = false;
      try { await guild.bans.fetch({ user: targetId,force: true }); isBanned = true; }
      catch (error: unknown) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 10026)) throw error;
      }
      let target: GuildMember | undefined;
      if (action === 'ban' && !isBanned) {
        try { target = await guild.members.fetch({ user: targetId,force: true }); }
        catch (error: unknown) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 10007)) throw error;
        }
      }
      return {
        actorRoleIds: [...actor.roles.cache.keys()],targetRoleIds: target ? [...target.roles.cache.keys()] : [],
        guildName: guild.name,targetIsMember: !!target,isBanned,
        targetIsBot: target?.user.bot ?? false,targetIsOwner: targetId === guild.ownerId,
        targetIsAdministrator: target?.permissions.has(PermissionFlagsBits.Administrator) ?? false,
        actorAboveTarget: !!target && (actor.id === guild.ownerId || actor.roles.highest.comparePositionTo(target.roles.highest) > 0),
        botAboveTarget: !!target && me.roles.highest.comparePositionTo(target.roles.highest) > 0,
        actorCanBan: true,botCanBan: true,
      };
    },
    sendDM: async (targetId,body) => {
      const channel = await writer.post(Routes.userChannels(),{ body: { recipient_id: targetId },signal: AbortSignal.timeout(15000) }) as { id: string };
      const message = await writer.post(Routes.channelMessages(channel.id),{ body,signal: AbortSignal.timeout(15000) }) as RESTPostAPIChannelMessageResult;
      return { id: message.id };
    },
    applyBan: async (targetId,deleteSeconds,caseNumber,action) => {
      const options = { signal: AbortSignal.timeout(15000),reason: `Maru ${action} case #${caseNumber}` };
      const result = action === 'ban'
        ? await writer.put(Routes.guildBan(guildId,targetId),{ ...options,body: { delete_message_seconds: deleteSeconds } })
        : await writer.delete(Routes.guildBan(guildId,targetId),options);
      if (result !== undefined && result !== null) throw new Error('UNEXPECTED_RESPONSE');
    },
  };
}
