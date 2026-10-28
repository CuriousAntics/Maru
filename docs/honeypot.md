# Honeypot softban protection

This implementation adds `/honeypot` to the staff dashboard (a web page, not a new slash command). Protection defaults **Off**. Admins and Mods with full access can save settings; ordinary Mods can view settings and results. Settings require a reason, current roles, an unexpired session, a purpose-specific CSRF proof, and the current revision. Saves and audit records commit together.

## Behavior

- Choose up to 20 existing, normal text channels as traps. Threads and announcement channels do not trigger this release.
- Every newly observed human message in a selected channel can trigger, including an image-only post or reply. Edits, historical backfills, bot messages, webhooks and application responses do not trigger. A compromised human account is still eligible.
- A softban requests deletion of **86,400 seconds (24 hours)** of message history with Discord's ban operation, then immediately attempts to remove that same ban. This request applies to the member's recent server message history, not only the trap channel. Discord controls actual deletion; Maru does not scan the server to verify every message was deleted.
- Unbanning allows the member to return using an existing valid invite; it does not rejoin them automatically. Deleted messages cannot be restored.
- No DM, reinvite, appeal flow, role quarantine or preliminary timeout is sent/applied.
- Staff with current configured roles, bots, the server owner, and native Administrators are always protected. Additional exempt roles are configurable on this page. These settings are independent of AutoMod's shared exemptions and ignored channels.
- Maru needs Ban Members and a role above eligible targets. A normal moderation log destination must be saved outside every trap channel. Logs have mentions disabled and omit source message content.
- Keep the existing visible warning embed in every trap channel. Enabling requires explicit confirmation that staff checked those warnings. This version does not create, edit, pin, or remove warning embeds.

## Durable actions and recovery

New actions use the existing guild case sequence with action `softban`, origin `automod`, actor Maru's bot ID, and DM skipped. Cases are read only; the Honeypot page shows separate ban/unban statuses. Applied means both the ban and its removal were confirmed. A failed or uncertain unban produces an unconfirmed softban, not a successful result.

Each event has a random, unique ban reason. Existing bans are never overwritten. The current reason must match this event before Maru attempts an unban; a staff replacement ban is left for review. The adapter checks this again immediately before DELETE. Discord does not offer an atomic conditional unban, so staff should avoid issuing competing moderation actions during the brief softban sequence.

Ban and unban intentions are durably claimed and audited before dispatch. The same per-member advisory lock used by manual moderation prevents overlap within Maru; a separate per-guild worker lock prevents concurrent trap workers. Native mutation retries are disabled. No ban PUT is blindly replayed after a lost response or restart. A matching owned ban can be reconciled and removed after a restart. Once an unban attempt has been claimed, an ambiguous remaining ban requires staff review instead of automatically repeating DELETE.

An absent ban after a claimed unban confirms ban removal. If an interrupted ban attempt has no matching ban, its execution remains unconfirmed. Check Discord's ban list and audit log before intervening. Use `/unban` with a reason when staff determine removal is appropriate.

Disabling, changing the trap configuration, or changing exemptions cancels unclaimed events from the previous revision. This does **not** strand a ban already started: recovery still attempts to remove Maru's owned ban. Fresh events are accepted only within two minutes of their original timestamp and after the current settings were saved; unclaimed work older than ten minutes is skipped. Queued messages sent before an earlier softban attempt are skipped, so a quick rejoin does not replay the old burst against the returning member. A genuinely new trap post may trigger again. No offline history scan is performed. In-memory intake is bounded at 5,000 events; saved work survives restart. Discord/database lookup failures retain work for a later check.

Logs are claimed once through the existing notification mechanism. A lost log response or failed result audit does not resend automatically. The dashboard retains IDs, status notes and historical results, including skipped events; it does not persist source message content or uploaded files. Skipped protected/exempt events do not allocate a case or send a moderation log. Eligible targets with permission or hierarchy failures receive a rejected case and an attempted log.

## Deployment

1. Apply the patch and let automated CI checks complete.
2. Run `npm run db:migrate` to apply `014_honeypot.sql`; deployed migrations also run in Railway's existing pre-deploy step.
3. Merge/deploy the branch. No new package, environment variable, Discord intent, or slash-command registration is required.
4. Keep Honeypot **Off** until the deferred live checks. Keep the current Honeypot bot active until the eventual handover; do not enable both bots on the same trap channel during cutover.

This is the core trap-channel replacement. The original bot's optional forwarding, reinvite, channel warming/renaming/recreation, preliminary timeout, automatic warning maintenance, and follow-up deletion sweep are not implemented here. The unreadable earlier experiment screenshots have not been treated as confirmed settings.

## Deferred live checklist

All tester-dependent checks remain deferred until first-release implementation is complete. Automated checks run against an isolated PostgreSQL-compatible database and fake Discord responses, without contacting Discord or Railway.

- Honeypot: save/reload as Admin, view as ordinary Mod, select the actual trap/log channels and additional exemptions, verify warnings.
- With an authorized test member later, verify the 24-hour deletion request, member removal, immediate unban, separate dashboard outcomes, one case/log, and no DM. Check affected history only with disposable messages.
- Verify staff/owner/Administrator/bot/extra-role protections, missing Ban Members and low role position, duplicates, and controlled restart recovery.
- Repeated-message rule: timeout escalation and exemptions remain pending; text and exact-image detection were already confirmed.
- Discord invites: own/approved servers, blocked destinations, unknown-invite review, edits, exemptions, timeout escalation, and independent saves remain pending.
- Manual timeout/untimeout command checks paused earlier remain pending unless separately verified. Existing successful warning, ban/unban, Starboard, blocked-word, and rapid-message checks remain valid.

References: [Honeypot behavior](https://honeypot.riskymh.dev/docs/how-it-works), [Honeypot configuration](https://honeypot.riskymh.dev/docs/configuration), [Discord guild ban API](https://docs.discord.com/developers/resources/guild#create-guild-ban).
