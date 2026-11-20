# Reuse custom responses inside ordinary messages

Migration `020_inline_command_triggers.sql` adds an **Also respond to /trigger in ordinary messages** switch to each entry on the existing Custom commands page. Existing and new entries default to this option **Off**. Availability must also be On; native slash commands continue working independently of this extra switch. Admins/full-access Mods manage the option using the same session, current-role, CSRF, revision and audit checks as command editing. Ordinary Mods can view it.

## Matching and replies

- A new human message containing a complete `/name` anywhere can invoke the saved custom response, for example `That was /magic!`. Matching ignores capitalization. A bare `magic` does not match; `/magical`, `/magic-extra`, `/magic_word` and Unicode letter/number continuations do not partially match `/magic`.
- Trigger names use the existing custom-command name restrictions. Surrounding punctuation and line breaks are accepted. Slashes attached to a preceding word, URL/path separator, colon, dot or hyphen are not treated as command starts. HTTP(S) and www URL spans are excluded, including URL queries. Text in quotes or code is otherwise ordinary text and can contain a trigger.
- Only MESSAGE_CREATE events in the configured guild qualify, including ordinary message replies. Bots, webhooks, DMs, other guilds, system/application-command messages, edits, stale/future events and invalid IDs are ignored. Content is bounded to 8,000 characters and at most 20 distinct candidate trigger names are examined.
- If several enabled in-message triggers occur, select the first in source order and send at most one response for that message. Repeated occurrences and duplicate Gateway events cannot create more replies. There is a five-second cooldown per member across these autoresponses and channels; no roles bypass it. Native slash commands are unaffected by this cooldown.
- The response is read from the same Custom commands entry, without a second response field. Text, emojis and media links work as before. No scripts, template expressions or remote media downloads are added. Mentions, including reply pings, are disabled.
- The original message stays. Maru sends a normal public Discord reply referencing it. If the source has disappeared, Discord must reject the reply rather than turn it into an unrelated channel post. No delete or moderation API is used by this feature.
- Channel access comes from Discord permissions, independent of AutoMod exemptions. Maru requires View Channel, Read Message History and Send Messages, or Send Messages in Threads where applicable. Source guild, channel, member, bot/webhook state and current trigger content are fetched again before responding.

## Saved work and failure handling

Only matching creates for entries already enabled when the event occurred enter the queue. Saved jobs store message/channel/member IDs, command name, revision, timestamps, status and optional response ID, never source text or copied response content. The dashboard shows the latest 20 job outcomes and original-message links. Finished metadata and inactive cooldown entries are removed after one day by hourly cleanup.

Settings changes invalidate queued older revisions. Both availability and the in-message switch are checked again immediately before sending. A response already claimed and dispatched can finish after a switch is turned Off. If a source is edited before processing, the originally selected trigger must still be present; edits do not create a new job or choose a replacement response.

A database transaction records the unique message claim and cooldown before any external reply. Uncertain sends and interrupted claims are not automatically replayed. A deterministic Discord nonce is an additional duplicate guard. Claimed work interrupted during restart becomes unconfirmed after one minute. PostgreSQL/permission/Discord failures cannot grant permission to send twice. At most 2,000 transient events are held during database outages; intake and worker batches are bounded. An orderly shutdown attempts to persist pending metadata; abrupt process loss can lose events not yet persisted. Creates older than one minute are skipped instead of sending a late burst of responses.

## Validation and deployment

Automated checks apply all migrations in isolated PostgreSQL-compatible storage and use fake Discord calls. They cover matching boundaries/case/URLs, bot/webhook/guild isolation, defaults, duplicate events, revisions/Off, source changes/deletion, member cooldowns, failed claims, lost sends/outcome writes, HTTP permissions and reply/no-ping payloads. Existing custom slash-command tests run alongside them. No live messages are sent by tests.

Apply migration 020 before starting this build. No new packages, environment variables, command-registration commands or Gateway intents are required: the existing GuildMessages and MessageContent intents provide message creates. If Message Content is unavailable, ordinary-message matching cannot work.

Private development acceptance: edit `/magic` with a test response, turn Availability and the in-message switch On, then post an ordinary sentence containing `/magic!` without selecting a slash-command interaction. Check one public reply and retention of the source. Verify no reply for bare or partial words, bots, quick repeats or the switch Off; check the same response still works through native `/magic`. Keep production Dyno settings unchanged and return the test entry to Off. Expired-invite testing remains deferred at the user's request.
