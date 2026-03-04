CREATE TABLE IF NOT EXISTS refactor_suggestions (
  repo_id TEXT NOT NULL,
  id TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  scope TEXT NOT NULL,
  target TEXT NOT NULL,
  type TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  impact JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  plan JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'proposed',
  PRIMARY KEY (repo_id, id)
);

CREATE INDEX IF NOT EXISTS refactor_suggestions_repo_at
  ON refactor_suggestions (repo_id, at DESC);

CREATE INDEX IF NOT EXISTS refactor_suggestions_repo_type
  ON refactor_suggestions (repo_id, type, at DESC);
