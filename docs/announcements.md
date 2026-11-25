# Announcements and scheduled posts — Discord foundation

This increment adds the **Announcements** website page. It is the first of the agreed stages: Discord announcements and message editing, automatic Twitch/YouTube/social notifications, then social publishing. This patch implements the Discord stage only. It does not yet connect to social accounts or automatically announce new streams/uploads.

The remaining connected stages must support staff-configured accounts only. Publishing targets are X, Bluesky, LinkedIn personal profiles and Instagram professional (Creator/Business) accounts, with adapters for additional platforms later. Facebook is a future optional destination rather than a current required account. Scheduling must stay international: never impose a server-wide America/Denver timezone.

## Compose and send

Admins and Mods with full access can create drafts, send immediately, or activate a schedule. Ordinary Mods can view saved posts and delivery results. Current session and role/grant checks run on saves. Scheduled delivery rechecks the staff member's current access and Maru's channel permissions.

The editor supports plain text, a rich embed, uploaded images/files, selected role notifications, @everyone and @here. Select recipient roles by name; selected mentions are prepended to the message. Other user mentions cannot notify users. Everyone/here notify only when their corresponding controls are selected; their unselected text is made non-notifying. Maru needs Mention Everyone for everyone/here and non-mentionable roles. The composed text including added mentions must fit in 2,000 characters. Embeds use Discord limits (including 6,000 combined textual characters). The text preview is escaped and never posts or notifies.

Attach up to ten files, at most 10 MiB each and 20 MiB total source uploads per saved post. Source bytes are stored in PostgreSQL; scheduled posts reuse them. Images appear as Discord attachments. An embed image may use a public HTTP(S) URL or `attachment://filename.png`. Existing source files and existing Discord attachments have Keep controls. Uncheck to omit them from the next send/edit. New uploads must be selected again after a validation failure. No external image/file URL is downloaded by Maru.

Save draft does not send. Send now saves and queues that exact version. Activating a schedule saves the entire composer. Draft saves, new versions, pauses and deletion cancel older pending jobs. Enter defaults to Save draft. A repeated send/edit request ID cannot create a second run. Saving a new version while a request is Sending is blocked; wait for its outcome and reload. Deleting a saved post removes its uploaded source files and cancels pending work; Discord messages already posted remain.

## Timezones and repeats

Every schedule has its own editable IANA timezone. On a new composer, the browser suggests the moderator's local timezone. Without JavaScript, enter a timezone manually (for example `Europe/London`, `Asia/Tokyo`, or `UTC`). Existing schedules retain their chosen timezone regardless of which moderator opens them.

Supported schedules:

- Once: one future local date/time in the selected timezone.
- Fixed interval: elapsed minutes anchored at the first eligible date/time, from 1 to 525,600 minutes.
- Selected weekdays: one local clock time on each selected day, starting no earlier than the first eligible date/time.
- Monthly date: a local clock time on a selected day 1–31; months without that date are skipped.

Calendar schedules follow daylight-saving changes in their chosen zone. Fixed intervals measure actual elapsed time. A local start time inside a spring-forward gap is rejected. Later calendar occurrences inside a gap are skipped. For repeated fall-back hours, choose the first or second occurrence; only one is delivered. Dates are supported from 2020 through 2100.

The saved-post list shows the next occurrence in its schedule's timezone. Browser-side labels also show the same instant in the viewing moderator's timezone. Delivery history records UTC and adds viewer-local labels. No fixed global timezone is used. Stored delivery instants use PostgreSQL timestamps with timezone.

## Edit a message by link

Paste the Discord message link into **Edit by Discord message link**. The bot verifies the configured guild and its own author ID. This works for editable public messages sent by this Maru bot outside Announcements, including its public interaction responses. Messages by another bot, person or foreign webhook are rejected even if named Maru. Ephemeral/private interaction replies are not normal accessible channel messages. Discord's Components V2 messages cannot be converted into text/embed messages through this editor; they receive an explicit explanation.

The editor loads current text, rich embeds and attachments. It edits the first embed's title/description/color/link/image while preserving its other rich fields and additional rich embeds. Discord-generated link previews are not treated as authored rich embeds. Existing components are omitted from the PATCH so Discord preserves them. New attachments can be added; existing ones stay unless unchecked. Edits suppress notifications. The response is edited in place rather than replaced with a new post.

A fingerprint binds the edit to the loaded Discord version. It is checked when queueing and again before PATCH; if content/attachments/components changed, load the message again. Discord has no atomic compare-and-swap message endpoint, so an external change in the final interval between read and PATCH can still race. Messages managed by another Maru feature (such as Starboard) may be updated again by that feature. The editor does not rewrite that feature's settings. Active or archived thread links are loaded by ID and remain subject to Discord's thread permissions/state.

## Delivery history and recovery

The worker polls every five seconds, advances one due schedule and claims one pending delivery per tick. A persisted claim and audit commit before contacting Discord. The sender has automatic transport retries disabled and uses stable enforced nonces for new messages. Lost requests are never blindly repeated; outcomes are Pending, Sending, Sent, Failed, Unknown or Cancelled. View message opens a Discord-confirmed result.

Settings and worker claims share the server lock. A claim still Sending after two minutes becomes Unknown after restart. If recording an outcome fails after Discord dispatch, the claim remains to prevent accidental replay. Audit events record IDs, versions and outcomes rather than message bodies/files. Previously dispatched requests may finish even during shutdown.

Missed scheduled occurrences older than 15 minutes are skipped and audited. Recurring schedules advance to their next future occurrence, so an outage does not produce a backlog burst. One-time posts missed by that amount become completed without dispatch. A queued Send now may still be delivered after downtime; cancel its pending work before reconnecting if no longer wanted. Once an uncertain run is claimed, use Discord to check the result before manually requesting another send.

## Installation

Apply after welcome messages PR #35. This patch adds `025_announcements.sql`. Run the usual migration command before starting this version:

```powershell
npm run db:migrate
```

Railway should use the existing pre-deploy migration command. No new dependencies, environment variables, privileged intents, or slash-command registration are required for this Discord stage. The later social connections will require their platform-specific setup.

## Private-server acceptance

1. Create a draft with text, an embed and a small uploaded image. Save/reopen, then Send now. Confirm one post and Sent in delivery history.
2. Load that message's link. Edit text/embed and retain the attachment; confirm the same Discord message changes in place. Also edit a disposable message Maru sent through another feature.
3. Schedule one post a few minutes ahead. Verify the displayed chosen-zone time and your local equivalent, then verify one delivery.
4. Set an interval on a disposable channel, observe two occurrences, then Pause. Confirm no further posts. Test a weekday/monthly schedule via the shown next time before waiting for a long interval.
5. Use a temporary role and test channel to verify selected-role/everyone/here notifications deliberately. Leave notification selections blank for ordinary tests.
6. Open an old edit page, modify the same message elsewhere, then submit the old page. Confirm it refuses to overwrite the newer version.
7. Verify an ordinary Mod can view but cannot send/schedule/edit; verify a revoked scheduling actor cannot trigger delivery.

Automated tests cover timezone offsets, DST gaps/folds, weekday/monthly/leap-day schedules, fixed intervals, durable duplicate suppression, file ownership/limits, permissions, current staff access, expiry/staleness, paused/deleted work, cross-guild isolation, message fingerprints, multipart HTTP and escaped output, lost Discord requests, and audit rollback before/after dispatch. Live browser layout and Discord delivery still require the checks above.

References: [Discord Create/Edit Message](https://docs.discord.com/developers/resources/message), [Intl.DateTimeFormat](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat).
