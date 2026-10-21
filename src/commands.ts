import { SlashCommandBuilder } from 'discord.js';

export const ping = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check whether Maru is responding.');
