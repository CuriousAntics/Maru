import { REST, Routes } from 'discord.js';
import { ping, staffCheck } from './commands.js';
import { required, snowflake } from './config.js';

try {
  const applicationId = snowflake('DISCORD_APPLICATION_ID');
  const guildId = snowflake('DISCORD_TEST_GUILD_ID');
  const rest = new REST({ version: '10' }).setToken(required('DISCORD_TOKEN'));
  // Upsert these commands individually, preserving unrelated commands.
  for (const command of [ping, staffCheck]) {
    await rest.post(Routes.applicationGuildCommands(applicationId, guildId), {
      body: command.toJSON(),
    });
  }
  console.log('Registered /ping and /staff-check in the configured test server.');
} catch {
  console.error('Command registration failed. Check the TEST application/server IDs, token, installation, and network access.');
  process.exitCode = 1;
}
