CREATE TABLE forms (
  guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
  id UUID NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 45),
  description TEXT NOT NULL CHECK (length(description) <= 1000),
  questions JSONB NOT NULL CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) BETWEEN 1 AND 25),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id,id)
);
CREATE TABLE form_entries (
  guild_id TEXT NOT NULL,
  id UUID NOT NULL,
  form_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  answers JSONB NOT NULL DEFAULT '[]',
  step INTEGER NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 5),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','pending','approved','rejected')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '24 hours',
  submitted_at TIMESTAMPTZ,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  decision_message TEXT NOT NULL DEFAULT '' CHECK (length(decision_message) <= 1000),
  dm_status TEXT NOT NULL DEFAULT 'none' CHECK (dm_status IN ('none','pending','sending','sent','failed','unknown')),
  dm_started_at TIMESTAMPTZ,
  PRIMARY KEY (guild_id,id),
  FOREIGN KEY (guild_id,form_id) REFERENCES forms(guild_id,id)
);
CREATE UNIQUE INDEX form_one_draft ON form_entries(guild_id,form_id,user_id) WHERE state='draft';
CREATE INDEX form_review_queue ON form_entries(guild_id,state,submitted_at DESC,id);
CREATE TABLE form_files (
  guild_id TEXT NOT NULL,
  id UUID NOT NULL,
  entry_id UUID NOT NULL,
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  data BYTEA NOT NULL CHECK (octet_length(data) <= 10485760),
  PRIMARY KEY (guild_id,id),
  FOREIGN KEY (guild_id,entry_id) REFERENCES form_entries(guild_id,id) ON DELETE CASCADE
);
CREATE TABLE form_steps (
  guild_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  entry_id UUID NOT NULL,
  step INTEGER NOT NULL,
  PRIMARY KEY (guild_id,interaction_id),
  UNIQUE (guild_id,entry_id,step),
  FOREIGN KEY (guild_id,entry_id) REFERENCES form_entries(guild_id,id) ON DELETE CASCADE
);
CREATE TABLE form_publications (
  guild_id TEXT NOT NULL,
  id UUID NOT NULL,
  form_id UUID NOT NULL,
  form_revision INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','unknown')),
  message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  PRIMARY KEY (guild_id,id),
  FOREIGN KEY (guild_id,form_id) REFERENCES forms(guild_id,id)
);
