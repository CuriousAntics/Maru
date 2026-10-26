import { PermissionFlagsBits, REST, Routes } from 'discord.js';
import type { Client, RESTPatchAPIGuildMemberResult } from 'discord.js';
import { TimeoutError } from './timeouts.js';
import type { TimeoutDependencies } from './timeouts.js';
import type { WarningDependencies } from './warnings.js';

export function timeoutDependencies(client: Client, guildId: string, token: string, warnings: WarningDependencies, writerOverride?: Pick<REST, 'patch'>): TimeoutDependencies {
  // Native state changes must not be silently retried after a lost response.
  const writer = writerOverride ?? new REST({ version: '10', retries: 0, timeout: 15000 }).setToken(token);
  return { ...warnings,
    readTimeoutContext: async (actorId,targetId) => {
      const guild = await client.guilds.fetch({ guild: guildId,force: true });
      await guild.roles.fetch();
      let actor;
      try { actor = await guild.members.fetch({ user: actorId,force: true }); }
      catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10007) throw new TimeoutError('STAFF_REQUIRED');
        throw error;
      }
      let target;
      try { target = await guild.members.fetch({ user: targetId,force: true }); }
      catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10007) throw new TimeoutError('TARGET_NOT_MEMBER');
        throw error;
      }
      const me = await guild.members.fetchMe({ force: true });
      return {
        actorRoleIds: [...actor.roles.cache.keys()],targetRoleIds: [...target.roles.cache.keys()],
        targetIsBot: target.user.bot,targetIsOwner: target.id === guild.ownerId,
        actorAboveTarget: actor.id === guild.ownerId || actor.roles.highest.comparePositionTo(target.roles.highest) > 0,
        guildName: guild.name,actorCanModerate: actor.permissions.has(PermissionFlagsBits.ModerateMembers),
        botCanModerate: me.permissions.has(PermissionFlagsBits.ModerateMembers),
        botAboveTarget: me.roles.highest.comparePositionTo(target.roles.highest) > 0,
        targetIsAdministrator: target.permissions.has(PermissionFlagsBits.Administrator),
        previousUntil: target.communicationDisabledUntil?.toISOString() ?? null,
      };
    },
    applyTimeout: async (targetId,until,caseNumber,action) => {
      const result = await writer.patch(Routes.guildMember(guildId,targetId), {
        body: { communication_disabled_until: until },signal: AbortSignal.timeout(15000),
        reason: `Maru ${action} case #${caseNumber}`,
      }) as RESTPatchAPIGuildMemberResult;
      return { targetId: result.user?.id ?? '',until: result.communication_disabled_until ?? null };
    },
  };
}
