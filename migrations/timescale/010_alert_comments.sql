CREATE TABLE IF NOT EXISTS alert_comments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  author TEXT NOT NULL DEFAULT 'operator',
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_comments_repo_alert_created
  ON alert_comments (repo_id, alert_id, created_at DESC);
