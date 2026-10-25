CREATE TABLE guild_case_counters (
    guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id),
    last_case_number INTEGER NOT NULL DEFAULT 0 CHECK (last_case_number >= 0)
);

CREATE TABLE moderation_cases (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    case_number INTEGER NOT NULL CHECK (case_number > 0),
    request_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('warning')),
    actor_id TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
    guild_name TEXT NOT NULL,
    log_channel_id TEXT,
    dm_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (dm_status IN ('pending', 'sending', 'sent', 'failed', 'unconfirmed')),
    log_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (log_status IN ('pending', 'sending', 'sent', 'failed', 'unconfirmed', 'not_configured')),
    dm_message_id TEXT,
    log_message_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, case_number),
    UNIQUE (guild_id, request_id)
);

CREATE INDEX moderation_cases_member_idx
    ON moderation_cases (guild_id, target_user_id, case_number DESC);
