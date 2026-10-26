CREATE TABLE starboard_jobs (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    source_channel_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    version BIGINT NOT NULL DEFAULT 1,
    processed_version BIGINT NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    PRIMARY KEY (guild_id,source_message_id)
);
CREATE INDEX starboard_jobs_due_idx ON starboard_jobs (guild_id,available_at) WHERE version>processed_version;
CREATE INDEX starboard_jobs_sweep_idx ON starboard_jobs (guild_id,checked_at);

CREATE TABLE starboard_posts (
    guild_id TEXT NOT NULL,
    board_id UUID NOT NULL,
    source_channel_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    destination_channel_id TEXT NOT NULL,
    post_message_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('absent','creating','posted','deleting')),
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation>0),
    marker TEXT NOT NULL,
    body_hash TEXT,
    last_error TEXT,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id,board_id,source_message_id),
    FOREIGN KEY (guild_id,board_id) REFERENCES starboard_boards(guild_id,board_id),
    CHECK ((state IN ('posted','deleting') AND post_message_id IS NOT NULL) OR state IN ('absent','creating'))
);
CREATE UNIQUE INDEX starboard_post_message_idx ON starboard_posts (guild_id,post_message_id) WHERE post_message_id IS NOT NULL;
