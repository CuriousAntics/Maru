# Manual warnings

`/warn member:<member> reason:<text>` creates a numbered warning in the configured test server. The reason is required and limited to 500 characters. The staff reply is ephemeral. `/case number:<number>` privately reads a saved case and its notification status, including after the warned member has left.

## Who can use the commands

Configured Admins and Mods can issue warnings and look up cases. Current member roles are fetched rather than trusting command input or old role caches. Native Administrator permission or server ownership alone does not grant Maru access.

Self-warnings, bot targets, and the server owner are rejected. The actor must be above the target in Discord's role hierarchy; a configured staff actor who owns the server can satisfy the hierarchy check through ownership. Staff with equal or greater Maru access cannot be warned: an Admin can warn a lower-ranked ordinary Mod, while ordinary Mods cannot warn other Mods. Mods with an effective full-access grant count as Admins. Target membership, role order, grants, and actor access are checked before the case is committed.

Warnings only record a moderation decision and attempt notifications. They do not apply timeouts, kick/ban members, add punishment roles, or trigger escalation thresholds.

## Persistence and delivery

`003_moderation_warnings.sql` creates a per-server case counter and `moderation_cases`. Case numbers are unique within each server. The warning, number allocation, and `WARNING_CREATED` audit event commit in one transaction before any notification. A failed initial audit write rolls back the warning and counter. The log destination and server name are captured at creation.

The Discord interaction ID identifies the request. Repeated delivery of the same interaction returns its case without creating another warning or repeating notifications. Running a new `/warn` command intentionally creates a new case, even if its reason and target match an earlier warning; inspect existing cases before issuing another command after an uncertain reply.

Maru attempts to DM the warned member by default. The DM includes the server, case number, and reason. It also attempts an embed in the saved moderation log channel, including the actor and target IDs. Allowed mentions are disabled. The staff log uses the destination saved on the case; a later settings change does not move an accepted warning to a different destination. Current channel access and View Channel, Send Messages, and Embed Links permissions are checked before the log attempt.

DM and log status are independent. Closed DMs do not undo the case or prevent the staff log. Missing log configuration does not prevent saving a warning or attempting the DM. Message nonces are stable per case and destination kind, with Discord nonce enforcement enabled during short REST transport retries.

| Status | Meaning |
| --- | --- |
| Not attempted | The warning is saved but delivery was not claimed. |
| Not confirmed (attempt started) | An attempt was claimed; its final result is unavailable, possibly after a restart or an audit failure. |
| Sent | Discord confirmed message creation; this is not a read receipt. |
| Failed | Discord rejected delivery or the channel is unavailable to the bot. |
| Not confirmed | A response was lost or unavailable; the message may have arrived. |
| No log channel configured | No destination was saved when the case was created. |

Deliveries are durably claimed before contacting Discord. They are not automatically replayed after an uncertain result or restart, avoiding repeat warning DMs. Result updates and their `WARNING_DM_*` / `WARNING_LOG_*` audit events commit together. If recording a result fails after sending, the case retains an uncertain state. A later increment can add an explicitly reviewed retry workflow. Use `/case` and inspect the channel before taking further action.

## Setup and verification

No new packages, Railway variables, bot permissions, or gateway intents are added. Existing bot permissions in the selected log channel still apply. Single-member lookups use the Discord REST API; this feature does not enable the privileged Guild Members intent.

Apply the new migration using `npm run db:migrate`. The existing Railway pre-deploy command continues to apply migrations before the new bot starts. Never edit previously applied migration files.

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts test/dashboard.test.ts test/warnings.test.ts
```

After migration, register the test-server commands with `npm run commands:test`. Deploy the code before testing `/warn`. Both new commands are registered individually, preserving other commands.

Live checks in the private test server:

1. Use a consenting ordinary test member below your staff role, with DMs enabled. Do not test against yourself, a bot, the owner, or an equal-access staff account.
2. Run `/warn member:<test member> reason:Maru development test warning`.
3. Confirm a numbered warning is saved, the target receives the DM, and one embed reaches the configured log channel.
4. Read `/case number:<returned number>` and confirm actor, member, reason, and both delivery statuses.
5. Check the dashboard overview for the warning and delivery audit events with the case number.
6. With the test member's consent, repeat using a new reason after they close their DMs to server members. The new warning should remain saved and report DM Failed while the staff log succeeds.
7. Confirm an unmapped member cannot issue `/warn` or read `/case`. Ordinary Mods should be able to warn only an eligible lower-ranked ordinary member.

These checks create real persistent warning cases in the test server. The dashboard now supports [case corrections and voiding](case-changes.md), with ownership permissions and retained history. Manual [timeouts and timeout removal](timeouts.md) are now available as separate native actions. Imports, bans, and website warning creation are not included yet.

Manual bans and unbans are documented in [bans.md](bans.md). These native cases are read only; their pre-ban DM and Discord action results are recorded separately.
