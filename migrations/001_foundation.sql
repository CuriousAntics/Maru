-- Each Discord server gets its own settings.
CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (jsonb_typeof(settings) = 'object')
);

-- Map Discord roles to Maru's access levels.
CREATE TABLE staff_roles (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    role_id TEXT NOT NULL,
    access_level TEXT NOT NULL
        CHECK (access_level IN ('admin', 'moderator')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (guild_id, role_id)
);

-- Record individual grants of full bot-management access.
CREATE TABLE staff_access_grants (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    user_id TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (guild_id, user_id)
);

-- Preserve a history of configuration and access changes.
CREATE TABLE audit_events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    actor_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX audit_events_guild_time_idx
    ON audit_events (guild_id, created_at DESC, event_id DESC);