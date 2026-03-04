ALTER TABLE repos
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS repos_archived_created
  ON repos (archived_at, created_at DESC);
