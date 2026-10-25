# Server settings

Open `/settings` from the overview to configure the moderation log destination for the existing configured test server. No new environment variables, packages, or database migration are required. Existing `guild_settings.settings` JSON stores `moderation_log_channel_id` as a Discord channel ID or JSON null when cleared.

This increment saves configuration only. It does not send Discord log messages yet, move existing logs, or change Dyno/Honeypot behavior.

## Access and validation

- Configured Admins and Mods with an effective full-access grant can save. Ordinary Mods can view settings.
- Current Discord membership and database access are checked on each request and checked again inside the save transaction. The existing per-server settings lock also serializes grant mutations with settings saves.
- Only text and announcement channels in the configured server are offered. Maru refreshes server roles, its own membership, and channel overwrites, then checks View Channel, Send Messages, and Embed Links. The selected channel and permissions are checked again during a save. Permission changes after saving can still prevent later log delivery.
- Unavailable channels remain visible as unavailable; they are never silently replaced. Choose another channel or explicitly choose Not configured to clear the destination.
- A reason of 1–500 characters is required. A same-origin form POST and a session-bound, purpose-specific CSRF proof are required. Bodies are bounded and duplicate or unexpected fields are rejected.
- The form carries its previous destination. A conflicting later change produces HTTP 409 rather than overwriting another staff member's edit. Reload before retrying.
- Settings and `SERVER_SETTINGS_CHANGED` audit events commit together. An audit failure rolls back the setting. Other JSON settings and other servers are preserved. No-op saves add no audit record.
- Each change records the actual actor, reason, previous channel ID, and new channel ID. The overview displays both channel IDs. Audit timestamps use UTC.

## Verification

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts test/dashboard.test.ts
```

The isolated HTTP/PostgreSQL tests cover settings persistence, role/grant revocation, stale forms, CSRF, channel rejection, clearing, no-op saves, audit rollback, escaped channel names, and cross-server isolation. Discord responses are simulated; live channel-permission checks still require deployment verification.

After merging and deploying:

1. Sign in as an Admin and open Server settings.
2. Choose a test-server text channel Maru can access, enter a reason, and save.
3. Reload and confirm the selected destination persists. Check the overview's audit entry for the reason and previous/new channel IDs.
4. Sign in as an ordinary Mod: view settings but confirm no save form is available. A Mod with full access should have a save form.
5. For a temporary channel, deny Maru Send Messages or Embed Links, reload settings, and confirm it cannot be selected. Restore the permission afterward.
6. Optional stale-form check: open two tabs, save a different destination in one, then save the older form in the other. The old form should require a reload.

Unexpected save errors can occur after a commit, for example if the browser disconnects. Reload the settings page and review the audit entry before retrying.
