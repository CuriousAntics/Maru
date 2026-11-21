ALTER TABLE form_entries
  ADD COLUMN username TEXT CHECK (username IS NULL OR length(username) BETWEEN 1 AND 100),
  ADD COLUMN display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 100),
  ADD COLUMN identity_source TEXT CHECK (identity_source IS NULL OR identity_source IN ('submission','lookup')),
  ADD COLUMN name_lookup_after TIMESTAMPTZ NOT NULL DEFAULT 'epoch';
