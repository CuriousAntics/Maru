# Blocked-word AutoMod

Open **AutoMod** in the staff dashboard. Configured Admins and Mods with full Maru access can change settings; ordinary Mods may view settings and recent violations. Filtering defaults to Off. No production bot or existing rule is replaced by deployment alone: this starter remains limited to DISCORD_TEST_GUILD_ID.

## Configure before enabling

1. Give Maru Test **Manage Messages** and **Moderate Members** in Discord. Its role must be above eligible members for timeouts. It needs View Channel and Read Message History in message channels. Channel overrides still apply; Administrator is not required.
2. Keep the existing moderation log destination configured in Server settings. Enabling requires one. The log channel also needs Send Messages and Embed Links.
3. Enter blocked words/phrases, separated by commas (new lines also work), up to 100 unique entries of 1–100 characters. Entries are literals, not regular expressions. For testing use a harmless invented token such as marutestword.
4. Review global exemptions. Initial suggestions include configured Maru Admin/Mods roles and server roles named Owner or Community Manager. Select the intended four roles and your six ignored channels explicitly; their production IDs cannot be inferred or imported from previous bot screenshots. Global ignored lists start empty.
5. Optional per-rule exceptions override the matching global role or channel exemption. The selection must also be in that global list. A role exception does not bypass an ignored channel; a channel exception does not bypass an exempt role. Thread-parent channel selections apply to threads. Bots, webhook messages and the actual server owner are always ignored.
6. Choose the timeout duration, initially **10m**, editable from 1s to 28d. Save with a reason. Rule settings, complete previous/new values and actor are audited atomically. Stale forms cannot overwrite a later edit. Revoked sessions or lost Admin access block a save.

An authorized Admin can switch the rule Off while retaining now-unavailable channel/role selections, then repair them. Disabling stops further rule actions; it does not undo already-applied timeouts or restore removed messages. Saving alone does not scan old messages.

Message Content Intent was already enabled for Starboard and remains required. This increment adds no gateway intents, secrets, dependencies or slash commands. Apply **010_blocked_words.sql** with the existing migration command, then deploy normally.

## Matching and actions

The custom bot checks new guild messages and content edits after they are posted. It uses case-insensitive whole-word and phrase matching with Unicode letter/number/mark/underscore boundaries. It normalizes compatibility forms, repeated whitespace and common zero-width separators. A blocked word does not match inside a longer word; a phrase may match across whitespace/newlines. It checks message text, not OCR, attachment contents or embedded webpage text.

The fresh source message and current member roles are read before action. Messages edited to remove the match before processing are not removed. Missing or changed permissions defer work rather than assuming the member is not exempt. A member who has left may still have a blocked message removed, but cannot receive a native timeout.

A confirmed violation is unique per server, blocked-word rule and message ID. Repeated gateway events and later edits do not generate additional counts for that same message. Successfully removed violations count within a rolling ten-minute window, separately per member and rule. Old queued messages retain their event time and do not inflate a current window merely because processing was delayed.

After five violations in that window, Maru attempts the configured native timeout. It creates a normal numbered Timeout case with **Origin: Automatic moderation**, the Maru bot as actor, and the recorded action outcome. Cases share the existing per-server sequence. Native timeouts require current bot permission and role hierarchy; owners, bots and native Administrator accounts are not timed out. Roles/exemptions are rechecked before escalation. An already-active timeout is not replaced or shortened.

Only a confirmed Applied timeout resets this rule's counter for that member. Rejected or uncertain actions do not reset it. Unsuccessful/protected-target attempts have a one-minute cooldown to avoid repeated native calls. A successful timeout clears that failure cooldown, so five new violations after a moderator removes the timeout can trigger a new action.

## Logs and history

Routine violations send one embed to the saved log channel, with mentions disabled and no Mod ping. It includes member/channel/message IDs, configured matched entries, removal result, count at processing time, and timeout result/case where relevant. The full source message is not copied. Automatic moderation sends no member DM. Manual moderation commands retain their existing notification behavior.

Recent violations appear on AutoMod. The existing case history and /case show automatic timeouts with their origin, action result and separate log status. Logs are historical snapshots; later reconciliation may update database/case state without rewriting a previously sent embed. A log failure does not undo a deletion or confirmed timeout. Missing log configuration after enabling is recorded as not configured.

## Persistence and recovery

A short bounded in-memory intake batches gateway content checks against current settings. Only matching candidate IDs and event times enter the persistent job queue; source text is not stored in jobs. Intake and moderation work run independently so a slow native request does not block saving new candidates. Normal shutdown flushes intake before closing PostgreSQL. The connection pool allows up to five connections so the independent automation workers leave room for staff requests. A crash, unavailable database or a full 5,000-message intake can lose events that were not yet saved; another content edit can enqueue that message again. There is no historical channel scan.

The worker serializes automatic work and settings writes with a server advisory lock. It also shares the native per-member lock with manual timeout/ban actions. Intent/audit writes commit before external actions. Repeated deletions are idempotent and a lost delete response is checked against the current message on retry. Native requests and log sends use bounded requests with transport/server-error retries disabled.

A native timeout is claimed before dispatch. After response loss, it is never blindly reapplied: a later processing check may confirm the exact requested end from current Discord state. A pending uncertain timeout otherwise blocks additional automatic requests until its intended end has elapsed; staff can inspect /case and act manually. The old case retains its historical uncertainty if no verification is possible. Result and counter reset commit together, so an audit failure cannot reset a counter without a confirmed case result.

A claimed log is not automatically resent after response loss or an interrupted result write. Logs/cases can show Not confirmed or an attempt in progress. Provider errors, tokens, raw message contents and OAuth information are never printed or copied into audit events. Safe failures appear in the host log and the AutoMod pending-work indicator.

## Verification

Run the repository's TypeScript checks, build and full test suite including test/automod.test.ts. Automated tests use isolated PostgreSQL and fake Discord actions. They do not delete live messages or apply live timeouts.

For a live development test, select a willing ordinary test member, keep staff roles exempt, add marutestword and set a short test timeout such as 1m. Enable the rule. A message containing MARUTESTWORD should be removed and logged. A longer word such as marutestwordy should remain. Five distinct matching messages from the same test member within ten minutes should create one Applied timeout case and reset their blocked-word counter. Use /untimeout if ending the test early, then restore the intended timeout duration (10m default) and list. Verify an exempt role or ignored channel remains unaffected before any production use.
