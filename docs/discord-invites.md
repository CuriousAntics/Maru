# Discord-invite filtering

Migration 013 adds a separate rule under Maru → AutoMod, with **Save Discord invites**, its own reason/proof and independent exemptions/violation counter. It defaults **Off** and uses a **10-minute timeout after five violations within a rolling ten-minute window**. Existing repeated-message live timeout/exemption checks remain pending; adding this feature does not mark those checks complete.

## Policy

- Invites whose verified destination is the configured server are always allowed.
- Other destination servers can be approved by ID (up to 100 IDs, separated by commas, spaces or new lines). Approval applies to all invite codes that resolve to that server, rather than to one particular invite code. The bot need not be a member of an approved server.
- A verified invite to any other server causes the entire containing message to be removed. Multiple such invites in one message count as one violation. At five violations within ten minutes, Maru attempts the configured timeout (1 second–28 days). A confirmed timeout resets only this rule's counter. Cases share the existing numbering and automatic-origin/no-DM behavior.
- If no unapproved destination is confirmed and one or more destinations cannot be verified, the invite rule leaves the message and sends a review log **without a violation, counter increment or moderation case**. Unknown/expired/invalid invites, non-server invites, timeouts, permission/API failures and unexpected responses all take this path.
- A confirmed unapproved invite still causes removal when another invite in the same message is unknown. Unknown links do not provide an exemption for a verified violation. Other AutoMod rules also act independently.
- The global exempt roles/ignored channels apply, with independent invite-rule overrides and thread-parent handling. Bots, webhooks and the actual owner are excluded before lookup or review logging.

## Recognition and verification

The parser recognizes literal discord.gg/code and discord.com/invite/code links, Discord's legacy discordapp.com/invite/code form, www links and the canary/ptb discord.com host forms. Schemes are optional; markdown wrappers, normal trailing punctuation, trailing slashes, query strings and fragments are supported. Code case is preserved. Unicode compatibility forms and common zero-width separators are normalized. Arbitrary URLs, shortened redirects, lookalike hosts, encoded paths, image text and embed contents are not followed or inspected.

Verification calls Discord's GET /invites/{code} API and validates the returned code and destination guild ID. It does not visit user-controlled sites, accept an invite, join another server, fetch other servers' members or revoke an invite. Each distinct code is looked up at most once per processing attempt, with no cross-message destination cache. Up to ten codes are resolved per attempt with a six-second launch budget and three-second request abort signals; remaining codes are unverified and follow the review policy. Parsing is capped at 100 distinct codes per message. Discord scheduling/network availability can still delay processing.

The worker handles both new messages and edits. It fetches the current message and roles, rechecks the current contents before deletion, and respects current approved destinations and exemptions. Removing an invite or replacing it with an allowed/unverified destination before dispatch prevents the stale deletion. A completed review is not polled automatically; a later content edit or retry of interrupted work may confirm an unapproved destination and create a violation.

## Review logging and recovery

Review records are stored separately from violations and displayed under **Invite reviews**, including user/channel/message IDs, unverified invite codes and delivery state. They do not imply that the original message is still visible or that a moderator has reviewed it. The full source text is not copied. Logs use no mentions, never ping Mods, and include a link to the original message.

There is at most one review notification per message, even across repeated events, restarts or edits. A later confirmed violation has its own independent log nonce and case; it does not repeat the earlier review. The review audit commits before its send claim and external POST. An uncertain send response or result-audit failure is not blindly resent. Failed/unconfirmed/not-configured delivery states remain visible. Clearing or losing the log destination cannot turn an unknown invite into a punishment.

Confirmed violations use the existing durable action claims and shared member lock. Native permission/hierarchy checks, active timeouts, unresolved requests from other rules, audit rollback, bounded requests and no-blind-replay behavior remain in force. Configuration remains Admin/full-access-Mod only, with current roles/sessions, strict field validation, section-specific CSRF proofs, stale-form protection and atomic settings/audit writes. Shared-exemption saves remove overrides referring to deselected exemptions; all other rule settings are preserved.

## Limits and deployment

No new dependencies, gateway intents, environment variables or slash commands are needed. Keep the existing moderation log destination and Manage Messages/Moderate Members permissions. Only the configured development guild is processed. The bounded intake/durable queue can miss events before persistence when disconnected, full or unavailable; there is no history backfill. Moderation happens after posting and can be delayed. Review rows and their audit history are retained; they are not new moderation cases.

Apply migration 013 before deploying the new application code. Do not edit old applied migrations. Disable all AutoMod rules before rolling back to a version that does not scope records by all current rule keys.

## Development checks

Keep other rules Off while testing this rule independently. Use a willing ordinary test member in an eligible development channel.

1. Enable invite filtering with an empty approved list and a 1m test timeout. Confirm the development server's own invite stays.
2. Add a separate test server's ID and confirm its invite stays. Remove that approval and post a fresh invite to that server; it should be removed and count as violation one.
3. Post an expired or deliberately nonexistent invite code. The message should stay, a review log should appear without a Mod ping, and the violation count/cases should not increase.
4. Check duplicate events/edits, mixed known/unknown invites, the fifth confirmed violation timeout, role/channel exemptions and independent save buttons when testers are available.
5. Restore the 10m timeout, turn this rule Off and save before continuing development. Keep existing production protections until rollout is agreed.

Official API reference: https://github.com/discord/discord-api-docs/blob/main/developers/resources/invite.mdx#get-invite
