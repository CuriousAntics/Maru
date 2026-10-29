CREATE TABLE raid_settings (
 guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id),
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 invite_codes TEXT[] NOT NULL DEFAULT '{}',
 revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
 updated_by TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK (cardinality(invite_codes)<=20)
);
CREATE TABLE raid_runs (
 guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
 run_id UUID NOT NULL,
 actor_id TEXT NOT NULL,
 session_hash TEXT NOT NULL,
 settings_revision INTEGER NOT NULL,
 starts_at TIMESTAMPTZ NOT NULL,
 ends_at TIMESTAMPTZ NOT NULL,
 exclude_community BOOLEAN NOT NULL DEFAULT TRUE,
 delete_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (delete_seconds BETWEEN 0 AND 604800),
 reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
 status TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building','ready','executing','complete','failed','stopped')),
 available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 cursor_id TEXT NOT NULL DEFAULT '0',
 scanned INTEGER NOT NULL DEFAULT 0 CHECK (scanned BETWEEN 0 AND 100000),
 note TEXT NOT NULL DEFAULT 'Building preview; no actions authorized',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '15 minutes',
 confirmed_at TIMESTAMPTZ,
 execution_until TIMESTAMPTZ,
 PRIMARY KEY (guild_id,run_id),
 CHECK (ends_at>=starts_at AND ends_at-starts_at<=INTERVAL '7 days')
);
CREATE TABLE raid_targets (
 guild_id TEXT NOT NULL,
 run_id UUID NOT NULL,
 user_id TEXT NOT NULL,
 display_name TEXT NOT NULL,
 joined_at TIMESTAMPTZ NOT NULL,
 eligible BOOLEAN NOT NULL,
 exclusion TEXT NOT NULL,
 selected BOOLEAN NOT NULL DEFAULT FALSE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applying','applied','skipped','rejected','unconfirmed')),
 note TEXT NOT NULL DEFAULT 'Preview only',
 case_number INTEGER,
 PRIMARY KEY (guild_id,run_id,user_id),
 FOREIGN KEY (guild_id,run_id) REFERENCES raid_runs(guild_id,run_id),
 FOREIGN KEY (guild_id,case_number) REFERENCES moderation_cases(guild_id,case_number)
);
CREATE TABLE raid_invites (
 guild_id TEXT NOT NULL,
 run_id UUID NOT NULL,
 code TEXT NOT NULL,
 channel_id TEXT,
 selected BOOLEAN NOT NULL DEFAULT FALSE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applying','deleted','missing','rejected','unconfirmed')),
 note TEXT NOT NULL DEFAULT 'Preview only',
 PRIMARY KEY (guild_id,run_id,code),
 FOREIGN KEY (guild_id,run_id) REFERENCES raid_runs(guild_id,run_id)
);
CREATE INDEX raid_work_idx ON raid_runs(guild_id,created_at) WHERE status IN ('building','executing');
ALTER TABLE moderation_cases DROP CONSTRAINT moderation_cases_origin_check,
 ADD CONSTRAINT moderation_cases_origin_check CHECK (origin IN ('manual','automod','raid')),
 ADD CONSTRAINT moderation_cases_raid_check CHECK (origin<>'raid' OR (action='ban' AND dm_status='skipped'));
