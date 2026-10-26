import type { ChatInputCommandInteraction } from 'discord.js';
import type { Pool } from 'pg';
import { runTimeout, timeoutNotification, TimeoutError } from './timeouts.js';
import type { TimeoutDependencies } from './timeouts.js';
import { parseTimeoutDuration } from './case-labels.js';
import { deliverWarning } from './warnings.js';
import type { WarningCase } from './warnings.js';
import { caseSummary } from './handle-warning.js';

const messages: Record<string,string> = {
  STAFF_REQUIRED: 'Access denied: you need a configured Maru staff role.',
  SERVER_NOT_CONFIGURED: 'Staff access is not configured for this server.',
  SELF_TARGET: 'You cannot change your own timeout.',
  BOT_TARGET: 'Timeout commands cannot target bots.',
  PROTECTED_TARGET: 'The server owner and native Administrator accounts cannot be targeted.',
  ACTOR_PERMISSION: 'Your Discord roles also need Moderate Members permission.',
  BOT_PERMISSION: 'Maru needs Moderate Members permission and a role above the target member.',
  ROLE_HIERARCHY: 'Your highest Discord role must be above the target member’s highest role.',
  STAFF_TARGET: 'You cannot target staff with equal or greater Maru access.',
  TARGET_NOT_MEMBER: 'The target is no longer a member of this server.',
  MEMBER_BUSY: 'Another Maru timeout operation for this member is still running. Check its result before trying again.',
  NO_TIMEOUT: 'This member does not currently have an active timeout. No action or notification was sent.',
  INVALID_REASON: 'Enter a reason from 1 to 500 characters.',
  INVALID_DURATION: 'Use a duration like 30s, 10m, 2h, 1d, or 1w; maximum 28d.',
  REQUEST_MISMATCH: 'This interaction already recorded a different action. Review the saved case before retrying.',
};
export async function handleTimeout(interaction: ChatInputCommandInteraction, pool: Pool, guildId: string, deps: TimeoutDependencies): Promise<void> {
  let saved: WarningCase | undefined;
  const reply = (content: string) => interaction.editReply({ content,allowedMentions: { parse: [] } });
  try {
    const action = interaction.commandName === 'timeout' ? 'timeout' : 'untimeout';
    let durationSeconds: number | undefined;
    if (action === 'timeout') {
      try { durationSeconds = parseTimeoutDuration(interaction.options.getString('duration',true)); }
      catch { await reply(messages.INVALID_DURATION!); return; }
    }
    const result = await runTimeout(pool, { guildId,actorId: interaction.user.id,
      targetId: interaction.options.getUser('member',true).id,requestId: interaction.id,action,durationSeconds,
      reason: interaction.options.getString('reason',true) },deps);
    saved = result.record;
    if (result.created) saved = await deliverWarning(pool,saved,deps,timeoutNotification);
    await reply(`${result.created ? 'Moderation case saved.' : 'This interaction was already recorded. No action or notification was repeated.'}\n` +
      caseSummary(saved) + '\nRecorded results may differ from the member’s current Discord timeout. DM/log failures do not undo a successful action.');
  } catch (error: unknown) {
    if (saved || (error instanceof TimeoutError && error.caseNumber)) {
      const number = saved?.case_number ?? (error as TimeoutError).caseNumber!;
      await reply(`Case #${number} is saved, but its final action or delivery result may be unavailable. ` +
        `Use /case number:${number} and check the member’s current Discord timeout before issuing another command. No automatic retry was scheduled.`);
    } else if (error instanceof TimeoutError && messages[error.code]) await reply(messages[error.code]!);
    else {
      console.error('Timeout command could not finish. Check saved cases and the member’s current Discord state before retrying.');
      await reply('Maru could not finish this request. A case or action may already exist. Check Recent staff activity and the member’s Discord timeout before trying again.');
    }
  }
}
