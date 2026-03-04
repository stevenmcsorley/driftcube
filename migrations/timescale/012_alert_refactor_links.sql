CREATE TABLE IF NOT EXISTS alert_refactor_links (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  refactor_id TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_by TEXT NOT NULL DEFAULT 'operator'
);

CREATE UNIQUE INDEX IF NOT EXISTS alert_refactor_links_unique
  ON alert_refactor_links (repo_id, alert_id, refactor_id);

CREATE INDEX IF NOT EXISTS alert_refactor_links_repo_alert
  ON alert_refactor_links (repo_id, alert_id, linked_at DESC);

CREATE INDEX IF NOT EXISTS alert_refactor_links_repo_refactor
  ON alert_refactor_links (repo_id, refactor_id, linked_at DESC);
