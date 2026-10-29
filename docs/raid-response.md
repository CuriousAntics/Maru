# Manual raid response

**Raid response** is a manually operated staff tool, Off by default. It does not detect raids, quarantine newcomers, or automatically decide who is malicious. It supports the agreed protocol: review a join window, revoke selected designated invites, then ban selected current members. A recent legitimate promotion burst is not treated as proof of a raid.

## Configuration and permissions

Admins and Mods granted full Maru access can configure availability and up to 20 designated ordinary invite codes. Paste codes or HTTPS `discord.gg` / `discord.com/invite` links, separated by commas or lines. Only those codes can enter a preview. Vanity URLs, discovery, other ordinary invites, and invites created after the preview are not disabled.

Configured Mods or Admins can prepare and confirm their own previews when they and Maru have native **Ban Members**. Per-invite revocation also needs native **Manage Channels** on that invite's channel or **Manage Server**, for both the actor and Maru. Full Maru access does not replace Discord permissions. The actor's and Maru's role hierarchy must allow each ban.

Member listing uses the existing `COMMUNITY_EVENTS_ENABLED` setup: enable Server Members Intent for Maru Test in Discord before setting the Railway flag true and redeploying. Keep it false/unset and this tool Off while live tests remain deferred. This patch needs no additional package, environment variable or slash-command registration. Apply `016_raid_response.sql` using the existing migration workflow.

Save a moderation log channel before preparing a preview. The saved log destination is rechecked before allocating each ban case.

## Preview and confirmation

1. Choose **Last X minutes** (1–10080 minutes), or an **exact start/end** in ISO8601 with UTC `Z` or an explicit offset. The interval cannot exceed seven days or end in the future. Bounds are inclusive. Recent windows freeze their absolute end when requested, not when execution eventually starts.
2. Keep Community protection On (the default), or explicitly choose to include otherwise eligible Community members for that one preview. Choose the requested ban-history deletion window: default **24h**, `0` keeps history, and the maximum is `7d`. This is server-wide recent message history for each banned member, not just a particular channel. Deletion cannot be undone.
3. Build the preview. Member enumeration runs in the background in pages of up to 1,000. No invite deletion, ban, DM or moderation case is dispatched during this phase. A full scan must finish before confirmation is available. Refresh the saved status page to see progress.
4. Review every matching member and exclusion. Uncheck members or invites that should not be actioned. A preview supports at most **500 current members in its join window**, including exclusions, and scans at most 100,000 server members. An oversized or invalid scan fails without authorizing a partial list; narrow the window.
5. Choose **Review selected actions**. This second page shows the exact selected invite codes, member names/IDs, frozen join window, Community policy, reason and requested history deletion. Its final CSRF proof is bound to the selected IDs/codes.
6. Type the exact `BAN N REVOKE M` phrase and choose **Execute reviewed response**. Only the preview creator can confirm, within 15 minutes of creation. One response can execute at a time. Unselected rows and later joins cannot be added to that confirmed response.

A preview is a paginated observation of current membership, not an atomic Discord-wide snapshot. Members who have already left are not enumerated. A person who leaves/rejoins or whose protection changes after the preview is rechecked before any ban. Usernames are display aids; Discord IDs and the saved membership join timestamp identify the target. A changed join timestamp causes a skip.

## Default exclusions

The preview shows eligible members and exclusions side by side. Execution rechecks these protections against fresh Discord and database state:

- Actor, Maru, bots, server owner and native Administrators are always protected.
- Configured Maru staff roles, native moderation/server-management permissions, and AutoMod's globally protected roles are always protected. These checks also cover configured Owner/Community Manager exemptions. Staff/bot protection cannot be overridden through a selection form.
- Targets at or above either the actor's or Maru's role hierarchy are excluded.
- With default Community protection On, members currently holding the selected Community role or recorded as permanently earned in `community_members` are excluded, including returning members whose role has not yet been restored.

**Community history preservation must be completed before relying on it.** Capture current holders and resolve the pending StatBot migration described in [community-roles.md](community-roles.md). Maru cannot infer a former Community holder who left before any role/progress import or observation. The dashboard states that Community protection is based on current roles and recorded awards; unknown history is not invented.

## Execution, partial outcomes and stopping

Selected designated invites run **before** any ban. Each is resolved to this server and its previewed channel, its permissions are rechecked, and a durable intention/audit is committed before DELETE. An already absent invite is reported as absent. A foreign, vanity, changed, unauthorized or unconfirmed invite stops execution before bans begin. Revoking designated links does not close all ways to join the server.

Each selected target is checked for current membership, the same join timestamp, staff/bot/Community protection, hierarchy, an existing ban, and fresh actor permission/session access. Departed or newly protected members are skipped without a ban case. Existing bans are not overwritten and their history-deletion request is not repeated.

An eligible ban gets a normal shared-sequence moderation case with origin **Manual raid response**, the staff actor/reason, requested deletion duration, and **DM skipped**. Raid response sends no pre-ban DM. Case pages and `/case` label this accurately. Cases remain read only. Each final ban result is logged once to the saved moderation destination, with mentions disabled. Invite actions, preview/confirmation, skips, stops and completion are recorded in dashboard staff activity and link to the response.

Ban and invite mutations have retries disabled and are claimed before dispatch. A restart or lost response never blindly repeats them. Invite absence can reconcile a claimed deletion. A claimed ban can be confirmed by its exact per-run/per-case reason; a different ban reason or absent ban remains unconfirmed, and no replacement PUT is sent. Failed/uncertain native actions stop remaining work for review. Final case/log status is independent: a failed log does not undo or repeat a ban, and an uncertain log is not automatically resent.

Native actions are not a transaction across Discord and PostgreSQL. Already claimed/dispatched actions can finish after Stop is clicked; completed bans, invite revocations and message deletions are not rolled back. A rejected or unconfirmed result can leave the response partially applied. Inspect the ban list and Discord audit log before using `/unban`; unbanning cannot restore messages or make someone rejoin.

The creator or an Admin can use **Stop response** to stop remaining work. Changing raid settings, turning the tool Off, loss of current staff/native ban permissions, logout/session expiry, or the 30-minute execution deadline also halts work. After a halt, prepare and review a fresh preview rather than silently resuming an old authority or selection. A case whose claim was interrupted before its outcome could be saved may remain Not confirmed (attempt started), particularly if access was revoked before recovery; inspect Discord before intervening.

Work, pagination cursors, selections and outcomes survive process restart. Per-guild worker and shared per-member advisory locks prevent concurrent Maru dispatch for the same target. Audit failure before a claim prevents dispatch. Transient lookup/database errors retain work and recheck current access before continuing; user input, tokens and raw provider diagnostics are not printed. Saved names, IDs and moderation results are private staff history; source message content and attachment data are not copied.

## Deferred live acceptance

All tester-dependent checks remain deferred until first-release implementation is complete. Automated tests use fake Discord responses and an isolated PostgreSQL-compatible database.

Later, in the private test server, validate both window modes, visible exclusions (including returning Community), deselection/review/count confirmation, designated disposable invites, a consenting disposable member, partial failures, authority loss, stopping, and controlled restart recovery. Use only disposable message history when checking deletion. Never use the real community as a raid test.

Keep the pending Community preservation/import and earlier repeated-message, Discord-invite, Honeypot and manual timeout checks in the shared acceptance backlog. Do not enable live protections or remove the existing bots as part of applying this patch.

References: [Discord invite deletion permissions and response](https://docs.discord.com/developers/resources/invite#delete-invite), [member pagination and privileged intent](https://docs.discord.com/developers/resources/guild#list-guild-members), [native ban API](https://docs.discord.com/developers/resources/guild#create-guild-ban).
