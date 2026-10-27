# Repeated text and exact image files

Migration 012 adds an independent AutoMod rule. It defaults **Off**, with text and image checks selected, a trigger of **3 occurrences in 30 seconds**, and a **10-minute timeout after five violations within ten minutes**. Configure it under Maru → AutoMod → Repeated-message filtering, using **Save repeated messages** and its own reason field. Other rule configuration is preserved.

## Matching

- Counts are per member across eligible channels in the configured server. Only human message creates enter the repetition history. Bots, webhooks, the actual owner, exempt roles and ignored channels/thread parents are excluded before image downloads.
- Text uses the same compatibility/case/whitespace normalization as blocked words, including common zero-width separators. It compares the entire normalized nonempty text, rather than finding a repeated substring. Blank captions do not become repeated text.
- Image uploads are compared by SHA-256 over the original Discord attachment file bytes. Different attachment IDs, filenames, captions and signed URL parameters do not change the fingerprint. Resized, edited, recompressed or metadata-modified files have different bytes and are distinct. No visual/perceptual matching is performed.
- Either repeated text or any one repeated image triggers removal of the whole message at the configured occurrence number and thereafter while the rolling limit is met. A repeated caption may trigger even when its accompanying images differ. Text and image checks can be enabled independently.
- Multiple copies of one file in a single post count as one occurrence. A post matching text and several images still produces one repeated-message violation and one log. Different AutoMod rules can log the same message independently.
- Defaults retain the first two matching posts and remove the third. The occurrence trigger is configurable from 2–50 and the window from 1–300 seconds. The left boundary is exclusive. Messages deleted by this rule still count toward its repetition history until their original timestamps leave the window.
- Content edits do not add another occurrence. Current text/attachments are checked again before deletion; removing the matching material before dispatch avoids a stale deletion. A create immediately followed by an edit is observed once using its original create timestamp and the content available at processing time.

## Actions, exemptions and configuration

Each removed repeated message adds one violation to this rule's independent rolling ten-minute counter. At five violations, Maru attempts the configured native timeout (1 second to 28 days) with a durable claim and shared member lock. Confirmed application resets only this rule's violation counter, not its short repetition history or the counters of other rules. Protected targets, missing permissions, existing native timeouts and unresolved automatic requests from other rules are respected. Discord uncertainty never causes blind timeout replay. Cases use the existing shared case numbering, origin Automatic moderation, and no automatic member DM.

Global exempt roles/channels apply, with independent repetition-rule overrides. Shared-exemption saves remove overrides referring to deselected exemptions. Admin/full-access Mod authorization, current sessions/roles, same-origin POST, a section-specific CSRF proof, revision checks and atomic before/after audit records protect configuration changes. Changing any AutoMod configuration starts fresh short observation windows; old queued creates cannot be punished under a newer revision. Ten-minute violation counters remain.

## Image download boundaries

Only original HTTPS `cdn.discordapp.com/attachments/{channel}/{attachment}/{filename}` URLs supplied by the fetched Discord message are accepted. Message links, embed previews, arbitrary external hosts and transformed media proxy URLs are not fetched. Redirects and credentials in URLs are rejected; the bot token is never sent to the CDN downloader. No image decoder is invoked and no file is executed.

The initial limits are **25 MiB per file**, **50 MiB and ten image attachments per message**, eight seconds per download and twelve seconds for a message's download work. Streams must match the declared attachment byte size; oversized, truncated, unavailable, redirected or unexpectedly encoded responses produce no fingerprint. Bytes are hashed as they stream and are not saved to disk or the database. A bounded in-memory cache retains successful file fingerprints for up to sixty seconds, keyed by immutable attachment identity. No failed download is assumed to match another failed download.

A message with unavailable/unsupported-size images may still qualify by known repeated text or another successfully checked image. The dashboard reports how many observed messages had incomplete image checks in the last hour. Logs contain repetition type/count, IDs, deletion/timeout results and any case number, with mentions disabled. Logs do not copy the text, file bytes, filenames, URLs or raw fingerprints.

## Persistence and limitations

The database stores member/message IDs, timestamps, settings revision, text/file fingerprints, matched repetition summaries and image-check status. Normal text and uploaded bytes are not retained. Fingerprints are hashes, not encryption. Activity and completed queue rows older than one hour are cleaned during worker activity; unresolved jobs keep their evidence. Violations, cases and audits remain.

The existing bounded intake and durable queue apply. A crash before persistence, full intake, inaccessible original, unavailable CDN or disconnected bot may miss an event or image. There is no history backfill. Late out-of-order events do not retroactively change earlier decisions. Creates older than ten minutes or more than thirty seconds in the future are excluded from current repetition observations. Network/image checks add processing time, so removal happens after posting and may be delayed. Disable the rule if processing falls behind while investigating the pending-work notice and host logs.

Disable all AutoMod rules before rolling back to a build that predates the multi-rule schema. Do not edit applied migrations.

## Development checks

1. Keep other rules Off, verify global exemptions and permissions, enable repeated messages with both checks selected, trigger 3 / 30 seconds / timeout 1m, then save.
2. Have a willing non-exempt test member post the same ordinary text three times within thirty seconds in an eligible channel. The first two should stay; the third should be removed and logged as violation one.
3. Reupload the same small image file three times with distinct captions and filenames. The third should be removed with an Identical image entry. A different image file should stay if neither its text nor image is repeated.
4. Confirm one multi-image message counts once, then test the fifth violation timeout and its recorded case. Verify role/channel exemptions with overrides unselected.
5. Restore the desired trigger/window and 10m timeout, turn the rule Off, and save before continuing development. Keep existing production protections until rollout is agreed.

Official attachment URL reference: https://github.com/discord/discord-api-docs/blob/main/developers/reference.mdx#signed-attachment-cdn-urls
