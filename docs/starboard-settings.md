# Starboard settings

Open **Starboard** in Maru's staff dashboard. Configured Admins and ordinary Mods may create and edit boards. Current Discord membership and configured staff roles are checked for every request and again inside the save transaction. Native Administrator permission alone does not grant dashboard access.

Reaction processing is now available for boards explicitly switched On. New boards and existing previously saved boards default to Off. See [starboard-reactions.md](starboard-reactions.md) for the worker, intent setup and live tests. Existing Dyno Starboard messages remain untouched; do not remove production bots before their replacements and migration have been verified.

## Board options

- Name: 1–60 characters, unique within the server ignoring case and surrounding spaces.
- Destination: a text or announcement channel where Maru has View Channel, Read Message History, Send Messages and Embed Links.
- Reaction: one Unicode emoji, including supported multi-codepoint sequences, or a usable custom emoji from this server. Paste the emoji itself, its custom Discord syntax, or a custom emoji ID. The form suggests usable server emoji. Custom emoji are stored by stable ID; Unicode reaction keys ignore presentation-selector differences.
- Threshold: 1–1000 reactions; the form starts at 3 and staff can choose another value.
- Eligible channels: explicitly select 1–100 text or announcement channels that Maru can view and read. A board's destination cannot also be a source for that same board. Voice channels, forums and threads are outside this increment.
- Cross-posting: configured independently per board, default off. A message may appear on multiple boards only when all participating boards allow sharing. Earlier-created boards take priority when this conflicts with another board.
- Reaction posting: Off by default; switching On starts handling reactions. Switching Off removes this board’s Maru-managed highlights.
- Reason: 1–500 characters for every create or edit.

Up to 25 boards may be configured per server in this increment. Multiple boards may share a destination and have different emoji, thresholds or source selections. Deletion is available with a confirmation and optional highlight cleanup; see [starboard-deletion.md](starboard-deletion.md).

Reaction behavior retains the agreed rules: author self-reactions do not count; posts are removed if the reaction threshold is lost or the source is deleted; a qualifying message can be reposted after removal.

## Saves, audit and safety

The server ID and staff actor come from the signed-in dashboard, never posted fields. Same-origin POSTs and session-bound CSRF proofs are required. Proofs are bound to board ID, revision and create/edit action. Request bodies and channel counts are bounded; unexpected or duplicate scalar fields are rejected.

Board updates and their STARBOARD_CREATED/STARBOARD_UPDATED audit events commit together. Audits include the actor, reason, board ID, revision, and complete previous/new configuration. Other server settings and moderation cases remain unchanged. Each new-board form has a stable ID, so submitting the same form twice does not create a second board or audit. A no-op edit also creates no audit entry. Successful writes redirect to the saved board, so refreshing does not repeat the POST.

A shared server row lock coordinates writes with staff access and other settings changes. A stale board revision is rejected rather than overwriting another staff member's edit. A failed audit write rolls back the configuration. Server boundaries are checked on reads and writes. Lookups that fail do not save guessed channel or emoji state.

The form preserves missing saved selections and labels them unavailable. Restore access or intentionally replace/remove those selections before saving. Fresh resources are fetched during each save, so deleted channels, unusable custom emoji and permission changes are rejected. Source readability is checked independently of destination send permissions.

## Setup

Apply 007_starboard_settings.sql with the existing migration command. Railway's pre-deploy migration command applies the same file. Do not edit applied migrations. This is an additive table migration; the prior bot can keep running during deployment.

No new dependencies, secrets, Railway variables, or slash commands are required. Reaction handling requires Message Content Intent enabled in the Discord Developer Portal before deployment; see the reaction guide. The existing Discord login continues to request only identify; channel/emoji lookups use Maru's bot connection.

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts test/dashboard.test.ts test/warnings.test.ts test/timeouts.test.ts test/bans.test.ts test/starboard-settings.test.ts test/starboard-reactions.test.ts
```

Tests use isolated PostgreSQL and fake Discord resources. They do not create, delete or edit live Discord messages. Coverage includes ordinary Mod access, current-session reauthorization, stale edits, duplicate submits, bounded settings, channel permissions, custom and Unicode emoji, cross-server isolation, atomic audit rollback, no-op edits, persisted configuration, protected forms and output escaping.

After deployment, create a test board in Maru Development, refresh to confirm its saved settings, edit its threshold, and inspect Recent staff activity. Verify ordinary Mods can configure boards, while nonstaff cannot sign in. Turn posting On and follow the reaction guide to verify live behavior.
