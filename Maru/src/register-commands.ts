import { REST, Routes } from 'discord.js';
import { ping } from './commands.js';
import { required, snowflake } from './config.js';

try {
  const applicationId = snowflake('DISCORD_APPLICATION_ID');
  const guildId = snowflake('DISCORD_TEST_GUILD_ID');
  const rest = new REST({ version: '10' }).setToken(required('DISCORD_TOKEN'));
  // Upsert this one test command, preserving any other registered commands.
  await rest.post(Routes.applicationGuildCommands(applicationId, guildId), {
    body: ping.toJSON(),
  });
  console.log('Registered /ping in the configured test server.');
} catch {
  console.error('Command registration failed. Check the TEST application/server IDs, token, installation, and network access.');
  process.exitCode = 1;
}
