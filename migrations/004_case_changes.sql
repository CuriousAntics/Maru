ALTER TABLE moderation_cases
    ADD COLUMN original_reason TEXT,
    ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'void')),
    ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    ADD COLUMN updated_at TIMESTAMPTZ,
    ADD COLUMN last_changed_by TEXT,
    ADD COLUMN void_reason TEXT;

UPDATE moderation_cases SET original_reason = reason, updated_at = created_at;

ALTER TABLE moderation_cases
    ALTER COLUMN original_reason SET NOT NULL,
    ALTER COLUMN updated_at SET NOT NULL,
    ALTER COLUMN updated_at SET DEFAULT NOW(),
    ADD CONSTRAINT moderation_cases_original_reason_check CHECK (char_length(original_reason) BETWEEN 1 AND 500),
    ADD CONSTRAINT moderation_cases_void_reason_check CHECK (
        (state = 'active' AND void_reason IS NULL) OR
        (state = 'void' AND void_reason IS NOT NULL AND char_length(void_reason) BETWEEN 1 AND 500)
    );

-- Keep old bot inserts working during deployment, and preserve the original reason permanently.
CREATE FUNCTION preserve_case_original_reason() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.original_reason := NEW.reason;
    ELSIF NEW.original_reason IS DISTINCT FROM OLD.original_reason THEN
        RAISE EXCEPTION 'ORIGINAL_REASON_IMMUTABLE';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER moderation_cases_original_reason_guard
    BEFORE INSERT OR UPDATE OF original_reason ON moderation_cases
    FOR EACH ROW EXECUTE FUNCTION preserve_case_original_reason();
