import { Routes } from 'discord.js';
import type { ChatInputCommandInteraction, RESTGetAPIGuildMemberResult } from 'discord.js';
import type { Pool } from 'pg';
import { getStaffAccess } from './staff-access.js';
import { changeStaffGrant, StaffGrantError } from './staff-grants.js';

const messages: Record<string, string> = {
  ADMIN_REQUIRED: 'Access denied: Admin access is required.',
  TARGET_MOD_ROLE_REQUIRED: 'The member must currently have a configured Mods role.',
  BOT_TARGET_NOT_ALLOWED: 'Full staff access cannot be granted to a bot.',
  SERVER_NOT_CONFIGURED: 'Staff access is not configured for this server.',
  INVALID_USER_ID: 'Enter a valid Discord user ID.',
  INVALID_REASON: 'Enter a reason from 1 to 500 characters, excluding surrounding spaces.',
};

export async function handleStaffAccess(
  interaction: ChatInputCommandInteraction, pool: Pool, guildId: string
): Promise<void> {
  const actor = await interaction.client.rest.get(
    Routes.guildMember(guildId, interaction.user.id)
  ) as RESTGetAPIGuildMemberResult;

  // Check before looking up a target; the transaction checks again before writing.
  if (await getStaffAccess(pool, guildId, interaction.user.id, actor.roles) !== 'admin') {
    await interaction.editReply(messages.ADMIN_REQUIRED!);
    return;
  }

  const action = interaction.options.getSubcommand(true);
  if (action !== 'grant' && action !== 'revoke') throw new StaffGrantError('INVALID_ACTION');
  let targetId: string;
  let targetRoleIds: string[] = [];
  let targetIsBot = false;
  if (action === 'grant') {
    const target = interaction.options.getUser('member', true);
    targetId = target.id;
    targetIsBot = Boolean(target.bot);
    if (!targetIsBot) {
      try {
        const member = await interaction.client.rest.get(
          Routes.guildMember(guildId, targetId)
        ) as RESTGetAPIGuildMemberResult;
        targetRoleIds = member.roles;
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10007) {
          await interaction.editReply('The target is no longer a member of this server.');
          return;
        }
        throw error;
      }
    }
  } else {
    targetId = interaction.options.getString('user-id', true).trim();
  }

  try {
    const result = await changeStaffGrant(pool, {
      guildId, actorId: interaction.user.id, actorRoleIds: actor.roles,
      targetId, targetRoleIds, targetIsBot, action,
      reason: interaction.options.getString('reason', true),
    });
    await interaction.editReply(action === 'grant'
      ? result === 'changed'
        ? 'Full Maru access granted. The grant is effective while the member has a configured Mods role.'
        : 'This member already has an individual full-access grant. No changes made.'
      : result === 'changed'
        ? 'Individual full-access grant revoked. Any access from configured roles still applies.'
        : 'No individual full-access grant exists for that user. No changes made.');
  } catch (error: unknown) {
    if (error instanceof StaffGrantError && messages[error.code]) {
      await interaction.editReply(messages[error.code]!);
      return;
    }
    throw error;
  }
}
