CREATE TABLE automod_link_settings (
 guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id),
 link_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 link_limit INTEGER NOT NULL DEFAULT 3 CHECK (link_limit BETWEEN 2 AND 50),
 link_window_seconds INTEGER NOT NULL DEFAULT 30 CHECK (link_window_seconds BETWEEN 1 AND 300),
 link_timeout_seconds INTEGER NOT NULL DEFAULT 43200 CHECK (link_timeout_seconds BETWEEN 1 AND 2419200),
 link_enforced_role_ids TEXT[] NOT NULL DEFAULT '{}',
 link_enforced_channel_ids TEXT[] NOT NULL DEFAULT '{}',
 scam_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 scam_timeout_seconds INTEGER NOT NULL DEFAULT 600 CHECK (scam_timeout_seconds BETWEEN 1 AND 2419200),
 scam_enforced_role_ids TEXT[] NOT NULL DEFAULT '{}',
 scam_enforced_channel_ids TEXT[] NOT NULL DEFAULT '{}',
 scam_blocked_domains TEXT[] NOT NULL DEFAULT '{}',
 scam_allowed_domains TEXT[] NOT NULL DEFAULT '{}',
 link_revision INTEGER NOT NULL DEFAULT 1 CHECK (link_revision>0),
 updated_by TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK (cardinality(link_enforced_role_ids)<=100 AND cardinality(link_enforced_channel_ids)<=100 AND cardinality(scam_enforced_role_ids)<=100 AND cardinality(scam_enforced_channel_ids)<=100),
 CHECK (cardinality(scam_blocked_domains)<=100 AND cardinality(scam_allowed_domains)<=100)
);
ALTER TABLE automod_jobs ADD COLUMN link_revision INTEGER, ADD COLUMN link_shared_revision INTEGER, ADD COLUMN scam_revision INTEGER;
CREATE TABLE automod_link_activity (
 guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
 message_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL,
 fingerprints TEXT[] NOT NULL,
 matched_keys TEXT[] NOT NULL,
 matched_entries TEXT[] NOT NULL,
 settings_revision INTEGER NOT NULL,
 shared_revision INTEGER NOT NULL,
 PRIMARY KEY(guild_id,message_id)
);
CREATE INDEX automod_link_window_idx ON automod_link_activity(guild_id,user_id,occurred_at);
ALTER TABLE automod_violations DROP CONSTRAINT automod_violations_rule_key_check,
 ADD CONSTRAINT automod_violations_rule_key_check CHECK (rule_key IN ('blocked_words','rapid_messages','repeated_messages','discord_invites','link_cooldown','scam_links'));
ALTER TABLE automod_counters DROP CONSTRAINT automod_counters_rule_key_check,
 ADD CONSTRAINT automod_counters_rule_key_check CHECK (rule_key IN ('blocked_words','rapid_messages','repeated_messages','discord_invites','link_cooldown','scam_links'));
CREATE TABLE scam_feed_snapshot (
 source TEXT PRIMARY KEY CHECK (source='phishdestroy_primary'),
 domains TEXT[] NOT NULL,
 fetched_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ,
 skipped INTEGER NOT NULL DEFAULT 0,
 CHECK (cardinality(domains) BETWEEN 1 AND 400000)
);
CREATE TABLE automod_link_reviews (
 guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
 message_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 domains TEXT[] NOT NULL,
 reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 log_channel_id TEXT,
 log_status TEXT NOT NULL DEFAULT 'pending' CHECK (log_status IN ('pending','sending','sent','failed','unconfirmed','not_configured','suppressed')),
 log_message_id TEXT,
 PRIMARY KEY(guild_id,message_id)
);
CREATE INDEX automod_link_review_dedupe_idx ON automod_link_reviews(guild_id,user_id,created_at);
