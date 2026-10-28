CREATE TABLE honeypot_settings (
    guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    channel_ids TEXT[] NOT NULL DEFAULT '{}',
    exempt_role_ids TEXT[] NOT NULL DEFAULT '{}',
    warning_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (cardinality(channel_ids)<=20 AND cardinality(exempt_role_ids)<=100),
    CHECK (NOT enabled OR (cardinality(channel_ids)>0 AND warning_confirmed))
);
ALTER TABLE moderation_cases
    DROP CONSTRAINT moderation_cases_action_check,
    ADD CONSTRAINT moderation_cases_action_check CHECK (action IN ('warning','timeout','untimeout','ban','unban','softban')),
    DROP CONSTRAINT moderation_cases_timeout_fields_check,
    ADD CONSTRAINT moderation_cases_timeout_fields_check CHECK (
        (action='warning' AND action_status='not_applicable' AND duration_seconds IS NULL AND requested_until IS NULL) OR
        (action='timeout' AND action_status<>'not_applicable' AND duration_seconds BETWEEN 1 AND 2419200 AND duration_seconds IS NOT NULL AND requested_until IS NOT NULL) OR
        (action IN ('untimeout','ban','unban','softban') AND action_status<>'not_applicable' AND duration_seconds IS NULL AND requested_until IS NULL)
    ),
    DROP CONSTRAINT moderation_cases_ban_fields_check,
    ADD CONSTRAINT moderation_cases_ban_fields_check CHECK (
        (action='ban' AND delete_message_seconds IS NOT NULL AND delete_message_seconds BETWEEN 0 AND 604800) OR
        (action='softban' AND delete_message_seconds IS NOT NULL AND delete_message_seconds=86400 AND origin='automod' AND dm_status='skipped') OR
        (action NOT IN ('ban','softban') AND delete_message_seconds IS NULL)
    );
CREATE TABLE honeypot_events (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    settings_revision INTEGER NOT NULL,
    marker TEXT NOT NULL UNIQUE,
    case_number INTEGER,
    ban_status TEXT NOT NULL DEFAULT 'pending' CHECK (ban_status IN ('pending','applying','applied','rejected','unconfirmed','skipped')),
    unban_status TEXT NOT NULL DEFAULT 'pending' CHECK (unban_status IN ('pending','applying','applied','rejected','unconfirmed','skipped')),
    note TEXT NOT NULL DEFAULT 'Queued',
    done BOOLEAN NOT NULL DEFAULT FALSE,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id,message_id),
    FOREIGN KEY (guild_id,case_number) REFERENCES moderation_cases(guild_id,case_number)
);
CREATE INDEX honeypot_due_idx ON honeypot_events(guild_id,available_at) WHERE NOT done;
