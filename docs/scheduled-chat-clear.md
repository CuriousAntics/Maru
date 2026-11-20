# Scheduled voice-channel chat clearing

Adds `/chat-clear` to the staff dashboard. One voice channel text chat can be selected per configured server. The feature defaults **Off**, with a **6-hour** interval. Admins and Mods with full access can choose a whole number of hours from **1 to 720**. Ordinary Mods can view settings, countdown delivery and recent sweeps.

## Behavior

- Enabling or changing the channel/interval starts a full new interval. Saving unchanged settings preserves the existing deadline. The dashboard displays the next deadline in UTC.
- At each deadline, clear the entire unpinned chat history present when the sweep starts, irrespective of message age or author. This includes bot and staff posts. It is a periodic clear, not a per-message expiry rule.
- Pin preservation is mandatory. Messages observed pinned in the history page or an immediate fresh lookup are skipped. Nondeletable/unknown Discord system message types are also preserved. Voice membership, threads and other channels are untouched.
- Messages posted at or after the sweep's fixed starting cutoff wait for the next sweep. Countdown messages are ordinary unpinned messages and are removed with the chat.
- Post quiet countdown notices about **5 minutes**, **1 minute**, and **10 seconds** before clearing. The worker polls every five seconds; rate limits, network delays or downtime can delay/skip later notices. No mentions or DMs are sent.
- A confirmed initial warning is required before clearing. If the first warning window was missed, shift the deadline to give a fresh five minutes on recovery. Unknown or failed initial delivery pauses deletion; check permissions/Discord, switch Off and save, then On and save to reset. Later warnings are best effort and do not repeat after uncertain responses.
- Switching Off cancels an unfinished sweep. A batch already running finishes before the change commits; an already dispatched deletion cannot be undone. A busy save reports that the sweep is processing and can be retried.

## Discord permissions and deletion limits

Only actual guild voice channels are selectable. Maru needs **View Channel**, **Read Message History**, **Send Messages**, and **Manage Messages** in the selected channel. These are checked at enable and before each work batch. No extra Gateway intents, slash commands, tokens or packages are needed.

Use individual message DELETE requests, never Discord bulk deletion, to support history older than two weeks and check each message's current pinned status. Work is bounded to ten messages per five-second tick; large histories clear gradually under Discord rate limits. Discord has no atomic “delete only if still unpinned” endpoint: a pin applied in the tiny interval after the final lookup and before DELETE can race the request. Pin important messages before the sweep starts.

References: [message API, pinned field, deletable types and deletion endpoints](https://docs.discord.com/developers/resources/message), [channel types](https://docs.discord.com/developers/resources/channel).

## Persistence and recovery

Migration `018_scheduled_chat_clear.sql` adds settings, sweep progress and countdown delivery records. Apply it before starting the new build; never alter previously applied migrations. Existing protection settings are unchanged.

A committed sweep intent records the channel, settings revision and fixed snowflake cutoff before any external deletion. Schedule row locks serialize settings and sweep batches, including multiple workers. Cursor and aggregate counts survive restarts. Lost deletion responses can be retried for the same fixed ID range; every candidate is checked for pins again. Missing message responses are harmless. Unknown channel/permission/API responses pause and retry after one minute. Discord messages, attachments and message contents are not stored in the new tables or audit records.

A completed sweep records aggregate results in the dashboard and audit history. Counts are observed removed-or-already-absent outcomes, not proof of exactly how many messages Maru deleted; lost responses or database outcomes can undercount. Missed deadlines do not create repeated catch-up sweeps. The next future interval follows the saved deadline. Settings changes cancel older revisions and reset the countdown. Audit failures prevent new intentions/settings from committing and prevent completion from being recorded falsely.

## Validation and rollout

`test/chat-clear.test.ts` applies the full migration chain to an isolated PostgreSQL-compatible database and uses fake Discord calls. It covers permission/authentication and CSRF checks, schedule timing, countdown claims and lost responses, fixed cutoffs, pin races visible before DELETE, old history, pagination/restarts, disable/change cancellation, permission-loss recovery and audit failures. No live channels are cleared by automated tests.

Keep the feature Off until deployed and tested in the private development server. Live acceptance: select a disposable voice channel, use the minimum one-hour interval, pin one message and leave another unpinned; confirm all three notices, deletion of unpinned history, retention of the pin, preservation of messages posted after the sweep starts, and an uninterrupted voice connection. Then verify Off stops future runs. Return the interval to six hours and keep Off pending rollout. Expired-invite testing remains separately deferred at the user's request.
