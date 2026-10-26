CREATE TABLE starboard_boards (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id),
    board_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (name=btrim(name) AND char_length(name) BETWEEN 1 AND 60),
    destination_channel_id TEXT NOT NULL CHECK (destination_channel_id ~ '^[0-9]{17,20}$'),
    emoji TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 100),
    emoji_key TEXT NOT NULL CHECK (char_length(emoji_key) BETWEEN 1 AND 120),
    threshold INTEGER NOT NULL CHECK (threshold BETWEEN 1 AND 1000),
    source_channel_ids TEXT[] NOT NULL CHECK (cardinality(source_channel_ids) BETWEEN 1 AND 100
        AND array_ndims(source_channel_ids)=1 AND array_position(source_channel_ids,NULL) IS NULL
        AND NOT (destination_channel_id=ANY(source_channel_ids))),
    allow_crosspost BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision>=0),
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id,board_id)
);
CREATE UNIQUE INDEX starboard_board_names_idx ON starboard_boards (guild_id,lower(name));
