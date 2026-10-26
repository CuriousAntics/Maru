# Case corrections and voiding

The dashboard's case detail page lets authorized staff correct a warning reason or mark a warning void. Ordinary Mods may manage only cases they originally issued. Admins and Mods with effective full access may manage any case in the configured server. The original case author remains unchanged even when another staff member corrects it.

## Correction and voiding

Correction requires a new warning reason and a separate justification, each containing 1–500 characters. The case retains its immutable original reason. Each actual correction records the previous and saved reason, prior/new revision and state, actual staff actor, target ID, justification, and UTC time in `CASE_REASON_CORRECTED` audit events. Saving identical text makes no change and adds no audit event.

Voiding requires a justification and typing the exact case number to confirm. It marks the warning inactive while retaining its case number, original/current reason, original actor, delivery results, and history. `CASE_VOIDED` records the change. The list, detail page, and `/case` show Voided. Voided cases cannot be edited again or restored in this increment. Case numbers are not reused.

The detail page displays the original reason when corrected, the void justification when voided, and the latest 50 change events with complete before/after text. Earlier events remain retained in PostgreSQL. All text is escaped before display.

These controls update the saved case and audit trail. They do not edit or delete Discord DMs or log messages and do not send correction DMs or new Discord log messages. Those original messages may show the original reason. A warning voided before delivery is claimed is not dispatched. Notifications already started may still finish; their statuses remain recorded independently.

## Integrity and access

Each save requires a current session, a same-origin POST, a purpose-specific session proof tied to the case/action/revision, and current staff roles. The transaction takes the shared server lock, checks the session and database grants again, locks the case, enforces ownership, and checks the form revision. Stale forms receive HTTP 409. Authorization and case queries are server-scoped; URL parameters cannot choose another server.

The case update and its audit event commit together. Audit failure rolls back the edit/void, timestamp, and revision. Reposting a successful form cannot repeat its change: its expected revision is stale. Forms and bodies are bounded, including valid maximum-length Unicode text.

`004_case_changes.sql` backfills existing rows with their original reason, Active state, revision zero, and their existing creation time as the initial update time. A database trigger supplies the original reason on older bot inserts during rollout and rejects later attempts to rewrite that original reason. New code continues using the same per-server case counter and interaction identifiers.

## Setup and verification

Apply the new migration with `npm run db:migrate`. Railway's existing `npm run db:migrate:deploy` pre-deploy command also handles it. No new dependencies, environment variables, bot permissions, gateway intents, or command registrations are required. Do not modify earlier migration files.

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts test/dashboard.test.ts test/warnings.test.ts
```

Isolated tests cover ownership and full-access grants, grant/role loss, session expiry, action-specific CSRF, stale/duplicate forms, confirmation, Unicode bounds, immutable originals, audit rollback, server isolation, migration compatibility with old inserts, void-before-delivery behavior, and absence of new notifications when editing.

After deployment, if an existing development test warning is available:

1. Open its detail page and confirm Active state and the applicable controls.
2. Correct its reason, giving a separate justification. Confirm the new reason, original reason, revision, and change-history entry.
3. Check the overview audit event and `/case` display. No additional notification should be sent.
4. Void that test warning with a justification and explicit number confirmation. Confirm Voided state in the detail page, list, and `/case`, with its history preserved.
5. An ordinary Mod should have controls only on their own cases; an Admin or full-access Mod should have controls on any Active case.

If no test case is available, leave live mutation checks pending. No new member warning is needed solely to open or browse these pages. The separate closed-DM live test also remains paused.

Timeout and timeout-removal cases are read only. Use `/untimeout` for a live timeout removal; the warning correction/voiding controls do not change Discord punishment state. See [Manual timeouts](timeouts.md).

Manual bans and unbans are documented in [bans.md](bans.md). These native cases are read only; their pre-ban DM and Discord action results are recorded separately.
