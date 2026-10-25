-- Browser tokens are random secrets. Only their SHA-256 hashes are stored.
CREATE TABLE dashboard_login_attempts (
    token_hash TEXT PRIMARY KEY,
    state_hash TEXT NOT NULL,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX dashboard_login_attempts_expiry_idx
    ON dashboard_login_attempts (expires_at);

CREATE TABLE dashboard_sessions (
    token_hash TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX dashboard_sessions_expiry_idx
    ON dashboard_sessions (expires_at);
