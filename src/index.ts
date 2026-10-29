import { raidDependencies } from './raid-discord.js';
import { startRaidWorker } from './raid-worker.js';
import { startCommunityWorker } from './community-worker.js';
import { communityDependencies, communityResources, communityVoiceSnapshot } from './community-discord.js';
import { startHoneypotWorker } from './honeypot-worker.js';
import { honeypotDependencies, honeypotResources } from './honeypot-discord.js';
import { createServer } from 'node:http';
import { Client, Events, GatewayIntentBits, MessageFlags, ChannelType, PermissionFlagsBits } from 'discord.js';
import pg from 'pg';
import { port, required, snowflake } from './config.js';
import { getStaffAccess } from './staff-access.js';
import { handleStaffAccess } from './handle-staff-access.js';
import { handleBan } from './handle-ban.js';
import { banDependencies } from './ban-discord.js';
import { handleTimeout } from './handle-timeout.js';
import { timeoutDependencies } from './timeout-discord.js';
import { handleWarning } from './handle-warning.js';
import { warningDependencies } from './warning-discord.js';
import { parseStarboardEvent, enqueueStarboardEvent, startStarboardWorker } from './starboard-worker.js';
import { starboardRuntimeDependencies } from './starboard-runtime-discord.js';
import { starboardResources } from './starboard-discord.js';
import { autoModResources, autoModDependencies } from './automod-discord.js';
import { startAutoModWorker } from './automod-worker.js';
import { createDashboardHandler } from './dashboard.js';
import { dashboardConfig } from './web-security.js';
import { Routes } from 'discord.js';
import type { RESTGetAPIGuildMemberResult, RESTPostAPIChannelMessageResult } from 'discord.js';

async function main(): Promise<void> {
  const token = required('DISCORD_TOKEN');
  const guildId = snowflake('DISCORD_TEST_GUILD_ID');
  const connectionString = required('DATABASE_URL');
  const listenPort = port();
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    query_timeout: 5000,
  });
  const communityEvents = process.env.COMMUNITY_EVENTS_ENABLED === 'true';
  let communityConnected = false;
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent, ...(communityEvents ? [GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates] : [])] });
  let stopping = false;
  let webConfig;
  try { webConfig = dashboardConfig(process.env); }
  catch { console.error('Dashboard configuration is invalid; dashboard sign-in is disabled.'); }
  const readLogChannels = async () => {
    const guild = await client.guilds.fetch(guildId);
    await guild.roles.fetch();
    const me = await guild.members.fetchMe({ force: true });
    const channels = await guild.channels.fetch();
    return [...channels.values()].flatMap((channel) => {
      if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return [];
      const permissions = channel.permissionsFor(me);
      return [{ id: channel.id, name: channel.name, usable: permissions.has([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
      ]) }];
    }).sort((a, b) => a.name.localeCompare(b.name));
  };
  const warningDeps = warningDependencies(client, guildId, readLogChannels);
  const timeoutDeps = timeoutDependencies(client, guildId, token, warningDeps);
  const banDeps = banDependencies(client, guildId, token, warningDeps);
  const raidDeps = raidDependencies(client, guildId, token, communityEvents);
  const dashboard = createDashboardHandler({
    pool, guildId, config: webConfig,
    isBotReady: () => !stopping && client.isReady(),
    sendTestMessage: async (channelId, body) => {
      const message = await client.rest.post(Routes.channelMessages(channelId), {
        body, signal: AbortSignal.timeout(15000),
      }) as RESTPostAPIChannelMessageResult;
      return { id: message.id, channel_id: message.channel_id };
    },
    readLogChannels,
    raidDependencies: raidDeps,
    readCommunityResources: communityResources(client, guildId, communityEvents),
    readHoneypotResources: honeypotResources(client, guildId),
    readAutoModResources: autoModResources(client, guildId),
    readStarboardResources: starboardResources(client, guildId),
    readMemberRoles: async (userId) => {
      try {
        const member = await client.rest.get(Routes.guildMember(guildId, userId)) as RESTGetAPIGuildMemberResult;
        return member.roles;
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10007) return null;
        throw error;
      }
    },
  });
  const starboardWorker = startStarboardWorker(pool, guildId, starboardRuntimeDependencies(client, guildId, token),
    () => !stopping && client.isReady());
  const autoModWorker = startAutoModWorker(pool, guildId, autoModDependencies(client, guildId, token),
    () => !stopping && client.isReady());
  const honeypotWorker = startHoneypotWorker(pool, guildId, honeypotDependencies(client, guildId, token, warningDeps),
    () => !stopping && client.isReady());
  const raidWorker = startRaidWorker(pool, guildId, raidDeps, warningDeps, () => !stopping && client.isReady());
  const communityWorker = startCommunityWorker(pool, guildId, communityDependencies(client, guildId, token), {
    isReady: () => communityEvents && communityConnected && !stopping && client.isReady(),
    snapshot: () => communityVoiceSnapshot(client, guildId),
    readParent: async (id) => {
      const guild = await client.guilds.fetch(guildId);
      const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id);
      if (!channel) throw new Error('CHANNEL_UNAVAILABLE');
      return channel.isThread() ? channel.parentId : null;
    },
  });
  client.on(Events.VoiceStateUpdate, (_old, state) => { if (state.guild.id === guildId) communityWorker.voiceChanged(); });
  client.on(Events.ShardDisconnect, () => { communityConnected = false; communityWorker.resetVoice(); });
  client.on(Events.ShardReconnecting, () => { communityConnected = false; communityWorker.resetVoice(); });
  client.on(Events.ShardResume, () => { communityConnected = true; communityWorker.resetVoice(); });
  client.on(Events.GuildUnavailable, (guild) => { if (guild.id === guildId) { communityConnected = false; communityWorker.resetVoice(); } });
  client.on(Events.GuildAvailable, (guild) => { if (guild.id === guildId) { communityConnected = true; communityWorker.resetVoice(); } });
  client.on(Events.Raw, (packet) => {
    if (stopping) return;
    communityWorker.accept(packet);
    honeypotWorker.accept(packet);
    autoModWorker.accept(packet);
    const event = parseStarboardEvent(packet, guildId);
    if (event) void enqueueStarboardEvent(pool, event).catch(() => console.error('Starboard event could not be saved; observed messages will be rechecked.'));
  });
  const server = createServer((request, response) => {
    if (request.url !== '/healthz') {
      void dashboard(request, response);
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
    const stoppedWorkers = await Promise.allSettled([starboardWorker.stop(), autoModWorker.stop(), honeypotWorker.stop(), communityWorker.stop(), raidWorker.stop()]);
    if (stoppedWorkers.some((result) => result.status === 'rejected')) console.error('An automation worker could not finish shutdown; review saved work after restart.');
    await client.destroy();
    await Promise.allSettled([
      pool.end(),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
    process.exitCode = exitCode;
  }

  pool.on('error', () => console.error('PostgreSQL connection error. Check host status and network access.'));
  client.on(Events.Error, () => console.error('Discord client error. Check connection status.'));
  client.once(Events.ClientReady, () => { communityConnected = true; communityWorker.resetVoice(); console.log('Maru is connected to Discord.'); });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!['ping', 'staff-check', 'staff-access', 'warn', 'case', 'timeout', 'untimeout', 'ban', 'unban'].includes(interaction.commandName)) return;
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
      if (interaction.commandName === 'ban' || interaction.commandName === 'unban') {
        await handleBan(interaction, pool, guildId, banDeps);
        return;
      }
      if (interaction.commandName === 'timeout' || interaction.commandName === 'untimeout') {
        await handleTimeout(interaction, pool, guildId, timeoutDeps);
        return;
      }
      if (interaction.commandName === 'warn' || interaction.commandName === 'case') {
        await handleWarning(interaction, pool, guildId, warningDeps);
        return;
      }
      if (interaction.commandName === 'staff-access') {
        await handleStaffAccess(interaction, pool, guildId);
        return;
      }
      const roleIds = Array.isArray(interaction.member.roles)
        ? interaction.member.roles
        : [...interaction.member.roles.cache.keys()];
      const access = await getStaffAccess(pool, guildId, interaction.user.id, roleIds);
      await interaction.editReply(access === 'none'
        ? 'Access denied: you do not have a configured Maru staff role.'
        : `Your Maru access level: ${access === 'admin' ? 'Admin' : 'Moderator'}.`);
    } catch {
      console.error('Command failed; a requested change may already have been saved.');
      try {
        const content = 'Maru could not finish this request. A requested change may already have been saved.';
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
