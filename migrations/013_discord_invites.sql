ALTER TABLE automod_settings
    ADD COLUMN invite_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN invite_timeout_seconds INTEGER NOT NULL DEFAULT 600 CHECK (invite_timeout_seconds BETWEEN 1 AND 2419200),
    ADD COLUMN invite_allowed_guild_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN invite_enforced_role_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN invite_enforced_channel_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD CHECK (cardinality(invite_allowed_guild_ids)<=100 AND cardinality(invite_enforced_role_ids)<=100 AND cardinality(invite_enforced_channel_ids)<=100),
    ADD CHECK (invite_enforced_role_ids<@exempt_role_ids AND invite_enforced_channel_ids<@ignored_channel_ids);
ALTER TABLE automod_violations DROP CONSTRAINT automod_violations_rule_key_check;
ALTER TABLE automod_violations ADD CHECK (rule_key IN ('blocked_words','rapid_messages','repeated_messages','discord_invites'));
ALTER TABLE automod_counters DROP CONSTRAINT automod_counters_rule_key_check;
ALTER TABLE automod_counters ADD CHECK (rule_key IN ('blocked_words','rapid_messages','repeated_messages','discord_invites'));
CREATE TABLE automod_invite_reviews (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    invite_codes TEXT[] NOT NULL CHECK (cardinality(invite_codes) BETWEEN 1 AND 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    log_channel_id TEXT,
    log_status TEXT NOT NULL CHECK (log_status IN ('pending','sending','sent','failed','unconfirmed','not_configured')),
    log_message_id TEXT,
    PRIMARY KEY (guild_id,message_id)
);
