BEGIN;
CREATE INDEX IF NOT EXISTS idx_change_requests_project_pending
  ON change_requests USING btree (project_id, created_at DESC, cr_id DESC)
  WHERE status = 'PENDING_APPROVAL';
CREATE INDEX IF NOT EXISTS idx_approval_requests_project_pending
  ON approval_requests USING btree (project_id, created_at DESC, approval_request_id DESC)
  WHERE status = 'PENDING';
COMMIT;
