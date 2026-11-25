CREATE TABLE announcements (
  guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id), id UUID NOT NULL,
  title TEXT NOT NULL, channel_id TEXT NOT NULL, payload JSONB NOT NULL,
  schedule JSONB, next_at TIMESTAMPTZ, target_link TEXT,
  state TEXT NOT NULL CHECK(state IN ('draft','active','paused','completed','deleted')),
  revision INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(guild_id,id)
);
CREATE TABLE announcement_files (
  guild_id TEXT NOT NULL, id UUID NOT NULL, post_id UUID NOT NULL, filename TEXT NOT NULL,
  data BYTEA NOT NULL CHECK(octet_length(data)<=10485760),
  PRIMARY KEY(guild_id,id), FOREIGN KEY(guild_id,post_id) REFERENCES announcements(guild_id,id) ON DELETE CASCADE
);
CREATE TABLE announcement_runs (
  guild_id TEXT NOT NULL, id UUID NOT NULL, post_id UUID NOT NULL, revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL, channel_id TEXT NOT NULL, due_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('send','edit')),
  target_id TEXT, expected_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled')),
  message_id TEXT, started_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(guild_id,id), FOREIGN KEY(guild_id,post_id) REFERENCES announcements(guild_id,id),
  UNIQUE(guild_id,post_id,revision,due_at)
);
CREATE INDEX announcements_due ON announcements(guild_id,state,next_at);
CREATE INDEX announcement_runs_pending ON announcement_runs(guild_id,status,due_at);
