CREATE TABLE chat_clear_settings (
    guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    channel_id TEXT,
    interval_hours INTEGER NOT NULL DEFAULT 6 CHECK (interval_hours BETWEEN 1 AND 720),
    next_run_at TIMESTAMPTZ,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_by TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (NOT enabled OR (channel_id IS NOT NULL AND next_run_at IS NOT NULL))
);
CREATE TABLE chat_clear_runs (
    run_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    channel_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    cutoff_id TEXT NOT NULL,
    cursor_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','cancelled')),
    removed_or_absent INTEGER NOT NULL DEFAULT 0,
    preserved INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT 'Clearing',
    retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX chat_clear_one_active ON chat_clear_runs(guild_id) WHERE status='running';
CREATE INDEX chat_clear_history ON chat_clear_runs(guild_id,run_id DESC);
CREATE TABLE chat_clear_notices (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    revision INTEGER NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    seconds_before INTEGER NOT NULL CHECK (seconds_before IN (300,60,10)),
    status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','unconfirmed','cancelled')),
    message_id TEXT,
    PRIMARY KEY (guild_id,revision,scheduled_at,seconds_before)
);
