# Manual timeouts

`/timeout member:<member> duration:<duration> reason:<text>` sets or replaces a native Discord timeout. Examples: `30s`, `10m`, `2h`, `1d`, `1w`, up to `28d`. The input uses one integer and one unit; fractional and compound durations are rejected. Replacing a timeout can shorten or extend its remaining time, so choose the intended duration explicitly.

`/untimeout member:<member> reason:<text>` removes an active timeout. If the member has no active timeout, it reports that no action was needed and sends no notification. Both commands require a reason of 1–500 characters and reply privately to staff.

## Permissions

Both configured Admins and Mods can use the commands, subject to all checks below:

- The actor must currently have configured Maru staff access and native Discord Moderate Members permission. A full Maru access grant does not grant native Discord permissions.
- The actor's highest role must be above the target's role. A configured staff actor who owns the server satisfies this hierarchy check through ownership.
- Maru needs Moderate Members permission and a bot role above the target.
- Self-targeting, bots, the server owner, native Administrator accounts, and staff with equal or greater Maru access are rejected. Admins can target eligible lower-ranked ordinary Mods.
- Current roles, ownership, membership, and the member's current timeout are fetched before acceptance. Missing members and permission failures perform no native action.

Discord supports setting `communication_disabled_until` up to 28 days ahead; setting it to null removes the timeout. Owners and native Administrator accounts are protected. Reference: https://docs.discord.com/developers/resources/guild#modify-guild-member

## Cases and action results

Accepted requests share the existing per-server case counter with warnings. The case, requested duration/end, previous end, original reason, actor/target IDs, destination, and requested audit event are committed before the Discord operation. An initial database/audit failure prevents dispatch. Preconditions that fail before acceptance do not allocate a case.

Each native action is claimed in PostgreSQL before dispatch. A PostgreSQL session advisory lock serializes Maru native actions for the same member across bot instances. Another simultaneous request receives a busy response. The lock is released on completion or connection loss; a connection that cannot safely unlock is discarded rather than returned to the pool.

A dedicated REST writer disables transport/server-error retries and uses a bounded request with the saved absolute end time or null. Rate-limit waits remain subject to the abort signal. A repeated Discord interaction returns its stored case without reapplying the action or notifications. A new explicit command is a new request and checks the member's current Discord state again.

| Recorded action result | Meaning |
| --- | --- |
| Not attempted | The case was saved but the native action claim was not confirmed. |
| Not confirmed (attempt started) | A native attempt was claimed, but no final durable result is available. |
| Applied | Discord returned the requested target and timeout value. |
| Rejected | Discord rejected the request, or its requested deadline elapsed before dispatch. |
| Not confirmed | The response was missing, invalid, or unexpected; the action may have happened. |

The action result and its audit event commit together. If recording a result fails after the Discord call, the case remains uncertain. Nothing automatically retries an uncertain action or replays it after a restart. Before issuing a new explicit command, use `/case`, review the dashboard, and check the member's current Discord timeout. These stored cases are historical records, not live timeout-state checks; natural expiry or another moderator's action can change the member's state later.

## Member DMs and staff logs

After a confirmed Applied result, Maru attempts the member DM by default for both application and removal. The DM includes the case, server, reason, recorded result, and requested duration/end where relevant. A failed DM never undoes the native action. Rejected or uncertain actions do not send a DM claiming success.

The staff log reports the recorded action result even if rejected or uncertain. Its delivery is independent of the member DM. A successful log delivery does not mean the native action succeeded: both results are displayed separately. Missing log configuration or permissions do not undo a successful native action. Allowed mentions are disabled, and case-based message nonces protect short notification transport retries.

Notification claims are persisted and are not automatically replayed. Old warning notification attempts are marked as already claimed by the migration. Existing warning DMs and logs continue using their previous behavior.

## Dashboard and corrections

The list and detail pages distinguish Timeout and Timeout removal from Warning. They show the recorded action result, requested duration/end, previous end, and separate notification results. `/case` reads the same records.

Timeout cases are read only in this increment, including at the database level during mixed-version deployment. Warning correction/voiding rules remain unchanged. Use `/untimeout` to remove a live timeout; voiding a historical record would not itself change Discord state.

## Setup and verification

Apply `005_timeouts.sql` with `npm run db:migrate`; Railway's existing pre-deploy migration command handles the same file. No new packages, Railway variables, or gateway intents are required. Register `/timeout` and `/untimeout` with `npm run commands:test`. Ensure the new code is deployed before using them.

In Discord Server Settings, give the Maru Test bot role **Moderate Members** (shown as **Timeout Members** in some client views), and put it above eligible test-member roles. The staff actor also needs native Moderate Members permission. Administrator is not required for the bot.

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts test/dashboard.test.ts test/warnings.test.ts test/timeouts.test.ts
```

Tests use isolated PostgreSQL and fake Discord operations. They do not time out, DM, or log to any live member. Tests cover duration limits, actor/bot permissions, hierarchy, protected targets, request deduplication, persisted claims, explicit rejection, response loss, audit rollback, connection-lock cleanup, notification failures, historical display, native case immutability, and compatibility with old warning inserts.

Live checks when a willing ordinary test member is available:

1. Use `/timeout member:<test member> duration:1m reason:Maru development timeout test`.
2. Confirm Applied, the member's actual Discord timeout, their DM, and the staff log. Read the case to compare stored fields and separate results.
3. Before expiry, use `/untimeout member:<test member> reason:End development timeout test`. Confirm Applied and removal in Discord, with a new case, DM, and log.
4. If it has already expired, `/untimeout` should report no active timeout and send no new DM.
5. Missing native permission should produce a clear error without a native action.

If no test member is available, leave native live checks pending; automated coverage and dashboard inspection can proceed without one.
