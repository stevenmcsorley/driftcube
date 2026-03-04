ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS resolved_by TEXT;

ALTER TABLE alerts
ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE alerts
SET status = COALESCE(status, 'open'),
    status_updated_at = COALESCE(status_updated_at, at)
WHERE status IS NULL
   OR status_updated_at IS NULL;

CREATE INDEX IF NOT EXISTS alerts_repo_status_at
  ON alerts (repo_id, status, at DESC);

CREATE INDEX IF NOT EXISTS alerts_status_at
  ON alerts (status, at DESC);
