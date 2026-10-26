# Manual bans and unbans

`/ban member:<member> reason:<text> [delete-history:<duration>]` bans a current member. Message deletion defaults to the previous **24 hours**. Override with `0` (keep history), `1h`, `24h`, `7d`, or another integer duration using s/m/h/d, between 0 and 604800 seconds. Fractional, compound, negative, and over-seven-day windows are rejected. This is a requested lookback window, not a count of deleted messages.

`/unban user-id:<Discord user ID> reason:<text>` removes an existing ban. Copy the banned user's ID from Discord with Developer Mode enabled. The target does not need to be a server member. Unbanning does not restore deleted messages, invite the user, or automatically rejoin them. No member DM is sent for unbans.

Both commands require a 1–500 character reason and reply privately to staff. An already-banned target or unbanning a user who is not banned performs no additional action, deletion, notification or case allocation.

## Access

- The actor needs current configured Maru Admin or Mods access **and Discord Ban Members permission**. An individual full Maru access grant does not grant native Discord permissions.
- Maru also needs Ban Members permission. For bans, its role and the actor's highest role must be above the target. A configured staff actor who owns the server satisfies the actor hierarchy check through ownership.
- Bans reject self-targets, bots, the owner, native Administrator accounts, and staff with equal or higher Maru access. Admins/full-access Mods may target an eligible lower-ranked ordinary Mod.
- This increment bans current members only. ID-based bans of nonmembers and mass raid bans are separate future features. Unbans use an ID because banned users have left the server.
- Before acceptance, Maru refreshes roles, memberships, ownership, bot/actor permissions and current ban state. It repeats validation after the pre-ban DM attempt, including the database full-access grant check. Lost access, departed targets or failed lookups prevent the native request.

Discord's ban and unban endpoints require BAN_MEMBERS and return an empty success response. The ban endpoint accepts delete_message_seconds from 0 to 604800. Reference: https://docs.discord.com/developers/resources/guild#create-guild-ban and https://docs.discord.com/developers/resources/guild#remove-guild-ban

## Pre-ban DM and staff log

The case and BAN_REQUESTED audit record commit before Maru attempts the DM. The notice contains the server, case number, reason and requested deletion window. It says a ban was requested and that the notice precedes the attempt; it never claims the ban has already happened.

The DM claim is durable before sending. A closed DM records Failed; a missing/invalid response records Not confirmed. Either delivery outcome still permits the ban, subject to the fresh permission check. DM outcome and audit commit together before the native action. If that database write fails, the native action stops and staff must review the saved case; this is a database failure, separate from a normal closed DM.

The staff log is attempted after a durably recorded native outcome and includes the action result separately from the pre-ban DM result. A Sent DM may accompany a Rejected ban, for example if permissions changed during the notice. Log failures do not undo a ban. Mentions are disabled. A sent notification means Discord confirmed creation, not that it was read.

## Recorded outcomes and retries

Warnings, timeouts, bans and unbans share one per-server case sequence. Each accepted case preserves its original reason and requested deletion window. Native cases remain read only in the dashboard and database. To remove a live ban, issue `/unban`; changing a historical case would not undo Discord's action.

The native request is claimed before dispatch. A shared PostgreSQL member lock serializes Maru ban/timeout operations across instances. A busy request creates no case. Any pooled connection whose lock cannot safely be released is discarded.

A dedicated REST writer disables transport/server-error retries for bans/unbans and the pre-ban DM, with 15-second request deadlines. Discord rate-limit waits remain subject to the abort signal. Duplicate interactions return their stored cases without repeating the action, DM, deletion or log. Restarts do not resume interrupted actions or notifications.

Applied means Discord confirmed the native request. Rejected means no native request was dispatched after revalidation failed, or Discord explicitly rejected it. Not confirmed means the action may have happened but the response was unavailable or unexpected. An interrupted request can remain Not attempted or Not confirmed (attempt started). Result and audit write together; database failure after dispatch leaves uncertainty. Review `/case`, the dashboard and Discord's current ban list before issuing a new explicit command. These cases are historical, not live ban-state checks. Other moderators and bots can change Discord state independently.

## Setup and verification

Apply `006_bans.sql` using `npm run db:migrate`; Railway's existing pre-deploy command applies the same migration. No new dependencies, secrets, Railway settings, or gateway intents are required. Migration 006 preserves existing warnings/timeouts and supports the old bot during deployment. Do not modify applied migration files.

Register `/ban` and `/unban` with `npm run commands:test`, and deploy the new code before using them. Give the Maru Test role Ban Members and put it above eligible target roles. The acting staff member also needs Ban Members. The bot does not need Administrator.

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts test/dashboard.test.ts test/warnings.test.ts test/timeouts.test.ts test/bans.test.ts
```

Automated tests use isolated PostgreSQL and fake Discord operations; they do not ban anyone, delete live messages, or send Discord messages. Coverage includes the default and overridden windows, DM-before-ban ordering, role/grant revocation during DM, hierarchy and native permissions, lookup failures, no-op requests, database/audit rollback, uncertain responses, duplicate protection, shared case sequence, adapter payloads, UI read-only enforcement and migration compatibility.

Live verification remains pending until a willing ordinary test member is available in the private development server. Use `delete-history:0` for that future test to preserve their messages. Confirm the native ban, pre-ban DM and log separately, then unban by ID and compare the new case with Discord's ban list. Deleted messages cannot be restored by unbanning.
