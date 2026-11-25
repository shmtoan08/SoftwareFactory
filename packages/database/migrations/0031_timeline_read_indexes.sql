BEGIN;
CREATE INDEX IF NOT EXISTS idx_stage_artifacts_timeline
  ON stage_artifacts USING btree (project_id, pipeline_session_id, created_at DESC, artifact_id DESC);
CREATE INDEX IF NOT EXISTS idx_stage_approval_gates_timeline
  ON stage_approval_gates USING btree (project_id, pipeline_session_id, decided_at DESC, gate_id DESC);
CREATE INDEX IF NOT EXISTS idx_change_requests_decided_timeline
  ON change_requests USING btree (project_id, pipeline_session_id, decided_at DESC, cr_id DESC)
  WHERE decided_at IS NOT NULL;
COMMIT;
