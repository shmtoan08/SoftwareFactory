BEGIN;
CREATE INDEX IF NOT EXISTS idx_change_requests_submitted_timeline
  ON change_requests USING btree (project_id, pipeline_session_id, created_at DESC, cr_id DESC);
COMMIT;
