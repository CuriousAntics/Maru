ALTER TABLE automod_settings
    ADD COLUMN spam_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN spam_limit INTEGER NOT NULL DEFAULT 5 CHECK (spam_limit BETWEEN 2 AND 50),
    ADD COLUMN spam_window_seconds INTEGER NOT NULL DEFAULT 5 CHECK (spam_window_seconds BETWEEN 1 AND 60),
    ADD COLUMN spam_timeout_seconds INTEGER NOT NULL DEFAULT 600 CHECK (spam_timeout_seconds BETWEEN 1 AND 2419200),
    ADD COLUMN spam_enforced_role_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN spam_enforced_channel_ids TEXT[] NOT NULL DEFAULT '{}',
    ADD CHECK (cardinality(spam_enforced_role_ids)<=100 AND cardinality(spam_enforced_channel_ids)<=100),
    ADD CHECK (spam_enforced_role_ids<@exempt_role_ids AND spam_enforced_channel_ids<@ignored_channel_ids);
ALTER TABLE automod_jobs ADD COLUMN is_create BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN created_at TIMESTAMPTZ, ADD COLUMN spam_revision INTEGER;
ALTER TABLE automod_violations DROP CONSTRAINT automod_violations_rule_key_check;
ALTER TABLE automod_violations ADD CHECK (rule_key IN ('blocked_words','rapid_messages'));
ALTER TABLE automod_counters DROP CONSTRAINT automod_counters_rule_key_check;
ALTER TABLE automod_counters ADD CHECK (rule_key IN ('blocked_words','rapid_messages'));
CREATE TABLE automod_message_activity (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    observed_count INTEGER NOT NULL,
    message_limit INTEGER NOT NULL,
    window_seconds INTEGER NOT NULL,
    settings_revision INTEGER NOT NULL,
    PRIMARY KEY (guild_id,message_id)
);
CREATE INDEX automod_message_activity_window ON automod_message_activity(guild_id,user_id,occurred_at);
