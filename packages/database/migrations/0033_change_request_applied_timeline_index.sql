BEGIN;
CREATE INDEX IF NOT EXISTS idx_change_requests_applied_timeline
  ON change_requests USING btree (project_id, pipeline_session_id, applied_at DESC, cr_id DESC)
  WHERE applied_at IS NOT NULL;
COMMIT;
