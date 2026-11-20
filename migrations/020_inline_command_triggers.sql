ALTER TABLE custom_commands ADD COLUMN inline_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE inline_command_jobs (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    command_name TEXT NOT NULL,
    revision INTEGER NOT NULL,
    event_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','skipped','failed','unconfirmed')),
    note TEXT NOT NULL DEFAULT 'Queued',
    claimed_at TIMESTAMPTZ,
    response_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id,message_id)
);
CREATE INDEX inline_command_pending ON inline_command_jobs(guild_id,created_at) WHERE status='pending';
CREATE TABLE inline_command_cooldowns (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    user_id TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (guild_id,user_id)
);
