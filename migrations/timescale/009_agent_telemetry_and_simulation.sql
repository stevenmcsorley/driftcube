CREATE TABLE IF NOT EXISTS agent_telemetry (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  absolute_path TEXT,
  provenance TEXT NOT NULL,
  source TEXT NOT NULL,
  editor TEXT,
  session_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_telemetry_repo_file_observed
  ON agent_telemetry (repo_id, file_path, observed_at DESC);

CREATE INDEX IF NOT EXISTS agent_telemetry_repo_absolute_observed
  ON agent_telemetry (repo_id, absolute_path, observed_at DESC);

ALTER TABLE surface_activity
  ADD COLUMN IF NOT EXISTS provenance TEXT,
  ADD COLUMN IF NOT EXISTS telemetry_source TEXT,
  ADD COLUMN IF NOT EXISTS telemetry_editor TEXT,
  ADD COLUMN IF NOT EXISTS telemetry_session_id TEXT;

ALTER TABLE refactor_suggestions
  ADD COLUMN IF NOT EXISTS simulation JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS refactor_suggestions_repo_status
  ON refactor_suggestions (repo_id, status, at DESC);
