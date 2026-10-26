import { escapeMarkdown } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Pool } from 'pg';
import { actionLabel, actionResultLabel, durationLabel } from './case-labels.js';
import { createWarning, deliverWarning, getWarningCase, WarningError } from './warnings.js';
import type { DeliveryStatus, WarningCase, WarningDependencies } from './warnings.js';

const errors: Record<string, string> = {
  STAFF_REQUIRED: 'Access denied: you need a configured Maru staff role.',
  SELF_TARGET: 'You cannot warn yourself.',
  BOT_TARGET: 'Bots cannot receive warnings.',
  OWNER_TARGET: 'The server owner cannot receive warnings.',
  ROLE_HIERARCHY: 'Your highest Discord role must be above the member’s highest role.',
  STAFF_TARGET: 'You cannot warn staff with equal or greater Maru access.',
  TARGET_NOT_MEMBER: 'The member is no longer in this server.',
  INVALID_REASON: 'Enter a reason from 1 to 500 characters, excluding surrounding spaces.',
  INVALID_ID: 'A valid server, member, and interaction ID are required.',
  INVALID_CASE: 'Enter a case number between 1 and 2147483647.',
  SERVER_NOT_CONFIGURED: 'Staff access is not configured for this server.',
  REQUEST_MISMATCH: 'This interaction already recorded a different warning. Review the audit log before retrying.',
};
export function deliveryLabel(status: DeliveryStatus): string {
  return ({ pending: 'Not attempted', sending: 'Not confirmed (attempt started)', sent: 'Sent',
    failed: 'Failed', unconfirmed: 'Not confirmed', not_configured: 'No log channel configured', skipped: 'Not sent (action not confirmed)' })[status];
}
export function caseSummary(record: WarningCase): string {
  return `Case #${record.case_number} · ${actionLabel(record.action)} · ${record.action !== 'warning' ? 'Recorded' : record.state === 'void' ? 'Voided' : 'Active'}\nMember ID: ${record.target_user_id}\nStaff ID: ${record.actor_id}\n` +
    `Reason: ${escapeMarkdown(record.reason)}\nCreated: ${new Date(record.created_at).toISOString()}\n` +
    (record.action !== 'warning' ? `Action: ${actionResultLabel(record.action_status)}\n` : '') +
    (record.action === 'timeout' || record.action === 'untimeout' ? `Requested end UTC: ${record.requested_until ? new Date(record.requested_until).toISOString() : 'None (removal)'}\n` : '') +
    (record.action === 'ban' ? `Requested message deletion: ${record.delete_message_seconds === 0 ? 'Keep history' : durationLabel(record.delete_message_seconds!)}\nThe pre-ban DM is attempted before the ban; its delivery result is shown below.\n` : record.action === 'unban' ? 'No member DM is sent for unbans.\n' : '') +
    `DM: ${record.action === 'unban' ? 'Not sent for unbans' : deliveryLabel(record.dm_status)}\nModeration log: ${deliveryLabel(record.log_status)}`;
}

export async function handleWarning(
  interaction: ChatInputCommandInteraction, pool: Pool, guildId: string, deps: WarningDependencies
): Promise<void> {
  let saved: WarningCase | undefined;
  async function reply(content: string) {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
  }
  try {
    if (interaction.commandName === 'case') {
      const record = await getWarningCase(pool, {
        guildId, actorId: interaction.user.id, caseNumber: interaction.options.getInteger('number', true),
      }, deps.readActorRoles);
      await reply(record ? caseSummary(record) : 'No case with that number exists in this server.');
      return;
    }
    const target = interaction.options.getUser('member', true);
    const result = await createWarning(pool, { guildId, actorId: interaction.user.id, targetId: target.id,
      requestId: interaction.id, reason: interaction.options.getString('reason', true) }, deps);
    saved = result.record;
    if (result.created) saved = await deliverWarning(pool, saved, deps);
    await reply(`${result.created ? 'Warning saved.' : 'This interaction already saved a warning. No additional messages were sent.'}\n` +
      caseSummary(saved) + '\nThe warning remains saved regardless of delivery status. Sent means Discord confirmed message creation, not that it was read.');
  } catch (error: unknown) {
    if (saved) {
      await reply(`Warning #${saved.case_number} is saved. Delivery or the response could not be completed. ` +
        `Use /case number:${saved.case_number} to check it before issuing another warning.`);
    } else if (error instanceof WarningError && errors[error.code]) {
      await reply(errors[error.code]!);
    } else {
      console.error('Moderation request could not be completed. Check saved cases and audit events before retrying.');
      await reply(interaction.commandName === 'case'
        ? 'Maru could not read this case. Please try again shortly.'
        : 'Maru could not finish this request. A warning may already have been saved. Check Recent staff activity before issuing another warning.');
    }
  }
}
