-- =============================================================================
-- Software Factory v1.5 — MVP Core Schema, Constraints, and 4-Tier RLS Policies
-- Spec Reference: MVP-SPEC-02 (mvp_database_schema_and_rls_specification_v1_5.md)
-- =============================================================================

-- 1. Extensions & Roles
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'db_migrator') THEN
    CREATE ROLE db_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'system_admin_role') THEN
    CREATE ROLE system_admin_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- 2. Helper Functions for RLS Session Context (Fail-Closed Default Deny)
CREATE OR REPLACE FUNCTION current_app_project_id() RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_project_id', true), '')::UUID;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER;

CREATE OR REPLACE FUNCTION current_app_principal_id() RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_principal_id', true), '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER;

CREATE OR REPLACE FUNCTION current_app_role() RETURNS TEXT AS $$
BEGIN
  RETURN COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'anonymous');
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER;

-- 3. Tier 1 — Global System Tables (projects, project_memberships)
CREATE TABLE IF NOT EXISTS projects (
  project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  repo_bare_path TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  approval_ttl_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (approval_ttl_seconds > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS project_memberships (
  membership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  member_role TEXT NOT NULL CHECK (member_role IN ('ORG_ADMIN', 'PROJECT_APPROVER', 'DEVELOPER', 'AUDITOR')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_project_membership UNIQUE (project_id, principal_id)
);

-- 4. Tier 2 & Tier 3 — Core Execution, Lease & Event Protocol Tables
CREATE TABLE IF NOT EXISTS tasks (
  task_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  task_contract_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'Ready',
      'Leased',
      'ExecutingInTarget',
      'BuildingMergeCandidate',
      'VerifyingInDocker',
      'UnderIndependentReview',
      'AwaitingHumanApproval',
      'AtomicCasMerge',
      'MergedAndCompleted',
      'ReworkRequired',
      'ManualIntervention'
    )
  ),
  base_main_commit_hash CHAR(40) NOT NULL,
  current_attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (current_attempt_no >= 0),
  rework_count INTEGER NOT NULL DEFAULT 0 CHECK (rework_count >= 0),
  max_rework_cycles INTEGER NOT NULL DEFAULT 3 CHECK (max_rework_cycles >= 1),
  active_lease_id UUID NULL,
  active_lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (active_lease_epoch >= 0),
  active_merge_candidate_id UUID NULL,
  merged_commit_hash CHAR(40) NULL,
  merged_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_tasks_id_project UNIQUE (task_id, project_id)
);

CREATE TABLE IF NOT EXISTS task_leases (
  lease_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 1),
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'EXPIRED', 'REVOKED')),
  task_execution_idempotency_key CHAR(64) NOT NULL,
  last_processed_seq BIGINT NOT NULL DEFAULT 0 CHECK (last_processed_seq >= 0),
  heartbeat_interval_ms INTEGER NOT NULL DEFAULT 10000 CHECK (heartbeat_interval_ms > 0),
  lease_ttl_ms INTEGER NOT NULL DEFAULT 35000 CHECK (lease_ttl_ms >= heartbeat_interval_ms * 3),
  leased_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoke_reason TEXT NULL,
  completed_at TIMESTAMPTZ NULL,
  CONSTRAINT fk_task_leases_task FOREIGN KEY (task_id, project_id) REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT uq_task_leases_id_project UNIQUE (lease_id, project_id),
  CONSTRAINT uq_task_leases_task_epoch UNIQUE (task_id, lease_epoch),
  CONSTRAINT uq_task_execution_idempotency UNIQUE (project_id, task_execution_idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_lease_per_task
  ON task_leases (task_id)
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS processed_worker_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  lease_id UUID NOT NULL,
  lease_epoch BIGINT NOT NULL,
  sequence_no BIGINT NOT NULL CHECK (sequence_no >= 1),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('task.accepted', 'task.started', 'task.progress', 'task.heartbeat', 'task.completed', 'task.failed')
  ),
  event_idempotency_key CHAR(64) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  payload_json JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_pwe_lease FOREIGN KEY (lease_id, project_id) REFERENCES task_leases(lease_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT uq_pwe_lease_seq UNIQUE (lease_id, sequence_no),
  CONSTRAINT uq_pwe_idempotency_key UNIQUE (project_id, event_idempotency_key)
);

-- 5. Tier 2 & Tier 3 — Import, Candidate, Verification, Review & 8-Field Approval Tables
CREATE TABLE IF NOT EXISTS verified_code_imports (
  import_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  lease_id UUID NOT NULL,
  lease_epoch BIGINT NOT NULL,
  agent_commit_hash CHAR(40) NOT NULL,
  verified_tree_hash CHAR(40) NOT NULL,
  staging_ref TEXT NOT NULL,
  changed_files_count INTEGER NOT NULL CHECK (changed_files_count >= 0),
  deleted_lines_count INTEGER NOT NULL CHECK (deleted_lines_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_vci_task FOREIGN KEY (task_id, project_id) REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_vci_lease FOREIGN KEY (lease_id, project_id) REFERENCES task_leases(lease_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT uq_vci_id_project UNIQUE (import_id, project_id),
  CONSTRAINT uq_vci_lease_commit UNIQUE (lease_id, agent_commit_hash)
);

CREATE TABLE IF NOT EXISTS merge_candidates (
  merge_candidate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  import_id UUID NOT NULL,
  agent_commit_hash CHAR(40) NOT NULL,
  base_main_commit_hash CHAR(40) NOT NULL,
  merge_candidate_hash CHAR(40) NOT NULL,
  verified_tree_hash CHAR(40) NOT NULL,
  is_superseded BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_mc_task FOREIGN KEY (task_id, project_id) REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mc_import FOREIGN KEY (import_id, project_id) REFERENCES verified_code_imports(import_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT uq_mc_id_project UNIQUE (merge_candidate_id, project_id),
  CONSTRAINT uq_mc_composite_binding UNIQUE (
    merge_candidate_id, project_id, task_id, agent_commit_hash,
    base_main_commit_hash, merge_candidate_hash, verified_tree_hash
  )
);

CREATE TABLE IF NOT EXISTS verification_runs (
  verification_run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  merge_candidate_id UUID NOT NULL,
  merge_candidate_hash CHAR(40) NOT NULL,
  verified_tree_hash CHAR(40) NOT NULL,
  verifier_image_digest TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('PASS', 'FAIL')),
  exit_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  report_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_vr_candidate FOREIGN KEY (merge_candidate_id, project_id) REFERENCES merge_candidates(merge_candidate_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT uq_vr_binding UNIQUE (
    verification_run_id, project_id, task_id, merge_candidate_id, merge_candidate_hash, verified_tree_hash
  )
);

CREATE TABLE IF NOT EXISTS review_artifacts (
  review_artifact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  merge_candidate_id UUID NOT NULL,
  verification_run_id UUID NOT NULL,
  merge_candidate_hash CHAR(40) NOT NULL,
  verified_tree_hash CHAR(40) NOT NULL,
  writer_provider TEXT NOT NULL,
  writer_model TEXT NOT NULL,
  reviewer_provider TEXT NOT NULL,
  reviewer_model TEXT NOT NULL,
  developer_principal_id TEXT NOT NULL,
  reviewer_principal_id TEXT NOT NULL,
  developer_session_id TEXT NOT NULL,
  reviewer_session_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('PASS', 'FAIL')),
  is_invalidated BOOLEAN NOT NULL DEFAULT FALSE,
  invalidated_reason TEXT NULL,
  findings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_independent_reviewer_model CHECK (
    (lower(btrim(writer_provider)), lower(btrim(writer_model))) IS DISTINCT FROM
    (lower(btrim(reviewer_provider)), lower(btrim(reviewer_model)))
  ),
  CONSTRAINT chk_independent_reviewer_principal CHECK (
    NULLIF(btrim(developer_principal_id), '') IS NOT NULL
    AND NULLIF(btrim(reviewer_principal_id), '') IS NOT NULL
    AND lower(btrim(developer_principal_id)) IS DISTINCT FROM lower(btrim(reviewer_principal_id))
  ),
  CONSTRAINT chk_independent_reviewer_session CHECK (
    NULLIF(btrim(developer_session_id), '') IS NOT NULL
    AND NULLIF(btrim(reviewer_session_id), '') IS NOT NULL
    AND btrim(developer_session_id) IS DISTINCT FROM btrim(reviewer_session_id)
  ),
  CONSTRAINT fk_ra_verification FOREIGN KEY (
    verification_run_id, project_id, task_id, merge_candidate_id, merge_candidate_hash, verified_tree_hash
  ) REFERENCES verification_runs(
    verification_run_id, project_id, task_id, merge_candidate_id, merge_candidate_hash, verified_tree_hash
  ) ON DELETE RESTRICT,
  CONSTRAINT uq_ra_binding UNIQUE (
    review_artifact_id, project_id, task_id, merge_candidate_id,
    verification_run_id, merge_candidate_hash, verified_tree_hash
  )
);

CREATE TABLE IF NOT EXISTS approval_decisions (
  approval_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  merge_candidate_id UUID NOT NULL,
  agent_commit_hash CHAR(40) NOT NULL,
  base_main_commit_hash CHAR(40) NOT NULL,
  verified_tree_hash CHAR(40) NOT NULL,
  merge_candidate_hash CHAR(40) NOT NULL,
  verification_run_id UUID NOT NULL,
  review_artifact_id UUID NOT NULL,
  approver_principal_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED', 'REQUEST_CHANGES')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'INVALIDATED', 'EXPIRED')),
  invalidated_reason TEXT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  CONSTRAINT chk_approval_ttl_window CHECK (expires_at > approved_at),
  CONSTRAINT fk_ad_candidate_8fields FOREIGN KEY (
    merge_candidate_id, project_id, task_id, agent_commit_hash,
    base_main_commit_hash, merge_candidate_hash, verified_tree_hash
  ) REFERENCES merge_candidates(
    merge_candidate_id, project_id, task_id, agent_commit_hash,
    base_main_commit_hash, merge_candidate_hash, verified_tree_hash
  ) ON DELETE RESTRICT,
  CONSTRAINT fk_ad_review_binding FOREIGN KEY (
    review_artifact_id, project_id, task_id, merge_candidate_id,
    verification_run_id, merge_candidate_hash, verified_tree_hash
  ) REFERENCES review_artifacts(
    review_artifact_id, project_id, task_id, merge_candidate_id,
    verification_run_id, merge_candidate_hash, verified_tree_hash
  ) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_approval_per_candidate
  ON approval_decisions (merge_candidate_id)
  WHERE status = 'ACTIVE';

-- 6. Tier 4 — System Operational Outbox & Audit Log Tables
CREATE TABLE IF NOT EXISTS outbox_events (
  outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  published_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL,
  principal_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- 7. Narrow SECURITY DEFINER Reconciler Discovery Helper (MVP-SPEC-02 Section 3)
CREATE OR REPLACE FUNCTION list_expired_active_lease_scopes(batch_limit INTEGER DEFAULT 50)
RETURNS TABLE (project_id UUID, lease_id UUID, task_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT l.project_id, l.lease_id, l.task_id
  FROM task_leases l
  WHERE l.status = 'ACTIVE'
    AND l.expires_at <= clock_timestamp()
  ORDER BY l.expires_at ASC
  LIMIT batch_limit;
$$;

REVOKE ALL ON FUNCTION list_expired_active_lease_scopes(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_expired_active_lease_scopes(INTEGER) TO app_runtime;

-- 8. Enable and FORCE Row-Level Security on All 12 Tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

ALTER TABLE project_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_memberships FORCE ROW LEVEL SECURITY;

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

ALTER TABLE task_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_leases FORCE ROW LEVEL SECURITY;

ALTER TABLE processed_worker_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_worker_events FORCE ROW LEVEL SECURITY;

ALTER TABLE verified_code_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE verified_code_imports FORCE ROW LEVEL SECURITY;

ALTER TABLE merge_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_candidates FORCE ROW LEVEL SECURITY;

ALTER TABLE verification_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_runs FORCE ROW LEVEL SECURITY;

ALTER TABLE review_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_artifacts FORCE ROW LEVEL SECURITY;

ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions FORCE ROW LEVEL SECURITY;

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- 9. 4-Tier RLS Policies (MVP-SPEC-02 Section 3)
-- Tier 1: projects & project_memberships
DROP POLICY IF EXISTS projects_select_policy ON projects;
CREATE POLICY projects_select_policy ON projects
  FOR SELECT
  USING (
    current_app_role() = 'system_admin_role'
    OR (
      project_id = current_app_project_id()
      AND (
        current_app_role() IN ('core_api_service', 'gateway_service')
        OR EXISTS (
          SELECT 1 FROM project_memberships pm
          WHERE pm.project_id = projects.project_id
            AND pm.principal_id = current_app_principal_id()
        )
      )
    )
  );

DROP POLICY IF EXISTS projects_write_policy ON projects;
CREATE POLICY projects_write_policy ON projects
  FOR ALL
  USING (current_app_role() = 'system_admin_role')
  WITH CHECK (current_app_role() = 'system_admin_role');

DROP POLICY IF EXISTS memberships_select_policy ON project_memberships;
CREATE POLICY memberships_select_policy ON project_memberships
  FOR SELECT
  USING (
    current_app_role() = 'system_admin_role'
    OR project_id = current_app_project_id()
  );

DROP POLICY IF EXISTS memberships_write_policy ON project_memberships;
CREATE POLICY memberships_write_policy ON project_memberships
  FOR ALL
  USING (current_app_role() = 'system_admin_role')
  WITH CHECK (current_app_role() = 'system_admin_role');

-- Tier 2: tasks, task_leases, verified_code_imports, merge_candidates
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['tasks', 'task_leases', 'verified_code_imports', 'merge_candidates']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation_select ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation_select ON %I FOR SELECT USING (project_id = current_app_project_id())',
      tbl, tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation_write ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation_write ON %I FOR ALL USING (project_id = current_app_project_id() AND current_app_role() IN (''core_api_service'', ''gateway_service'')) WITH CHECK (project_id = current_app_project_id() AND current_app_role() IN (''core_api_service'', ''gateway_service''))',
      tbl, tbl
    );
  END LOOP;
END
$$;

-- Tier 3: Append-Only Evidence Tables (processed_worker_events, verification_runs, review_artifacts, approval_decisions)
-- SELECT + INSERT allowed for matching project_id; UPDATE restricted only to status/invalidation columns on review_artifacts & approval_decisions; DELETE forbidden
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['processed_worker_events', 'verification_runs', 'review_artifacts', 'approval_decisions']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_evidence_select ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I_evidence_select ON %I FOR SELECT USING (project_id = current_app_project_id())',
      tbl, tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS %I_evidence_insert ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I_evidence_insert ON %I FOR INSERT WITH CHECK (project_id = current_app_project_id() AND current_app_role() IN (''core_api_service'', ''gateway_service''))',
      tbl, tbl
    );
  END LOOP;
END
$$;

DROP POLICY IF EXISTS review_artifacts_invalidate_update ON review_artifacts;
CREATE POLICY review_artifacts_invalidate_update ON review_artifacts
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  );

DROP POLICY IF EXISTS approval_decisions_lifecycle_update ON approval_decisions;
CREATE POLICY approval_decisions_lifecycle_update ON approval_decisions
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  );

-- Tier 4: outbox_events & audit_logs
DROP POLICY IF EXISTS outbox_select_policy ON outbox_events;
CREATE POLICY outbox_select_policy ON outbox_events
  FOR SELECT
  USING (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service', 'outbox_relay_service')
  );

DROP POLICY IF EXISTS outbox_insert_policy ON outbox_events;
CREATE POLICY outbox_insert_policy ON outbox_events
  FOR INSERT
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  );

DROP POLICY IF EXISTS outbox_update_published_policy ON outbox_events;
CREATE POLICY outbox_update_published_policy ON outbox_events
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'outbox_relay_service')
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'outbox_relay_service')
  );

DROP POLICY IF EXISTS audit_logs_select_policy ON audit_logs;
CREATE POLICY audit_logs_select_policy ON audit_logs
  FOR SELECT
  USING (project_id = current_app_project_id());

DROP POLICY IF EXISTS audit_logs_insert_policy ON audit_logs;
CREATE POLICY audit_logs_insert_policy ON audit_logs
  FOR INSERT
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  );

-- 10. Explicit Table Grants for app_runtime (No DELETE on Tier 3 / Audit Logs)
GRANT SELECT, INSERT, UPDATE ON
  projects, project_memberships, tasks, task_leases,
  verified_code_imports, merge_candidates, outbox_events
TO app_runtime;

GRANT SELECT, INSERT ON
  processed_worker_events, verification_runs, audit_logs
TO app_runtime;

GRANT SELECT, INSERT, UPDATE (is_invalidated, invalidated_reason) ON review_artifacts TO app_runtime;
GRANT SELECT, INSERT, UPDATE (status, invalidated_reason, consumed_at) ON approval_decisions TO app_runtime;
