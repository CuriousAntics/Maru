import type { ChatInputCommandInteraction } from 'discord.js';
import type { Pool } from 'pg';
import { customName } from './custom-commands.js';
export async function handleCustomCommand(interaction: ChatInputCommandInteraction, pool: Pick<Pool,'query'>, guildId: string) {
  // Native interactions have no ordinary trigger message to delete; edit only the original public response.
  await interaction.deferReply();
  let content = 'This command is unavailable here.';
  if (interaction.guildId === guildId && interaction.member && !interaction.user.bot && customName(interaction.commandName)) {
    try {
      const command = (await pool.query<{ response: string }>(`SELECT response FROM custom_commands
        WHERE guild_id=$1 AND name=$2 AND discord_id=$3 AND enabled AND NOT deleted`,
        [guildId,interaction.commandName,interaction.commandId])).rows[0];
      content = command?.response ?? 'This custom command is currently Off or has changed. Try selecting it again from Maru’s commands.';
    } catch {
      content = 'Maru could not load this custom response. Please try again shortly.';
      console.error('Custom command response could not be loaded.');
    }
  }
  // Do not replace an uncertain successful response with an error or send follow-up posts.
  try { await interaction.editReply({content,allowedMentions:{parse:[]}}); }
  catch { console.error('Custom command response was not confirmed.'); }
}
