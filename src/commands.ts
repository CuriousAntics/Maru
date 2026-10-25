import { SlashCommandBuilder } from 'discord.js';

export const ping = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether Maru is responding.');

export const staffCheck = new SlashCommandBuilder()
  .setName('staff-check')
  .setDescription('Check your configured Maru staff access.');

export const staffAccess = new SlashCommandBuilder()
  .setName('staff-access')
  .setDescription('Grant or revoke individual full Maru access.')
  .addSubcommand((command) => command
    .setName('grant')
    .setDescription('Grant full Maru access to a member with a configured Mods role.')
    .addUserOption((option) => option.setName('member')
      .setDescription('The moderator receiving access').setRequired(true))
    .addStringOption((option) => option.setName('reason')
      .setDescription('Why access is being granted').setMinLength(1).setMaxLength(500).setRequired(true)))
  .addSubcommand((command) => command
    .setName('revoke')
    .setDescription('Revoke an individual full-access grant, including for former members.')
    .addStringOption((option) => option.setName('user-id')
      .setDescription('Discord user ID of the person whose grant should be removed')
      .setMinLength(17).setMaxLength(20).setRequired(true))
    .addStringOption((option) => option.setName('reason')
      .setDescription('Why the grant is being revoked').setMinLength(1).setMaxLength(500).setRequired(true)));
