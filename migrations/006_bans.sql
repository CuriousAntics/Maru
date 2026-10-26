ALTER TABLE moderation_cases
    DROP CONSTRAINT moderation_cases_action_check,
    ADD CONSTRAINT moderation_cases_action_check CHECK (action IN ('warning','timeout','untimeout','ban','unban')),
    ADD COLUMN delete_message_seconds INTEGER,
    DROP CONSTRAINT moderation_cases_timeout_fields_check,
    ADD CONSTRAINT moderation_cases_timeout_fields_check CHECK (
        (action='warning' AND action_status='not_applicable' AND duration_seconds IS NULL AND requested_until IS NULL) OR
        (action='timeout' AND action_status<>'not_applicable' AND duration_seconds IS NOT NULL
         AND duration_seconds BETWEEN 1 AND 2419200 AND requested_until IS NOT NULL) OR
        (action IN ('untimeout','ban','unban') AND action_status<>'not_applicable'
         AND duration_seconds IS NULL AND requested_until IS NULL)
    ),
    ADD CONSTRAINT moderation_cases_ban_fields_check CHECK (
        (action='ban' AND delete_message_seconds IS NOT NULL AND delete_message_seconds BETWEEN 0 AND 604800) OR
        (action<>'ban' AND delete_message_seconds IS NULL)
    );
