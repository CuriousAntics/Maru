CREATE TABLE community_settings (
 guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id),
 tracking_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 roles_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 nomad_role_id TEXT,
 community_role_id TEXT,
 excluded_channel_ids TEXT[] NOT NULL DEFAULT '{}',
 afk_channel_ids TEXT[] NOT NULL DEFAULT '{}',
 message_threshold INTEGER NOT NULL DEFAULT 30 CHECK (message_threshold BETWEEN 1 AND 100000),
 voice_seconds INTEGER NOT NULL DEFAULT 6000 CHECK (voice_seconds BETWEEN 1 AND 7776000),
 window_days INTEGER NOT NULL DEFAULT 30 CHECK (window_days BETWEEN 1 AND 90),
 revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
 updated_by TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK (cardinality(excluded_channel_ids)<=100 AND cardinality(afk_channel_ids)<=100),
 CHECK (NOT roles_enabled OR (nomad_role_id IS NOT NULL AND community_role_id IS NOT NULL AND nomad_role_id<>community_role_id))
);
CREATE TABLE community_members (
 guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
 user_id TEXT NOT NULL,
 earned_at TIMESTAMPTZ,
 earned_source TEXT CHECK (earned_source IN ('messages','voice','existing_role','import')),
 voice_until TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
 PRIMARY KEY (guild_id,user_id),
 CHECK ((earned_at IS NULL)=(earned_source IS NULL))
);
CREATE FUNCTION community_permanence_guard() RETURNS trigger AS $$
BEGIN
 IF OLD.earned_at IS NOT NULL AND (NEW.earned_at IS DISTINCT FROM OLD.earned_at OR NEW.earned_source IS DISTINCT FROM OLD.earned_source) THEN
  RAISE EXCEPTION 'COMMUNITY_IS_PERMANENT';
 END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER community_permanence BEFORE UPDATE ON community_members FOR EACH ROW EXECUTE FUNCTION community_permanence_guard();
CREATE TABLE community_messages (
 guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
 message_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 parent_id TEXT,
 occurred_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(guild_id,message_id)
);
CREATE INDEX community_message_window_idx ON community_messages(guild_id,user_id,occurred_at);
CREATE TABLE community_voice (
 guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
 user_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL,
 ended_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(guild_id,user_id,started_at),
 CHECK (ended_at>started_at)
);
CREATE INDEX community_voice_window_idx ON community_voice(guild_id,user_id,ended_at);
CREATE TABLE community_role_jobs (
 guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
 user_id TEXT NOT NULL,
 version BIGINT NOT NULL DEFAULT 1,
 processed_version BIGINT NOT NULL DEFAULT 0,
 available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 note TEXT NOT NULL DEFAULT 'Queued',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(guild_id,user_id)
);
CREATE TABLE community_capture (
 guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id),
 role_id TEXT NOT NULL,
 requested_by TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','complete','cancelled')),
 cursor_id TEXT NOT NULL DEFAULT '0',
 captured INTEGER NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX community_message_cleanup_idx ON community_messages(guild_id,occurred_at);
CREATE INDEX community_voice_cleanup_idx ON community_voice(guild_id,ended_at);
