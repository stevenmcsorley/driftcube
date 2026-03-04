CREATE INDEX IF NOT EXISTS metrics_repo_key_at ON metrics (repo_id, key, at DESC);
CREATE INDEX IF NOT EXISTS metrics_subject ON metrics (repo_id, scope, subject_id);
CREATE INDEX IF NOT EXISTS metrics_tags_gin ON metrics USING GIN (tags);
CREATE INDEX IF NOT EXISTS alerts_repo_at ON alerts (repo_id, at DESC);
CREATE INDEX IF NOT EXISTS alerts_type ON alerts (repo_id, type, at DESC);

