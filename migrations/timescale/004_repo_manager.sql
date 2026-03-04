ALTER TABLE repos
  ADD COLUMN IF NOT EXISTS host_path TEXT,
  ADD COLUMN IF NOT EXISTS watch_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS watch_state TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS watch_error TEXT;

UPDATE repos
SET watch_enabled = COALESCE(watch_enabled, TRUE),
    watch_state = CASE
      WHEN kind = 'local' AND root_path IS NOT NULL THEN 'pending'
      ELSE 'inactive'
    END
WHERE watch_state IS NULL
   OR watch_state = '';

UPDATE repos
SET watch_state = 'inactive'
WHERE kind = 'remote'
  AND root_path IS NULL;
