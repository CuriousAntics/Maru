# Dashboard sign in

The first dashboard supports Discord sign-in, a live staff access display, the latest 20 audit events for the configured test server, and sign-out. Configuration and grant/revoke website forms are not included in this increment.

## Hosting configuration

Use the existing Maru Railway service and its existing `DISCORD_TOKEN`, `DISCORD_TEST_GUILD_ID`, and private database reference. Add these dashboard variables to that service:

| Variable | Value |
| --- | --- |
| `APP_BASE_URL` | `https://maru-production-ae8c.up.railway.app` |
| `DISCORD_APPLICATION_ID` | The Application ID for Maru Test, already saved in your local `.env` |
| `DISCORD_CLIENT_SECRET` | The Maru Test OAuth2 client secret from the Discord Developer Portal |

The client secret is different from the bot token. Never commit either secret. The callback registered under Maru Test OAuth2 Redirects must be exactly:

```text
https://maru-production-ae8c.up.railway.app/auth/discord/callback
```

Missing dashboard variables disable website sign-in but do not stop the bot. Invalid configuration is logged without values. The existing `/healthz` endpoint continues to report bot/database readiness, not dashboard configuration readiness.

## Database migration

Apply `002_dashboard_auth.sql` using the existing migration runner. The pre-deploy command remains `npm run db:migrate:deploy`. The SQL creates login-attempt and session tables; no existing roles, grants, or audit records are rewritten. A successful first application reports `Applied 002_dashboard_auth.sql`.

## Session behavior

Sign-in uses the authorization-code flow and the `identify` scope. The server validates a browser-bound, five-minute, single-use state before exchanging a code. Discord access tokens are used for identity, never stored, and revocation is attempted immediately afterward.

Sessions have an eight-hour absolute expiry and are stored in PostgreSQL, allowing them to survive a bot restart. Only the session-token hash is stored. Production cookies are host-only, Secure, HttpOnly, and SameSite Lax. Sign-out requires a same-origin POST with a session-bound proof, and deletes the server-side session.

Every dashboard request fetches current membership through the bot and reuses the existing database staff-access policy. Losing staff roles invalidates the session. Grant revocation immediately changes the next request's access level. Membership/provider/database failures do not grant access or expose audit data.

A public sign-in page is available to visitors; audit data requires staff access. The page does not request email or server-list OAuth scopes. Audit timestamps are explicitly displayed in UTC. Existing `/staff-access` commands continue to manage grants.

## Verification

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts test/dashboard.test.ts
```

The automated HTTP and PostgreSQL tests use an isolated in-memory database and fake Discord responses. They do not contact Discord or Railway. Tests cover the login lifecycle, invalid state/callbacks, permission changes, session expiry, logout, escaping, and server isolation.

Live checks after deployment:

1. Open `/healthz` and confirm ready.
2. Open `/`, choose Continue with Discord, and authorize Maru Test.
3. Confirm your name, current access, and the known grant/revoke audit events.
4. Sign out and confirm `/dashboard` redirects to sign-in.
5. Verify ordinary Mods can view their own Moderator access; members without configured staff roles are denied.
6. Refresh a signed-in dashboard after removing staff roles and confirm access is denied.

Production callback URL: never share screenshots or browser URLs containing an OAuth `code`. Share only the final dashboard or the generic error page.

Reference: https://docs.discord.com/developers/topics/oauth2
