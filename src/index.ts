import { createServer } from 'node:http';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import pg from 'pg';
import { port, required, snowflake } from './config.js';
import { getStaffAccess } from './staff-access.js';

async function main(): Promise<void> {
  const token = required('DISCORD_TOKEN');
  const guildId = snowflake('DISCORD_TEST_GUILD_ID');
  const connectionString = required('DATABASE_URL');
  const listenPort = port();
  const pool = new pg.Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    query_timeout: 5000,
  });
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let stopping = false;
  const server = createServer((request, response) => {
    if (request.url !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      let databaseReady = false;
      try { await pool.query('SELECT 1'); databaseReady = true; } catch { /* Report unhealthy below. */ }
      const ready = !stopping && client.isReady() && databaseReady;
      response.writeHead(ready ? 200 : 503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      }).end(JSON.stringify({ status: ready ? 'ready' : 'unavailable' }));
    })().catch(() => { response.destroy(); });
  });

  async function shutdown(exitCode: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(exitCode || 1), 10000);
    deadline.unref();
    await client.destroy();
    await Promise.allSettled([
      pool.end(),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
    process.exitCode = exitCode;
  }

  pool.on('error', () => console.error('PostgreSQL connection error. Check host status and network access.'));
  client.on(Events.Error, () => console.error('Discord client error. Check connection status.'));
  client.once(Events.ClientReady, () => console.log('Maru is connected to Discord.'));
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!['ping', 'staff-check'].includes(interaction.commandName)) return;
    try {
      if (interaction.guildId !== guildId || !interaction.member) {
        await interaction.reply({
          content: 'This starter is limited to the configured test server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (interaction.commandName === 'ping') {
        await interaction.reply({ content: 'Pong! Maru is online.', flags: MessageFlags.Ephemeral });
        return;
      }

      // Acknowledge before the database query so a slow query cannot time out the interaction.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const roleIds = Array.isArray(interaction.member.roles)
        ? interaction.member.roles
        : [...interaction.member.roles.cache.keys()];
      const access = await getStaffAccess(pool, guildId, interaction.user.id, roleIds);
      await interaction.editReply(access === 'none'
        ? 'Access denied: you do not have a configured Maru staff role.'
        : `Your Maru access level: ${access === 'admin' ? 'Admin' : 'Moderator'}.`);
    } catch {
      console.error('Command failed. Access was not granted.');
      try {
        const content = 'Maru could not verify your access. Please try again later.';
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(content);
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      } catch { console.error('Could not send the command failure response.'); }
    }
  });
  process.once('SIGTERM', () => { void shutdown(0); });
  process.once('SIGINT', () => { void shutdown(0); });

  let startupStage = 'PostgreSQL connection';

  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL connection verified.');

    startupStage = 'HTTP health server';
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, '0.0.0.0', resolve);
    });

    startupStage = 'Discord login';
    await client.login(token);
  } catch (error: unknown) {
    const rawCode = error && typeof error === 'object' && 'code' in error
      ? String(error.code) : 'NO_CODE';

    const safeCode = /^[A-Za-z0-9_]+$/.test(rawCode)
      ? rawCode : 'UNRECOGNIZED_CODE';

    console.error(`Startup failed at ${startupStage}; code=${safeCode}`);
    await shutdown(1);

        const operation = error && typeof error === 'object' && 'syscall' in error
      ? String(error.syscall) : 'unknown';

    console.error(
      `Failed operation: ${/^[A-Za-z0-9_]+$/.test(operation) ? operation : 'unknown'}`
    );
  }
}

main().catch(() => {
  // Avoid printing connection strings or bot tokens in error objects.
  console.error('Maru could not start. Check required environment settings.');
  process.exitCode = 1;
});
