CREATE TABLE IF NOT EXISTS surface_activity (
  event_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  file_path TEXT NOT NULL,
  absolute_path TEXT,
  language TEXT,
  change_type TEXT NOT NULL,
  parser_status TEXT NOT NULL DEFAULT 'pending',
  symbol_count INT NOT NULL DEFAULT 0,
  alert_count INT NOT NULL DEFAULT 0,
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS surface_activity_repo_at
  ON surface_activity (repo_id, at DESC);

CREATE INDEX IF NOT EXISTS surface_activity_repo_file
  ON surface_activity (repo_id, file_path, at DESC);
