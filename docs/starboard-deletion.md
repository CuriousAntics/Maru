# Deleting a Starboard

Open Starboard in Maru's dashboard and select **Delete board** on a card or **Delete this board** from its edit page. Configured Mods and Admins may delete boards. The confirmation page requires the current board name and a reason of 1–500 characters.

**Also remove this board’s Maru highlights from Discord** is unchecked by default:

- Unchecked: keep existing Discord highlight messages as unmanaged snapshots. They no longer follow changes to reactions, source content, or source deletion. This also leaves any uncertain delivered copy untouched. Maru retains its known message ID as historical metadata but releases live ownership.
- Checked: stop posting and queue removal of only this board's Maru-managed copies. Sources, other boards and other bots' messages are not deleted. The board disappears from the active list immediately; pending cleanup appears separately until confirmed. Missing destination permissions or uncertain earlier deliveries can delay cleanup.

Deletion cannot be undone from the dashboard. Staff may create a new board with the same name. A new board does not adopt kept snapshots; it can create its own copies for qualifying tracked messages.

## Persistence and audit

Deletion preserves an immutable, disabled configuration tombstone and the existing audit trail. The active board name and 25-board capacity are released. The deletion event records the staff actor, original settings, reason, keep/remove choice, revision, and counts of known/uncertain highlights. A source message's text is not stored in the deletion audit.

Deletion, ownership release or cleanup scheduling, and its audit commit in one transaction. An audit failure rolls everything back. Current session and staff roles are verified again inside the transaction. The existing Starboard worker lock prevents a delete from racing with an in-progress post. Stale revisions are rejected; repeated submission of the same decision is idempotent, and cannot alter the recorded keep/remove choice.

Confirmation forms use same-origin POSTs, bounded bodies, exact fields, and session proofs bound to board, revision and delete action. GET never deletes. Deleted boards cannot be edited or reenabled, including through stale forms or the prior worker during rollout. Historical rows remain for audit and safe reconciliation; this is not a database history purge.

## Cleanup behavior

Checked cleanup uses the existing persistent worker. It can remove managed copies without source-channel access. Known copies are checked for bot ownership and their stable marker before deletion. Unknown deliveries are located through their marker before removal, without issuing another message POST. The existing conservative history bounds remain: if an uncertain copy cannot be located, cleanup stays pending for review rather than pretending removal succeeded.

Other active boards are reevaluated when a board is deleted, including an earlier exclusive board. They may post a now-eligible source. Kept snapshots from the deleted board remain separate, unmanaged Discord messages.

## Deployment and verification

Apply migration 009_starboard_deletion.sql with the existing migration command. No new dependencies, secrets, Railway settings, intents or slash commands are needed. Do not edit earlier migrations.

```powershell
npm run check
npm run build
node --import tsx --test test/staff-access.test.ts test/staff-grants.test.ts test/dashboard.test.ts test/warnings.test.ts test/timeouts.test.ts test/bans.test.ts test/starboard-settings.test.ts test/starboard-reactions.test.ts
```

Tests use isolated PostgreSQL and fake Discord calls. They verify authorization, confirmation, CSRF, stale and repeated forms, audit rollback, retained copies, immutable tombstones, name/capacity reuse, worker recovery, source access loss, uncertain delivery and other-board isolation. No live messages are created or deleted by the tests.

After deployment in Maru Development, create a disposable board with a managed highlight. Delete it leaving the checkbox unchecked: the board should disappear while its highlight remains. Repeat with a second disposable board and check the checkbox: only its managed copy should disappear. Verify the original messages remain and Recent staff activity records each deletion choice.
