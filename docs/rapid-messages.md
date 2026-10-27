# Rapid-message filtering

This is a custom post-message rule, configured alongside blocked words in Maru → AutoMod. It defaults **Off**. Migration 011 is additive; no new secrets, dependencies, intents or slash commands are needed.

## Configuration

Admins and Mods with full management access may edit the rule. Ordinary Mods can view settings and results. Settings require a current session, fresh staff-role lookup, same-origin POST, a session/revision-specific CSRF proof, and a reason. Changes and their before/after audit commit together. Stale forms are rejected.

- Default: allow **5 messages in a rolling 5-second window**, per human member across eligible channels. Remove the sixth and later messages while the limit is exceeded. The first five remain.
- Message limit: 2–50; window: 1–60 seconds. The left boundary is exclusive, so a message exactly five seconds old is outside a five-second window.
- Every removed over-limit message counts as one rapid-message violation. Five violations within a rolling ten-minute window trigger a timeout, configurable from 1 second to 28 days (default ten minutes).
- A confirmed timeout resets only the rapid-message violation counter. It does not reset the short message-rate history or the blocked-word counter. Existing active timeouts are not shortened or extended.
- Global exempt roles and ignored channels apply. Each rule has its own override selections. A role override cannot bypass an ignored channel, or vice versa. Ignored thread parents apply to their threads.
- Bots, webhooks and the actual guild owner are excluded. Exempt messages do not enter the rate history. Global Administrator permission prevents native timeouts; include staff roles in the exemption list to exempt their messages too.
- Changing AutoMod settings starts a fresh short message-rate history for the new revision. Existing ten-minute violation counters remain. A no-op save does not change the revision or restart the rate window.

A quiet member can resume posting once older messages leave the rate window. This rule checks rate, not repeated text, links or mentions; those filters are separate future work.

## Delivery and recovery

Only MESSAGE_CREATE events add to the rate. Editing a message does not create another message or count another violation. A create and an immediate edit retain the original create timestamp. Duplicate events do not inflate the history. Gateway timestamps are used rather than worker processing times. Out-of-order late events do not retroactively change earlier decisions.

The existing durable AutoMod queue and per-server worker/settings lock serialize observation and dispatch. Current message author, roles, channel permissions and native timeout eligibility are fetched from Discord. Rules have independent violation records, counters, log nonces and case request IDs. One message can violate both rules and generate two logs; its deletion is reconciled and native active timeouts prevent a second timeout. An unresolved automatic timeout from another rule blocks further automatic timeout dispatch pending review.

Spam history contains message IDs, member IDs, timestamps, counts and settings revision, without message content. Normal message IDs must be queued while this rule is enabled. Completed jobs and traffic history older than one hour are removed during worker activity; traffic evidence for unresolved jobs is retained. Violations, cases and audits remain. Changing settings prevents queued decisions from an earlier revision from causing new spam actions.

A lost delete response is reconciled by fetching the message again. Native timeout claims commit before PATCH, with no blind retry after an uncertain outcome. Current Discord timeout state can confirm the exact requested end. Applied/rejected/unconfirmed results, permission failures and logging failures remain distinct. No automatic DMs are sent. Routine logs have mentions disabled and include rate evidence, removal status, violation count and any case number.

## Limits

The in-memory intake has a 5,000-message bound before persistence. A crash, disconnection, unavailable database or full intake can lose events not yet saved. There is no channel-history backfill. Missing original messages cannot newly enter the traffic history, though saved observations survive restarts. Creates older than ten minutes or more than thirty seconds in the future do not enter the short rate history. Actions follow queued processing and Discord availability, rather than blocking messages before they appear. Inspect the pending-work notice and Railway logs if processing falls behind.

## Development test

1. Keep blocked-word filtering Off to test this rule independently. Verify global exemptions and the saved moderation log destination.
2. Give Maru Manage Messages and Moderate Members and put its role above a willing ordinary test member. Use a non-ignored development channel.
3. Set the message limit to **2**, window to **10 seconds**, and timeout to **1m**. Enable rapid-message filtering and save a reason.
4. Have the test member send three distinct ordinary messages in ten seconds. The first two stay; the third is removed and logged as violation one.
5. Wait more than ten seconds. A new ordinary message should stay. For the timeout check, send another burst that produces four more over-limit messages within ten minutes of the first violation. The fifth violation should have an Applied timeout case and a log without a Mods ping.
6. After the timeout, verify an exempt role and ignored channel keep messages visible. Use /untimeout if ending the agreed test early.
7. Restore **5 messages / 5 seconds / 10m timeout**, turn the rule Off, save, and retain existing production protections until rollout is agreed.

Disable both AutoMod rules before rolling back to an older application build that predates migration 011; older code does not scope all records by rule. Do not edit or reverse applied migrations.

## Separate saves

The page has independent **Save blocked words**, **Save rapid messaging**, and **Save shared exemptions** buttons. Each section requires its own reason. A rule save preserves the other rule and shared exemption selections; a shared-exemption save preserves both rule configurations and removes overrides for exemptions no longer selected. Save one section before editing another, because each save refreshes the page. All sections share the existing revision/stale-form protection and audit transaction. Changing any section still starts a fresh short rapid-message observation window as before. Older combined forms remain supported for deployment compatibility. No migration is needed for this page change.
