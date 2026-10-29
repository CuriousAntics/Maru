# Repeated-link cooldown and scam-domain protection

The **Link protection** dashboard page adds two independent save forms. Both protections default **Off**. No package, token, Discord intent or slash-command changes are needed. Apply `017_link_protection.sql` and deploy through the existing workflow. Keep protections Off while live testing remains deferred.

## Link cooldown

The rule detects a member repeatedly posting the same URL, even if the surrounding message text changes. Default: remove the **third and later occurrences within 30 seconds**, across eligible channels. The trigger is configurable from 2–50 occurrences and the rolling repetition window from 1–300 seconds.

Each distinct removed message is one violation. Five link-cooldown violations in a rolling ten-minute window request a native timeout of **12 hours by default**. That punishment is configurable from 1 second to 28 days. A successful timeout resets only that member's link-cooldown violation counter. It does not reset other rules. The short repetition window and the ten-minute punishment counter are different settings/mechanisms.

- Only human message creates add occurrences. Edits and duplicate Gateway events cannot inflate traffic. The same URL appearing several times in one message counts once.
- HTTP(S) URLs and `www` links in message content are recognized. Case-insensitive hostnames, default ports, Unicode domain conversion and standard URL parsing are normalized. Userinfo credentials and fragments are excluded from repetition identity. Scheme, meaningful paths and query strings remain significant. No redirect target is fetched or assumed equivalent.
- Only SHA-256 URL identities are stored in activity history, alongside member/message IDs, timestamps and domain-only match explanations. Full URLs, credentials, paths, query strings and source message text are not copied into this feature's database/audit/log fields.
- Current message content is fetched again before deletion. An edit that removes the matching URL before processing avoids a stale deletion.
- Stored observations survive restarts, expire from the short rolling window and are cleaned up after one hour once no unresolved work needs them. Settings revisions prevent older queued creates from entering a new rule configuration. Creates from before enabling, invalid/future timestamps and replay outside the observation limits do not gain new credit.

## Scam-domain protection

Recognized HTTP(S) / www URLs are compared locally against **PhishDestroy's primary confirmed-domain feed**, plus optional manual blocked hostnames. A known match removes the entire containing message. Five confirmed scam-link violations within ten minutes request the separate configurable scam timeout (default **10 minutes**), using the same durable native-action handling as the other AutoMod rules.

Unverified domains, including domains not listed in the feed, stay in place **under this rule** and generate a review record without a violation, case, timeout or counter increment. “Unlisted” does not mean verified safe, and “review needed” does not assert that someone posted a malicious link. A message containing a confirmed blocked hostname can still be removed even if another hostname in the same message is unverified. Independent rules, including link cooldown, can act on the same message.

Reviews show domain names and the Discord message link, not full submitted URLs. Repeated reviews for the same member and sorted domain set within ten minutes keep individual dashboard records but suppress extra Discord notifications when an earlier notification was sent or is uncertain. Notifications never ping Mods. A duplicate event or edit does not resend the same message's review. A later edit to a known blocked hostname can still produce a distinct violation.

### Feed operation and limits

- Provider documentation: https://api.destroy.tools/ . This implementation uses only the primary feed, not community reports or heuristic risk scores.
- While protection is On, a background worker checks the provider's health and downloads its public primary JSON feed about every 15 minutes. There is no API key. Requests use fixed HTTPS endpoints, reject redirects, have 5/10-second deadlines and 16 KiB/10 MiB body limits. HTTP, schema, health, size and timestamp failures pause feed-based deletion. A validated last successful snapshot is stored in PostgreSQL; classification uses the current process's health-checked in-memory set and requires a new successful check after restart.
- Data older than one hour is not used for deletion. Unknown or unavailable results are reviewed rather than treated as guilty or safe. No feed request is initiated while protection is Off; a request already in progress can finish after disabling, but the moderation worker rechecks its settings before taking action.
- Maru never visits posted sites, follows member URL redirects, sends posted hostnames/URLs to this provider, executes downloaded content, or records provider error bodies. Only the fixed public health/feed endpoints are fetched. The feed is data, not code.
- Matching is exact hostname, with a listed hostname also matching its `www.` variant. Parent listings are not expanded across arbitrary subdomains or shared-hosting tenants. Other subdomains require their own listing or explicit manual block. This conservative behavior can miss threats that a provider's broader domain-inheritance algorithm would catch.
- Add up to 100 plain hostnames each to **Additional blocked hostnames** and **Allowed hostname overrides**, separated by commas or lines. No paths, ports, URLs, IP literals or wildcards are accepted. Domain names are normalized to ASCII for comparisons. An allowed hostname override wins over a feed match, including its www variant. A hostname cannot be both explicitly blocked and allowed in the same save. Manual blocks continue working during feed outages.
- Up to 100 distinct recognized URLs are examined per message. This is a domain reputation check, not a guarantee that a link is safe. Bare domain text without HTTP(S)/www, attachments, embedded redirect targets, disguised hxxp forms and websites that change behavior after posting are outside this version's coverage.

## Configuration, exemptions and recovery

Admins and Mods with full access may save; ordinary Mods may view settings, violations and reviews. Saves require a current session, fresh configured roles, section-specific CSRF proof, a reason and both the link and shared AutoMod revision. Enabling requires a saved moderation log channel, Manage Messages and Moderate Members. Each save preserves the other section and all existing AutoMod settings. No-op saves do not create duplicate audits.

Both rules use the **shared AutoMod exempt roles and ignored channels**, with separate per-rule role/channel overrides on Link protection. A role override cannot defeat an ignored channel, or vice versa. Ignoring a parent channel includes its threads. Removing a shared exemption atomically prunes its link-rule overrides. Shared changes invalidate open link forms. The server owner, bots and webhooks are excluded.

Any link-setting change starts a fresh repeated-link observation revision; shared AutoMod settings changes also restart that observation window. Previously recorded ten-minute violation counters are retained. Disabled, changed or newly exempt rules/targets stop queued unclaimed work. Current source matches are rechecked before deletion. An already claimed native timeout is never blindly resent after a lost response; existing member timeouts are not extended or shortened by a second rule, and unresolved automatic actions block duplicate escalation.

Deletion/timeout intentions, outcomes, cases and logs reuse the established durable AutoMod flow and shared per-member moderation mutex. Audit failures before intentions prevent their external effects. Duplicate events cannot count a message twice for a rule. Lost log responses remain uncertain and do not cause automatic notification replay. Counter reset happens only after a confirmed timeout for that rule. A rule can leave a source message intact while another rule removes it; outcomes are reported independently.

## Deferred live acceptance

All tester-dependent checks remain deferred until first-release implementation is complete. Automated checks use an isolated PostgreSQL-compatible database, fake Discord responses and fake provider responses; they never post to Discord or visit sample scam sites.

Later, use harmless reserved-domain test fixtures/manual blocks in the private development server to verify varied captions, third-occurrence deletion, meaningful query/path differences, source edits, thread/channel/role exemptions, five-violation escalation and the chosen timeout duration. Verify unverified reviews leave messages and create no punishment, manual overrides, feed status/failure behavior, independent saves and controlled restart recovery. Do not open actual scam domains or spam the real community as a test.

Community/StatBot preservation and all earlier deferred checks remain pending. Applying this patch does not authorize a production handover or enable live protections.
