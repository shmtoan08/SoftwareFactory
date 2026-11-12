-- M6C-2: immutable transport receipts bound to authoritative, validated Git imports.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_vci_submission_binding'
    AND conrelid = 'verified_code_imports'::regclass) THEN
    ALTER TABLE verified_code_imports ADD CONSTRAINT uq_vci_submission_binding
      UNIQUE (import_id, project_id, task_id, lease_id, lease_epoch, agent_commit_hash, verified_tree_hash, staging_ref);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS code_import_submissions (
  submission_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  lease_id UUID NOT NULL,
  lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 1),
  import_id UUID NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('bundle', 'patch', 'artifact')),
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  agent_commit_hash TEXT NOT NULL CHECK (agent_commit_hash ~ '^[0-9a-f]{40}$'),
  verified_tree_hash TEXT NOT NULL CHECK (verified_tree_hash ~ '^[0-9a-f]{40}$'),
  staging_ref TEXT NOT NULL,
  submitted_by_principal_id TEXT NOT NULL CHECK (length(btrim(submitted_by_principal_id)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, lease_id),
  FOREIGN KEY (import_id, project_id, task_id, lease_id, lease_epoch, agent_commit_hash, verified_tree_hash, staging_ref)
    REFERENCES verified_code_imports (import_id, project_id, task_id, lease_id, lease_epoch, agent_commit_hash, verified_tree_hash, staging_ref)
    ON DELETE RESTRICT
);
ALTER TABLE code_import_submissions OWNER TO db_migrator;
ALTER TABLE code_import_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_import_submissions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON code_import_submissions FROM PUBLIC;
REVOKE ALL ON code_import_submissions FROM app_runtime;
GRANT SELECT, INSERT ON code_import_submissions TO app_runtime;
DROP POLICY IF EXISTS code_import_submissions_select ON code_import_submissions;
CREATE POLICY code_import_submissions_select ON code_import_submissions FOR SELECT
  USING (project_id = current_app_project_id());
DROP POLICY IF EXISTS code_import_submissions_insert ON code_import_submissions;
CREATE POLICY code_import_submissions_insert ON code_import_submissions FOR INSERT
  WITH CHECK (project_id = current_app_project_id() AND current_app_role() = 'core_api_service');

CREATE OR REPLACE FUNCTION fn_enforce_code_import_submission_lease()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM 1 FROM task_leases l JOIN tasks t ON t.task_id = l.task_id AND t.project_id = l.project_id
    WHERE l.project_id = NEW.project_id AND l.task_id = NEW.task_id AND l.lease_id = NEW.lease_id
      AND l.lease_epoch = NEW.lease_epoch AND t.active_lease_id = l.lease_id
      AND l.status = 'ACTIVE' AND l.revoked_at IS NULL AND l.expires_at > clock_timestamp()
      AND t.status IN ('Leased', 'ExecutingInTarget') FOR UPDATE OF l, t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Code import submission requires the current active, unexpired lease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_code_import_submission_lease ON code_import_submissions;
CREATE TRIGGER trg_code_import_submission_lease BEFORE INSERT ON code_import_submissions
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_code_import_submission_lease();
