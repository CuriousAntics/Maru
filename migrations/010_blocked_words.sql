CREATE TABLE automod_settings (
    guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id),
    blocked_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    blocked_words TEXT[] NOT NULL DEFAULT '{}',
    timeout_seconds INTEGER NOT NULL DEFAULT 600 CHECK (timeout_seconds BETWEEN 1 AND 2419200),
    exempt_role_ids TEXT[] NOT NULL DEFAULT '{}',
    ignored_channel_ids TEXT[] NOT NULL DEFAULT '{}',
    enforced_role_ids TEXT[] NOT NULL DEFAULT '{}',
    enforced_channel_ids TEXT[] NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (cardinality(blocked_words)<=100 AND (NOT blocked_enabled OR cardinality(blocked_words)>0)),
    CHECK (cardinality(exempt_role_ids)<=100 AND cardinality(ignored_channel_ids)<=100),
    CHECK (enforced_role_ids<@exempt_role_ids AND enforced_channel_ids<@ignored_channel_ids)
);
CREATE TABLE automod_jobs (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version BIGINT NOT NULL DEFAULT 1,
    processed_version BIGINT NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (guild_id,message_id)
);
CREATE INDEX automod_jobs_due_idx ON automod_jobs (guild_id,available_at) WHERE version>processed_version;
ALTER TABLE moderation_cases ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','automod'));
CREATE TABLE automod_violations (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    rule_key TEXT NOT NULL DEFAULT 'blocked_words' CHECK (rule_key='blocked_words'),
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    parent_channel_id TEXT,
    user_id TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    matched_entries TEXT[] NOT NULL,
    delete_status TEXT NOT NULL DEFAULT 'pending' CHECK (delete_status IN ('pending','deleting','removed')),
    violation_count INTEGER NOT NULL DEFAULT 0,
    counted_at TIMESTAMPTZ,
    escalation_evaluated BOOLEAN NOT NULL DEFAULT FALSE,
    case_number INTEGER,
    timeout_note TEXT NOT NULL DEFAULT 'Threshold not reached',
    log_channel_id TEXT,
    log_status TEXT NOT NULL DEFAULT 'pending' CHECK (log_status IN ('pending','sending','sent','failed','unconfirmed','not_configured')),
    log_message_id TEXT,
    PRIMARY KEY (guild_id,rule_key,message_id),
    FOREIGN KEY (guild_id,case_number) REFERENCES moderation_cases(guild_id,case_number)
);
CREATE INDEX automod_window_idx ON automod_violations (guild_id,user_id,rule_key,occurred_at);
CREATE TABLE automod_counters (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    user_id TEXT NOT NULL,
    rule_key TEXT NOT NULL DEFAULT 'blocked_words' CHECK (rule_key='blocked_words'),
    reset_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
    last_attempt_at TIMESTAMPTZ,
    pending_case_number INTEGER,
    PRIMARY KEY (guild_id,user_id,rule_key),
    FOREIGN KEY (guild_id,pending_case_number) REFERENCES moderation_cases(guild_id,case_number)
);
