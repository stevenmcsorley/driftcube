CREATE TABLE IF NOT EXISTS incidents (
  repo_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  type TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  opened_sha TEXT,
  closed_sha TEXT,
  opened_alert_title TEXT,
  latest_alert_title TEXT,
  pre_signature JSONB,
  latest_signature JSONB,
  post_signature JSONB,
  resolution JSONB,
  PRIMARY KEY (repo_id, incident_id)
);

CREATE INDEX IF NOT EXISTS incidents_repo_status_opened
  ON incidents (repo_id, status, opened_at DESC);

CREATE INDEX IF NOT EXISTS incidents_repo_subject_type
  ON incidents (repo_id, type, scope, subject_id, status, opened_at DESC);
