CREATE TABLE IF NOT EXISTS architecture_snapshots (
  repo_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  signature JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (repo_id, sha, scope, subject_id)
);

CREATE INDEX IF NOT EXISTS architecture_snapshots_repo_scope_at
  ON architecture_snapshots (repo_id, scope, at DESC);

CREATE INDEX IF NOT EXISTS architecture_snapshots_repo_subject_at
  ON architecture_snapshots (repo_id, scope, subject_id, at DESC);
