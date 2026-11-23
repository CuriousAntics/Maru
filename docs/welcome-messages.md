# Welcome messages

Open **Welcome messages** in the staff website navigation. Admins and Mods with full access can edit:

- On/Off (defaults Off).
- The server channel that receives welcome messages.
- The information channel linked in the message. It can be different from the posting channel, and does not require Send Messages permission.
- The message text, up to 1,000 characters before substitution and 2,000 afterward.

The default message is:

```text
Welcome to {server_name} {member}! Introduce yourself and check out {channel} for more information.
```

`{server_name}` is the current server name, `{member}` is the joining member's mention and `{channel}` is a clickable Discord channel mention for the selected information channel. Only these placeholders are supported; braces outside them produce a validation error. The text preview uses the staff member as an example and shows the channel name; it is not a Discord message and does not send anything. Save to update the preview. Errors preserve the entered message and channel selections. The existing dashboard scroll script applies to this page.

Welcomes are ordinary text messages in text or announcement channels. No DMs, images, goodbye messages or role changes are introduced. New human joins (including returning members) are eligible; bots are skipped. Members undergoing Discord membership screening are welcomed on joining, without waiting for screening completion. Staff should choose posting and information channels that new members can actually access. Maru validates its own channel visibility and ability to send; it cannot grant a newcomer access through a channel mention.

Only the joining member's user ID is allowed to notify. Typed `@everyone`, role mentions and other user mentions cannot ping others. Server names are inserted as literal escaped text rather than parsed again as template syntax. Channel choices are scoped to the configured server and refreshed at save/delivery. Missing channels remain visibly unavailable; they are not silently replaced. Ordinary Mods can view settings and recent delivery results but cannot save changes. Expired sessions, revoked access, cross-origin requests, forged proofs, duplicate parameters and stale settings are rejected.

## Installation and activation

Apply after PR #34 (form response deletion). This patch adds migration `024_welcome_messages.sql`; run the standard migration command before starting this version:

```powershell
npm run db:migrate
```

Use the existing Railway pre-deploy migration command for the hosted database. No new packages or slash commands are needed.

Welcomes use Discord's **Server Members Intent**. If `COMMUNITY_EVENTS_ENABLED=true` is already configured, Maru already requests that intent and this feature can use it. Otherwise:

1. Enable **Server Members Intent** for the appropriate Maru bot in the Discord Developer Portal before changing the Railway variable.
2. Set `WELCOME_EVENTS_ENABLED=true` on that bot's Railway service and redeploy. The example environment file defaults it to false. This flag enables only member events; it does not turn on Community activity tracking or role assignment.
3. Configure both channels and the text on the website while welcome messages remain Off.
4. Test in the private test server with a disposable human account. Then turn off Tatsu's welcome message before turning Maru welcomes On for the main-server handover, to avoid greetings from both bots.

Do not change the bot token or grant Administrator for this feature. The welcome channel needs View Channel and Send Messages; the information channel needs View Channel for Maru. Member-side channel visibility must be configured separately in Discord.

## Delivery and recovery

The worker accepts recent `GUILD_MEMBER_ADD` events for the configured server. Member lists and old joins are not backfilled. Events with invalid timestamps, more than two minutes old or over 30 seconds in the future are ignored. Intake is bounded at 1,000 joins and saved in batches through a serialized two-second worker; database failures retain buffered work for retry for up to ten minutes. A graceful shutdown drains buffered joins to the database. An abrupt crash before intake is saved may lose a greeting; there is no fabricated offline history. A fresh join timestamp is a separate visit, while replay of the same join uses one durable job.

Jobs snapshot the saved message/channels/revision. Changing the settings cancels pending jobs; unchanged saves do not cancel or postpone them. Joins observed while welcomes were Off are not greeted retroactively. Pending jobs older than ten minutes are cancelled. Before dispatch Maru verifies the current saved revision, member presence and exact current join timestamp, and refreshed channel permissions. A member who left or rejoined before delivery does not receive the old greeting. No goodbye is posted.

A durable send claim and audit event commit before Discord is contacted. The sender disables transport retries, uses a stable nonce, and never automatically resends uncertain outcomes. The dashboard shows the latest 30 recorded joins:

- Pending: waiting to process.
- Sending: request claimed and being checked/dispatched.
- Sent: Discord confirmed message creation; View message opens the post.
- Failed: Discord explicitly rejected the request.
- Unknown: delivery cannot be confirmed; inspect the channel, as the post may have arrived.
- Cancelled: the job's join/settings/channels were no longer eligible.

After an interrupted send, Sending becomes Unknown after two minutes. A failed outcome audit leaves the claim intact so restart cannot resend it. The audit records settings revisions, channel/member IDs and delivery outcomes without copying message bodies. Settings changes and audit writes are transactional. An already dispatched request may finish after welcomes are switched Off. Multiple independent deployments should not be used to increase delivery throughput; retain the project's single-replica configuration.

## Validation

Automated database/HTTP tests cover settings permissions, rollback, stale saves, channels, template validation, escaping, duplicate joins, separate rejoins, Off, expired work, departed/bot members, pre-send configuration changes, denied/lost sends, interrupted/outcome-audit recovery, preview behavior, worker shutdown and server isolation. Discord adapter tests verify the allowed mention list, stable nonce and member identity checks. Browser layout and actual Discord delivery still require live verification.

Private-server acceptance:

1. Load Welcome messages with the feature Off; set the posting and information channels separately, save, and check the text preview. Reopen and confirm settings remain.
2. Enable member events if needed, turn welcomes On, and join with a human test account. Confirm exactly one post has the server name, member mention and clickable information channel. Check Sent and View message on the website.
3. Change the message and information channel, then leave and rejoin. Confirm the new visit uses the edited values.
4. Turn welcomes Off and rejoin. Confirm no welcome. Check an ordinary Mod can view but cannot save settings.
5. With a temporary channel, test lost Send Messages permission and confirm no duplicate/repeated post. Restore permissions afterward.

References: [Guild Member Add](https://docs.discord.com/developers/events/gateway-events#guild-member-add), [Gateway intents](https://docs.discord.com/developers/events/gateway#privileged-intents), [Create Message / allowed mentions](https://docs.discord.com/developers/resources/message#create-message).
