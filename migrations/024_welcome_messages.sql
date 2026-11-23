CREATE TABLE welcome_settings (
  guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  channel_id TEXT,
  info_channel_id TEXT,
  template TEXT NOT NULL CHECK (length(template) BETWEEN 1 AND 1000),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NOT enabled OR (channel_id IS NOT NULL AND info_channel_id IS NOT NULL))
);
CREATE TABLE welcome_jobs (
  guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL,
  revision INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  info_channel_id TEXT NOT NULL,
  template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','unknown','cancelled')),
  message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (guild_id,user_id,joined_at)
);
CREATE INDEX welcome_pending ON welcome_jobs(guild_id,status,created_at);
