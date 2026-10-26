# Dashboard moderation case history

Open **Moderation cases** in the staff navigation, or visit `/cases`. Configured Admins and ordinary Mods can view the configured server's saved cases. The existing current-session, current-membership, and database role/grant checks run before case queries. Losing staff roles blocks access; native Administrator permission alone does not bypass Maru's policy.

The list displays up to 20 cases, newest first, with case number, reason preview, member ID, staff ID, DM/log delivery status, and creation time in UTC. Clicking a case opens `/cases/<number>` with its complete reason, saved server name, saved log channel and message IDs, and both delivery statuses. Audit case numbers on the overview also link to this detail page.

## Filtering and pagination

- Filter by a saved member ID with 17–20 digits. Current server membership is not required, so departed members' history remains available.
- Clear the filter to return to all cases.
- **Older cases** uses the last displayed case number as a cursor, rather than a row offset. Newly created cases do not shift an existing cursor's results. The member filter is preserved across older-page links.
- **Newest cases** returns to the start of the current filtered history.
- The server reads at most 21 rows to determine whether another page exists; only 20 are displayed. It does not load the full case history into memory or perform an unbounded count.
- Invalid IDs, case numbers, duplicate filter values, and unsupported filter parameters receive a safe error. All SQL values are bound parameters, and every case query includes the server ID from host configuration. URL parameters cannot select another server.

## Delivery interpretation

The page reads the statuses recorded on the case. **Sent** means Discord confirmed message creation, not that a member read the message. **Not confirmed** or **Not confirmed (attempt started)** can follow a lost response, restart, or result-audit failure. No message is automatically resent by viewing or refreshing history.

These pages only display cases. They do not create, edit, void, or delete warnings, retry notifications, DM members, or post log messages. Warning reasons and stored names are HTML-escaped and are not interpreted as HTML. Detail reasons preserve line breaks. Authenticated case responses are not cached.

## Verification

No new packages, database migrations, environment variables, or slash-command registrations are required. The previously applied `003_moderation_warnings.sql` tables are used.

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts test/dashboard.test.ts test/warnings.test.ts
```

Tests use isolated synthetic cases and simulated Discord identity/membership responses. They cover staff permissions, session expiry, member filtering, cursor stability, HTML escaping, missing cases, delivery labels, server isolation, and the absence of case writes or message sends while browsing. They create no cases in Railway and send no Discord messages.

Live checks after deployment, without a test member:

1. Sign in and select Moderation cases.
2. Existing warnings should appear; if none exist, the empty-state message should appear.
3. Open an existing case, if available, and compare the case number, reason, and delivery statuses with `/case`.
4. Use a saved member ID to filter the list; Clear filter restores all cases.
5. Refresh a detail page and confirm it only displays the case. No new warning or notification should result.

The separate closed-DM live warning test remains pending. Browsing history does not substitute for that test.
