ALTER TABLE moderation_cases
    DROP CONSTRAINT moderation_cases_action_check,
    ADD CONSTRAINT moderation_cases_action_check CHECK (action IN ('warning', 'timeout', 'untimeout')),
    ADD COLUMN action_status TEXT NOT NULL DEFAULT 'not_applicable'
        CHECK (action_status IN ('not_applicable', 'pending', 'applying', 'applied', 'rejected', 'unconfirmed')),
    ADD COLUMN duration_seconds INTEGER,
    ADD COLUMN requested_until TIMESTAMPTZ,
    ADD COLUMN previous_until TIMESTAMPTZ,
    ADD COLUMN action_attempted_at TIMESTAMPTZ,
    ADD COLUMN action_completed_at TIMESTAMPTZ,
    ADD COLUMN action_error TEXT,
    ADD COLUMN notification_claimed_at TIMESTAMPTZ,
    ADD CONSTRAINT moderation_cases_native_read_only CHECK (
        action='warning' OR (state='active' AND revision=0 AND reason=original_reason AND void_reason IS NULL)
    ),
    DROP CONSTRAINT moderation_cases_dm_status_check,
    ADD CONSTRAINT moderation_cases_dm_status_check
        CHECK (dm_status IN ('pending', 'sending', 'sent', 'failed', 'unconfirmed', 'skipped')),
    ADD CONSTRAINT moderation_cases_timeout_fields_check CHECK (
        (action = 'warning' AND action_status = 'not_applicable' AND duration_seconds IS NULL AND requested_until IS NULL) OR
        (action = 'timeout' AND action_status <> 'not_applicable' AND duration_seconds IS NOT NULL
         AND duration_seconds BETWEEN 1 AND 2419200 AND requested_until IS NOT NULL) OR
        (action = 'untimeout' AND action_status <> 'not_applicable' AND duration_seconds IS NULL AND requested_until IS NULL)
    );

-- Existing notification attempts must never be replayed by the new claim mechanism.
UPDATE moderation_cases SET notification_claimed_at = created_at
WHERE dm_status <> 'pending' OR log_status NOT IN ('pending', 'not_configured');
