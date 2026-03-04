CREATE TABLE IF NOT EXISTS file_snapshots (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  absolute_path TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  content TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS file_snapshots_repo_file_observed
  ON file_snapshots (repo_id, file_path, observed_at DESC);
