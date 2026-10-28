# Nomad, Community and activity tracking

The dashboard's **Community roles** page adds independent activity-tracking and automatic-role switches. Both default **Off**. `COMMUNITY_EVENTS_ENABLED` also defaults false, so deployment does not request a privileged intent before Discord is configured. Existing bot features continue to use their current intents.

## Agreed behavior

- Nomad is assigned when an observed human joins, unless they already permanently earned Community.
- Either **30 distinct messages** or **100 eligible voice minutes**, within a rolling **30 days**, earns Community. The thresholds and window are configurable.
- Select `finished-work` under excluded message channels. Excluding a channel also excludes its threads. All other observed eligible human message creates count; edits, bots, webhooks and system messages do not. A later deletion does not subtract a counted create. Message content and attachments are never stored by this feature.
- The server's configured AFK channel and selected additional AFK channels do not earn voice time. Muted, deafened and suppressed participation does not earn time. A channel needs at least two humans, excluding bots and unknown identities. A muted/deafened human is physically present as a peer but earns no personal credit.
- Community is permanent, even when thresholds change or activity expires. Its recorded award cannot be cleared or rewritten by ordinary database updates. Returning members with a recorded award receive Community again.
- Community is added first and confirmed using fresh member state; only then is Nomad removed. Unrelated roles are never replaced or removed. A temporary failure may leave both roles until the saved work safely resumes.
- Existing Community holders are adopted when observed. The separate **Capture current Community holders** action scans the server in pages, recording current holders as permanently eligible. It can run while both switches are Off. It does not grant roles by itself; when automatic roles are On, holders can have obsolete Nomad removed.

## Dashboard and access

Admins and Mods with full access may save settings or request a holder capture. Ordinary Mods may view configuration, recent awards/results and progress for a member ID. Authorization, current staff roles, session expiry, revision and action-specific CSRF proof are rechecked server-side. Settings and their audit entry are atomic. Saving settings reevaluates observed members; existing awards are retained.

Choose two distinct ordinary member roles below Maru. Managed integration roles, @everyone, configured staff mappings and roles granting staff powers are rejected. Manage Roles is required. Role permissions and hierarchy are checked again before delivery. Configure thresholds and the excluded message/voice channels with both switches Off during development.

The progress lookup shows only activity Maru has observed or explicitly imported, not lifetime Discord or StatBot totals. Recent role results and permanent awards are also available on the page. Awards and role action intentions/results are written to Recent staff activity; this version does not send an extra Discord-channel announcement for each promotion.

## Intents and activation (later)

No new packages or slash-command registration are required. Apply `015_community_roles.sql` through the existing migration workflow, and deploy with the default switches Off and `COMMUNITY_EVENTS_ENABLED=false`.

When ready for deferred live validation:

1. In the Discord Developer Portal, select the **Maru Test** application, open **Bot**, and enable **Server Members Intent**. Do not change the token.
2. Only after that is saved, set `COMMUNITY_EVENTS_ENABLED=true` on the Railway bot service and redeploy. Maru then requests Guild Members and Guild Voice States in addition to its existing intents. Discord may reject login if the privileged intent is requested before it is enabled/approved for that application.
3. Select the actual Nomad and Community roles, `finished-work`, and any extra AFK channels in **Community roles**. Save the configuration. The server's actual AFK channel is automatically excluded from new voice samples.
4. Capture existing Community holders and verify completion before the eventual StatBot handover. Keep both tracking and role switches Off until the scheduled live acceptance pass.
5. For the eventual cutover, avoid running competing StatBot and Maru activity-role automation. Enable Maru tracking/roles deliberately after preservation and validation are complete.

## Preservation limits — migration is still pending

The capture preserves members who hold Community **when the scan sees them**. It cannot infer former holders who already left, or reconstruct unearned rolling activity. Those require a supplied export or other explicit source of truth. Do not disable StatBot or call progress migration complete yet.

An actual StatBot export must be inspected before writing its importer. Dated message totals and eligible voice intervals are needed to preserve rolling expiration accurately; an undated 30-day summary cannot be expanded into invented message timestamps. The schema reserves an `import` award source, but no fabricated historical activity is inserted by this patch. People already awarded Community can be preserved separately from their unearned activity totals. This remains a release/migration follow-up.

## Timing, persistence and recovery

Message IDs deduplicate creates. Replay older than two minutes and events from before the current configuration or another revision receive no new credit. Historical message scanning is not performed. Existing counted history remains when settings change, and totals apply current channel exclusions and the current window. Permanent awards never expire.

Voice uses observed Gateway state, not microphone/audio capture. Transitions close eligible intervals; periodic checkpoints run about every 15 seconds. Joins, leaves, channel moves, mutes and peer changes close the previous state at observation time. Unknown member identity never counts as human. Unexplained gaps longer than 30 seconds are dropped conservatively. Disconnect, reconnect, unavailable guild, process restart and configuration changes reset the active clock; offline time is never backfilled. Up to one open checkpoint can be lost on a crash or shutdown.

Persisted voice credit uses a per-member watermark under the guild settings lock. Duplicate or overlapping samples from retries or overlapping deployments cannot double-count time. Delayed out-of-order samples may lose credit conservatively. Activity intake is bounded at 5,000 events/samples; already closed samples retry after temporary database failures. Unverifiable message channels receive no credit. Message IDs and voice intervals are retained for up to 90 days to support the maximum configurable window; permanent eligibility is retained separately.

Role work is durable, versioned, server-scoped, and uses the same per-member advisory lock as moderation. Every role mutation has an audit intention before dispatch. Role endpoints update one role at a time. Lost responses are reconciled from fresh member state; later retries recheck the current switches, permissions and roles, and only retry a still-needed idempotent assignment/removal. Off stops further role actions. Capture jobs persist their cursor and resume in pages after restart; changing the selected Community role cancels an incompatible capture.

## Deferred live acceptance

All tester-dependent checks remain deferred until first-release implementation is complete. Automated tests use fake Discord responses and an isolated PostgreSQL-compatible database.

- Validate join -> Nomad, message threshold, voice-only threshold, two-human eligibility, AFK/mute/deafen/solo/bot exclusions, excluded parent/thread channels and rolling expiration.
- Validate add-Community-before-remove-Nomad, permanently earned state, leaving/rejoining, role permission changes and controlled restarts without offline credit.
- Check holder-capture completion, former-holder preservation and the real StatBot export/import before handover.
- Keep the earlier outstanding repeated-message, Discord-invite, Honeypot and manual timeout live checks listed in [honeypot.md](honeypot.md).

References: [Discord Gateway intents](https://docs.discord.com/developers/events/gateway#privileged-intents), [voice state fields](https://docs.discord.com/developers/resources/voice#voice-state-object), [guild member role endpoints](https://docs.discord.com/developers/resources/guild#add-guild-member-role).
