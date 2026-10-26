import type { ChatInputCommandInteraction } from 'discord.js';
import type { Pool } from 'pg';
import { BanError, runBan, banNotification, parseDeleteHistory } from './bans.js';
import type { BanDependencies } from './bans.js';
import { deliverWarning } from './warnings.js';
import type { WarningCase } from './warnings.js';
import { caseSummary } from './handle-warning.js';

const messages: Record<string,string> = {
  STAFF_REQUIRED: 'Access denied: you need a configured Maru staff role.',
  SERVER_NOT_CONFIGURED: 'Staff access is not configured for this server.',
  SELF_TARGET: 'You cannot ban or unban yourself.',
  BOT_TARGET: 'This command cannot ban bots.',
  PROTECTED_TARGET: 'The server owner and native Administrator accounts are protected.',
  ACTOR_PERMISSION: 'Your Discord roles also need Ban Members permission.',
  BOT_PERMISSION: 'Maru needs Ban Members permission and, for bans, a role above the target.',
  ROLE_HIERARCHY: 'Your highest Discord role must be above the target member’s highest role.',
  STAFF_TARGET: 'You cannot ban staff with equal or greater Maru access.',
  TARGET_NOT_MEMBER: 'This ban command requires a current server member.',
  MEMBER_BUSY: 'Another Maru operation for this member is running. Check its result before trying again.',
  ALREADY_BANNED: 'This user is already banned. No additional deletion or notification was requested.',
  NOT_BANNED: 'This user is not currently banned. No action or notification was sent.',
  INVALID_INPUT: 'Enter a valid Discord user ID (17 to 20 digits).',
  INVALID_REASON: 'Enter a reason from 1 to 500 characters.',
  INVALID_HISTORY: 'Use 0 to keep messages, or a duration such as 1h, 24h, or 7d. Maximum 7d; default 24h.',
  REQUEST_MISMATCH: 'This interaction already recorded a different action. Review the saved case before retrying.',
};
export async function handleBan(interaction: ChatInputCommandInteraction, pool: Pool, guildId: string, deps: BanDependencies): Promise<void> {
  let saved: WarningCase | undefined;
  const reply = (content: string) => interaction.editReply({ content,allowedMentions: { parse: [] } });
  try {
    const action = interaction.commandName === 'ban' ? 'ban' : 'unban';
    const targetId = action === 'ban' ? interaction.options.getUser('member',true).id : interaction.options.getString('user-id',true).trim();
    const deleteSeconds = action === 'ban' ? parseDeleteHistory(interaction.options.getString('delete-history')) : undefined;
    const result = await runBan(pool,{ guildId,actorId: interaction.user.id,targetId,requestId: interaction.id,action,deleteSeconds,
      reason: interaction.options.getString('reason',true) },deps);
    saved = result.record;
    if (result.created) saved = await deliverWarning(pool,saved,deps,banNotification);
    await reply(`${result.created ? 'Moderation case saved.' : 'This interaction was already recorded. No action or notification was repeated.'}\n` +
      caseSummary(saved) + '\nThese are historical results. Unbanning does not restore deleted messages or automatically rejoin the member.');
  } catch (error: unknown) {
    if (saved || (error instanceof BanError && error.caseNumber)) {
      const number = saved?.case_number ?? (error as BanError).caseNumber!;
      await reply(`Case #${number} is saved, but a final result may be unavailable. Use /case number:${number} and check Discord’s current ban list before issuing another command. No automatic retry was scheduled.`);
    } else if (error instanceof BanError && messages[error.code]) await reply(messages[error.code]!);
    else {
      console.error('Ban command could not finish. Review saved cases and the current Discord ban list before retrying.');
      await reply('Maru could not finish this request. A case or action may already exist. Check Recent staff activity and Discord’s ban list before trying again.');
    }
  }
}
