ALTER TABLE starboard_boards
    ADD COLUMN deleted_at TIMESTAMPTZ,
    ADD COLUMN deleted_by TEXT,
    ADD COLUMN delete_reason TEXT,
    ADD COLUMN delete_remove_highlights BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT starboard_board_deletion_check CHECK (
        (deleted_at IS NULL AND deleted_by IS NULL AND delete_reason IS NULL AND NOT delete_remove_highlights) OR
        (deleted_at IS NOT NULL AND NOT enabled AND deleted_by IS NOT NULL AND delete_reason IS NOT NULL
         AND char_length(btrim(delete_reason)) BETWEEN 1 AND 500)
    );
DROP INDEX starboard_board_names_idx;
CREATE UNIQUE INDEX starboard_board_names_idx ON starboard_boards (guild_id,lower(name)) WHERE deleted_at IS NULL;
ALTER TABLE starboard_posts ADD COLUMN retained_post_message_id TEXT;

-- Retain an immutable configuration tombstone for audit and safe worker cleanup.
CREATE FUNCTION protect_deleted_starboard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'STARBOARD_DELETED_READ_ONLY';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER starboard_deleted_read_only BEFORE UPDATE ON starboard_boards
    FOR EACH ROW EXECUTE FUNCTION protect_deleted_starboard();
