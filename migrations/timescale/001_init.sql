CREATE TABLE IF NOT EXISTS repos (
  repo_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  host_path TEXT,
  root_path TEXT,
  remote_url TEXT,
  default_branch TEXT NOT NULL,
  watch_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  watch_state TEXT NOT NULL DEFAULT 'pending',
  watch_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commits (
  repo_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  parent_sha TEXT,
  author TEXT,
  message TEXT,
  ts TIMESTAMPTZ NOT NULL,
  provenance_hint TEXT,
  PRIMARY KEY (repo_id, sha)
);

CREATE TABLE IF NOT EXISTS metrics (
  repo_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  scope TEXT NOT NULL,
  subject_id TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  tags JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (repo_id, sha, at, scope, subject_id, key)
);

CREATE TABLE IF NOT EXISTS alerts (
  repo_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  severity TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence JSONB NOT NULL,
  recommendation TEXT,
  PRIMARY KEY (repo_id, sha, at, type, title)
);

CREATE TABLE IF NOT EXISTS gates (
  repo_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (repo_id, gate_id)
);
