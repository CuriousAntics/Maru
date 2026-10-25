# Staff access commands

These commands operate only in `DISCORD_TEST_GUILD_ID` during development. They change Maru's database grants, not Discord roles or Discord Administrator permissions. Responses are private to the command user.

## Check your access

Run `/staff-check`. A configured Admin role grants Admin access. A configured Mods role grants Moderator access unless the member has an individual full-access grant, in which case it grants Admin access. Without either configured role, access is denied even if an old individual grant remains stored.

## Grant full access

Run `/staff-access grant member:<member> reason:<reason>`.

The actor must have Maru Admin access, including a Mod already granted full access. The target must be a current human server member with a configured Mods role. Full access includes administering other individual grants. A repeated grant preserves the original grant and creates no duplicate audit event.

## Revoke a grant

Run `/staff-access revoke user-id:<Discord user ID> reason:<reason>`.

The actor needs Maru Admin access. Revocation accepts a user ID so it works after the target leaves or loses their role. It removes only the individual grant: a configured Admin role continues to provide Admin access. A repeated revocation makes no changes.

## Audit history

Actual changes create `STAFF_ACCESS_GRANTED` or `STAFF_ACCESS_REVOKED` rows in `audit_events`, including the actor, target, reason, server, and timestamp. The grant mutation and audit record commit together. An audit-write failure rolls back the mutation. A dashboard for browsing these records will be added later.

Losing a Mods role makes a stored grant ineffective. Until explicitly revoked, the stored grant becomes effective again if the member regains a configured Mods role. Revoke obsolete grants to remove that stored authorization.

## Development checks

Install the test-only PostgreSQL WASM engine with `npm install --save-dev --save-exact @electric-sql/pglite@0.5.11`. It is omitted from the production image.

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts
```

Tests use an isolated in-memory database, never `DATABASE_URL`. Live Discord checks still need the hosted test bot. Required live scenarios: ordinary Mods denied, successful grant, elevated `/staff-check`, successful revoke, and return to Moderator access.
