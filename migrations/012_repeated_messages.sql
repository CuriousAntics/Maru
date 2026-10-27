ALTER TABLE automod_settings
    ADD COLUMN repeat_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN repeat_text BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN repeat_images BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN repeat_limit INTEGER NOT NULL DEFAULT 3 CHECK (repeat_limit BETWEEN 2 AND 50),
    ADD COLUMN repeat_window_seconds INTEGER NOT NULL DEFAULT 30 CHECK (repeat_window_seconds BETWEEN 1 AND 300),
    ADD COLUMN repeat_timeout_seconds INTEGER NOT NULL DEFAULT 600 CHECK (repeat_timeout_seconds BETWEEN 1 AND 2419200),
    ADD COLUMN repeat_enforced_role_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN repeat_enforced_channel_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD CHECK (NOT repeat_enabled OR repeat_text OR repeat_images),
    ADD CHECK (cardinality(repeat_enforced_role_ids)<=100 AND cardinality(repeat_enforced_channel_ids)<=100),
    ADD CHECK (repeat_enforced_role_ids<@exempt_role_ids AND repeat_enforced_channel_ids<@ignored_channel_ids);
ALTER TABLE automod_jobs ADD COLUMN repeat_revision INTEGER;
ALTER TABLE automod_violations DROP CONSTRAINT automod_violations_rule_key_check;
ALTER TABLE automod_violations ADD CHECK (rule_key IN ('blocked_words','rapid_messages','repeated_messages'));
ALTER TABLE automod_counters DROP CONSTRAINT automod_counters_rule_key_check;
ALTER TABLE automod_counters ADD CHECK (rule_key IN ('blocked_words','rapid_messages','repeated_messages'));
CREATE TABLE automod_repeat_activity (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    fingerprints TEXT[] NOT NULL,
    matched_keys TEXT[] NOT NULL,
    matched_entries TEXT[] NOT NULL,
    image_status TEXT NOT NULL CHECK (image_status IN ('not_present','checked','partly_skipped')),
    settings_revision INTEGER NOT NULL,
    PRIMARY KEY (guild_id,message_id)
);
CREATE INDEX automod_repeat_activity_window ON automod_repeat_activity(guild_id,user_id,occurred_at);
