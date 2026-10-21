# Maru

TypeScript and PostgreSQL starter for CuriousAntics/Maru.

Milestone 0 foundation: connects to PostgreSQL and Discord, answers a test-server `/ping`, and exposes `/healthz`. Moderation, roles, Starboard, migrations, and the staff dashboard will be added in later milestones. This starter changes no member roles and executes no moderation actions.

## Requirements

- Node.js 24 with npm.
- A separate Discord TEST application/bot installed in a private test server.
- A PostgreSQL database connection string. Railway PostgreSQL can supply it.

## Windows development

Run these commands from the repository folder in PowerShell:

```powershell
npm ci
Copy-Item .env.example .env
```

Enter the TEST bot token, application ID, test-server ID, and database URL in `.env` using a local editor. Never paste credentials into chat or commit `.env`.

```powershell
npm run check
npm run commands:test
npm run dev
```

Run `/ping` inside the private test server. Expected reply: `Pong! Maru is online.` Check `http://localhost:3000/healthz`: it returns 200 only when Discord and PostgreSQL are both connected. Startup requires all bot settings and a reachable database. The command registration script upserts only `/ping` in the configured test server; it does not publish global commands or delete unrelated commands.

## Railway deployment

Connect the private GitHub repository and add PostgreSQL in the same Railway project. The included Dockerfile builds the bot. Configure these service variables:

- `DISCORD_TOKEN`: TEST bot token during this milestone.
- `DISCORD_TEST_GUILD_ID`: private test-server ID.
- `DATABASE_URL`: reference to PostgreSQL's private connection URL for this deployment.
- `DISCORD_APPLICATION_ID`: needed for command registration; it is not read by the running bot.

Railway supplies `PORT`. Set the healthcheck path to `/healthz`, keep Serverless/app sleeping disabled for this persistent bot, and use one replica. Register `/ping` separately with `npm run commands:test`; startup intentionally does not register commands. Do not use a Railway private database hostname from your desktop: local development needs a database endpoint reachable from the desktop, with the TLS settings required by its provider. Do not disable certificate verification as a shortcut.

## Milestone 0 completion

- Dependency installation, TypeScript check, and build succeed.
- Test application is installed in the private test server.
- PostgreSQL connects and `/ping` responds.
- Railway healthcheck passes; restart recovers; the bot stays online when the desktop is off.
- Secrets are excluded from commits.

Live checks require your Discord and Railway setup; generating this starter alone does not complete Milestone 0.

## Next milestone

Database migrations, staff authentication, access grants, configuration persistence, and a backup/restore rehearsal.

## References

- [discord.js](https://discord.js.org/docs/packages/discord.js/14)
- [PostgreSQL connection pooling](https://node-postgres.com/features/pooling)
- [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles)
- [Railway healthchecks](https://docs.railway.com/deployments/healthchecks)
