# Starboard reaction handling

Maru now watches reaction changes on enabled boards. Existing saved boards remain Off until staff switch **Reaction posting** to **On** and save with a reason. No Discord messages are imported or altered just by deploying this increment.

## Before deployment

In the Discord Developer Portal, open **Maru Test → Bot → Privileged Gateway Intents** and enable **Message Content Intent**, then save. Enable this before deploying the code: the client now requests GuildMessages, GuildMessageReactions and MessageContent in addition to Guilds. Discord rejects login if a requested privileged intent has not been enabled/approved. Server Members and Presence intents are not requested by this increment.

Message Content is needed to copy original message content and attachments. Reference: https://docs.discord.com/developers/events/gateway#message-content-intent

Apply 008_starboard_reactions.sql using the existing migration command. Railway's pre-deploy command applies the same file. No new packages, secrets, Railway variables or slash commands are needed. Do not edit migrations 001–007. The additive migration preserves the old settings and moderation code during rollout.

The bot needs View Channel and Read Message History in source channels. Destination channels also need Send Messages and Embed Links. No Administrator, Manage Messages, or Add Reactions permission is required for this feature: Maru reads member reactions and manages only its own messages. Use text or announcement channels; threads/forums remain outside this increment. Age-restricted sources cannot be reposted into destinations without age restriction.

## Rules

- Only reactions on the original message count, with the board's configured emoji and source eligibility.
- Fetch fresh voter lists, excluding the message author and bots. Count each other human account once, even if it supplied both a normal and super reaction. Paginate rather than trusting a partial reaction cache.
- Post at **greater than or equal to** the configured threshold. Additional votes update the existing highlight instead of posting another copy.
- Remove the managed highlight below the threshold or when the source is deleted, including bulk deletion. Requalification creates a new generation/highlight.
- Source edits refresh the copied text and attachments. Spoiler attachments are not exposed as an image or attachment link. Very long content is truncated, with a jump link to the original.
- All participating boards must allow cross-posting to share a source message. Boards are considered in stable creation order (then ID); earlier boards take priority over conflicting later boards. Removing an exclusive winner allows another currently qualifying board to post.
- Maru-authored messages are never used as sources, preventing recursive boards. Other bots' existing Starboard posts are not imported or managed.
- Turning posting Off removes that board's managed highlights. A destination/source/emoji/threshold change rechecks already observed messages. Sources no longer eligible are removed. A destination move confirms removal of the old copy before creating a replacement.

A moderator deleting only the managed copy does not disqualify the source. If it still qualifies, Maru will recreate the missing copy. Remove the original, remove the qualifying reactions, or turn the board Off when the highlight should stay absent.

## Durable processing and uncertainty

Raw gateway events are used so uncached reactions and deletes can be saved without fetching through discord.js's message cache. Events are validated and scoped to the configured development server. They coalesce into PostgreSQL work rows with versions; a new event during processing leaves another check pending. Multiple bot instances serialize native Starboard work using a server advisory lock. Settings writes use the same lock so a board cannot be changed midway through a message's reconciliation. A busy settings form asks staff to reload and retry.

The worker normally polls every two seconds and processes up to five source checks per pass. Failed checks back off up to five minutes. Every minute it schedules up to 25 tracked sources whose last check is older than ten minutes, allowing missed changes/deletes and restart recovery to catch up. This is a bounded sweep, not a guarantee that every source is checked every ten minutes under load. It never scans old source-channel history or discovers untracked messages that received reactions while the bot was offline. Add/remove a matching reaction after enabling a board to start tracking an existing message.

A create intent and its audit record commit before each Discord POST. Requests use a stable generation marker and nonce, disable transport/server-error retries, and have bounded deadlines. A lost/invalid response leaves the entry Creating. The worker searches recent destination history for that bot-owned marker and recovers the existing message ID; it does not issue a second POST for an uncertain generation. History searches are bounded to 2,000 messages and the attempt's timestamp. If no copy can be found, work remains pending for review. The dashboard shows a delivery-review notice. This conservative behavior avoids silent duplicates; an uncertain source can hold up other boards competing for that same source. Check the destination and Railway logs before any maintenance or manual retry.

Only an explicit Discord rejection or a confirmed missing/deleted prior copy permits a fresh create generation. Message edits and deletes target the persisted message ID, with bot ownership and marker checks; repeating an uncertain edit/delete cannot create another highlight. A deleted destination is handled as a missing managed copy. Permission failures are not treated as source deletion.

Lifecycle transitions have server-scoped audit events. No copied source text, voter lists, provider errors, or tokens are written to audit records. Status and audit transitions commit together. Job/post rows store IDs, state, hashes, markers, counters, and safe error codes. The public dashboard does not expose them; staff pages remain protected by the existing login, fresh role checks, same-origin and purpose-bound CSRF rules.

Existing moderation behavior and records remain unchanged. Natural Discord rate limiting and heavy voting can delay a check; the queue survives restarts. If PostgreSQL is down before an event can be saved, already observed sources are revisited by the sweep, while untracked sources need another reaction event after recovery.

## Verification

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts test/dashboard.test.ts test/warnings.test.ts test/timeouts.test.ts test/bans.test.ts test/starboard-settings.test.ts test/starboard-reactions.test.ts
```

Automated tests use isolated PostgreSQL and fake Discord requests. They do not post/delete any live messages. They cover threshold crossings, self/bot vote exclusion, normal/super deduplication, voter pagination, Unicode/custom emoji identities, updates, bulk/uncached events, tombstones, cross-post rules, pause/move behavior, response loss, persisted claims, audit rollback, recovery markers, no duplicate creates, adapter response validation, settings authorization and durable event versions.

Live test in **Maru Development** after deployment:

1. Edit Test highlights: choose one source text channel, a different destination, ⭐, threshold **1**, and posting **On**. Save with a reason.
2. Have the test member write a new message in the source. Their own ⭐ must not post it.
3. Add ⭐ from a different human account: exactly one highlight should appear, including the original link and a count of 1.
4. Remove that other account's ⭐: the highlight should disappear. Add it again: one new highlight should appear.
5. Delete the original message: its managed copy should disappear.
6. For a multiple-board test, allow cross-posting on both boards and check each destination. Turn one board Off and verify only its copies are removed.

Use the dashboard's posting state to confirm On before testing. Existing boards default to Off deliberately; the worker does not automatically activate previously saved settings.
