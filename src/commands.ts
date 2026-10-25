import { SlashCommandBuilder } from 'discord.js';

export const ping = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether Maru is responding.');

export const staffCheck = new SlashCommandBuilder()
  .setName('staff-check')
  .setDescription('Check your configured Maru staff access.');
