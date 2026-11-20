CREATE TABLE custom_commands (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    name TEXT NOT NULL CHECK (name ~ '^[a-z0-9_-]{1,32}$'),
    description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 100),
    response TEXT NOT NULL CHECK (length(response) BETWEEN 1 AND 2000),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    discord_id TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','running','synced','error')),
    sync_note TEXT NOT NULL DEFAULT 'Waiting to synchronize',
    sync_started_at TIMESTAMPTZ,
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id,name),
    CHECK (NOT deleted OR NOT enabled)
);
CREATE UNIQUE INDEX custom_commands_discord_id ON custom_commands(guild_id,discord_id) WHERE discord_id IS NOT NULL;
