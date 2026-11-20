# Custom slash-command responses

Migration `019_custom_slash_responses.sql` adds dashboard-managed public responses at `/custom-commands`. Each entry defaults **Off**. Admins and Mods with full access can add, edit, enable, disable or remove entries; ordinary Mods can view them.

## Supported behavior

- Native Discord slash commands such as `/magic`, offered under the **Maru** application. These are not ordinary message-prefix triggers or automatic text matching. There is no ordinary trigger message to delete: Maru posts the interaction's public response and never deletes the invoking member's content.
- Available to everyone in the configured server, subject to Discord's channel and application-command permissions. No staff check is required to invoke a custom response. DMs, other guilds, bot users and stale/different Discord command IDs cannot obtain saved content.
- Saved literal text, custom emoji markup and media links, up to 2,000 characters. No template evaluation, scripts, actions, arguments, role changes or downloaded attachments. Unicode emojis work as text; custom emojis and automatic media previews depend on Discord permissions and source availability. Maru never fetches the response's media URLs itself.
- Mentions are sent with an empty allowed-mentions list: user, role and everyone text does not ping. Responses are public and non-ephemeral.
- Names: 1–32 lowercase ASCII letters, digits, hyphens or underscores, without a slash. All Maru built-in command names are reserved from a single shared list. Descriptions are 1–100 characters. Up to 80 nonremoved custom commands can be stored per server, including disabled entries.
- Names are immutable. Remove an old entry and add another to rename. Removed rows remain visible for synchronization errors/retries and can be restored by saving them again. Responses are retained in settings for this purpose, not copied into audit records.

## Discord registration and recovery

A five-second worker synchronizes changed entries individually using guild application-command GET/POST/PATCH/DELETE endpoints. It never bulk-overwrites Maru's registrations and does not alter unrelated/built-in commands. It uses the connected bot's application ID, so no new environment variables, credentials, Gateway intents, packages or command-registration script runs are needed. The existing manual registration script still upserts only built-in commands.

Enable queues registration; the command picker updates when Discord confirms it. Edits to known registrations use the recorded ID. Disable/remove immediately blocks new response lookups even while picker cleanup is pending. Removal deletes only the exact ID previously confirmed for this entry. A name collision with an unowned registration is an error rather than permission to overwrite it. Multiple apps, such as Dyno and Maru, can offer similarly named commands; select Maru when testing.

Claims are committed before external synchronization. Saves while a claim is active report Busy. Interrupted claims become visible errors after one minute. Unknown outcomes are never automatically replayed. Save again to retry; an uncertain creation that left a Discord command behind cannot safely be adopted by name, and may require a different command name or separate registration investigation. Known-ID edits/removals can be retried after lookup. Normal failures do not leak remote error bodies or credentials into the page or logs.

Guild and row locks serialize configuration saves, revisions reject stale forms, and current staff roles plus an unexpired session are checked within each save transaction. POST forms require same-origin, CSRF proof, strict scalar fields and a change reason. Audit failure rolls back the setting change. Command names/availability/revisions and reasons are audited without duplicating response contents. Response delivery edits only the original interaction response, with no follow-up retry after uncertainty. No invocation content, interaction tokens or member usage history is persisted.

## Validation and deployment

`test/custom-commands.test.ts` uses isolated PostgreSQL-compatible storage and fake Discord/HTTP interactions. It tests the full migration chain, permissions, full-access grants, invalid names/lengths, limits, CSRF/origin/revision enforcement, HTML escaping, default Off, native registration isolation, exact-ID updates/removal, collision safety, crash/lost-response handling, public nonstaff use and suppression of mention pings. Automated tests never register commands with real Discord or post real messages.

Apply migration 019 before starting this build. Confirm the new dashboard page loads with no commands enabled. In the private development server, add `/magic` with a disposable response, enable it, wait for synchronization and invoke **Maru's** command as a nonstaff member. Confirm its response is public, then test emoji/media responses, an edit, Off, and removal. Keep Dyno unchanged during acceptance; no commands are imported automatically from screenshots. Configure the remaining saved responses from their original text once the first command passes. Live acceptance remains pending, separate from the scheduled-clear test already underway and the expired-invite tests deferred by the user.

References: [Discord application commands](https://docs.discord.com/developers/interactions/application-commands), [interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding).

## Optional triggers inside ordinary messages

Migration 020 adds an independent, default-Off in-message trigger switch to each command, reusing its response for complete `/name` words anywhere in new human messages. Native slash-command behavior remains available as before. See [inline-command-triggers.md](inline-command-triggers.md) for boundaries, cooldowns, job outcomes and live acceptance.
