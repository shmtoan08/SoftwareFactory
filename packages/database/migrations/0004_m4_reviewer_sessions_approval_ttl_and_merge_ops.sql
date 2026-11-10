-- =============================================================================
-- Software Factory v1.5 — Milestone M4: 3D Reviewer Sessions, Approval TTL,
--                         Idempotent Atomic CAS Merge Operations & RLS
-- Spec Reference: MVP-SPEC-02, MVP-SPEC-04 §§3-5, Roadmap Milestone M4
-- =============================================================================

-- 1. Independent Reviewer Ephemeral Sessions (`review_sessions`)
CREATE TABLE IF NOT EXISTS review_sessions (
  review_session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  merge_candidate_id UUID NOT NULL,
  verification_run_id UUID NOT NULL,
  reviewer_principal_id TEXT NOT NULL CHECK (NULLIF(btrim(reviewer_principal_id), '') IS NOT NULL),
  reviewer_credential_id TEXT NOT NULL CHECK (NULLIF(btrim(reviewer_credential_id), '') IS NOT NULL),
  reviewer_agent_profile_id TEXT NOT NULL CHECK (NULLIF(btrim(reviewer_agent_profile_id), '') IS NOT NULL),
  reviewer_provider TEXT NOT NULL CHECK (NULLIF(btrim(reviewer_provider), '') IS NOT NULL),
  reviewer_model TEXT NOT NULL CHECK (NULLIF(btrim(reviewer_model), '') IS NOT NULL),
  role TEXT NOT NULL CHECK (role = 'ROLE_REVIEWER_READONLY'),
  sandbox_backend_mode TEXT NOT NULL,
  sandbox_pid INTEGER NULL,
  sandbox_cgroup_path TEXT NULL,
  cleanup_populated_zero_verified BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'FAILED', 'REVOKED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ NULL,
  CONSTRAINT fk_rs_task FOREIGN KEY (task_id, project_id) REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_rs_candidate FOREIGN KEY (merge_candidate_id, project_id) REFERENCES merge_candidates(merge_candidate_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT uq_rs_id_project UNIQUE (review_session_id, project_id)
);

-- 2. Extend review_artifacts with credential/agent_profile dimensions, status, Markdown & SHA-256
ALTER TABLE review_artifacts
  ADD COLUMN IF NOT EXISTS review_session_id UUID NULL,
  ADD COLUMN IF NOT EXISTS developer_credential_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS reviewer_credential_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS developer_agent_profile_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS reviewer_agent_profile_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'VALID',
  ADD COLUMN IF NOT EXISTS summary_markdown TEXT NULL,
  ADD COLUMN IF NOT EXISTS report_sha256 CHAR(64) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ra_status'
  ) THEN
    ALTER TABLE review_artifacts
      ADD CONSTRAINT chk_ra_status
      CHECK (status IN ('VALID', 'INVALIDATED_STALE_CANDIDATE', 'INVALIDATED_STALE_BASE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ra_independent_credential'
  ) THEN
    ALTER TABLE review_artifacts
      ADD CONSTRAINT chk_ra_independent_credential
      CHECK (
        (developer_credential_id IS NULL AND reviewer_credential_id IS NULL)
        OR (
          NULLIF(btrim(developer_credential_id), '') IS NOT NULL
          AND NULLIF(btrim(reviewer_credential_id), '') IS NOT NULL
          AND btrim(developer_credential_id) IS DISTINCT FROM btrim(reviewer_credential_id)
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ra_independent_agent_profile'
  ) THEN
    ALTER TABLE review_artifacts
      ADD CONSTRAINT chk_ra_independent_agent_profile
      CHECK (
        (developer_agent_profile_id IS NULL AND reviewer_agent_profile_id IS NULL)
        OR (
          NULLIF(btrim(developer_agent_profile_id), '') IS NOT NULL
          AND NULLIF(btrim(reviewer_agent_profile_id), '') IS NOT NULL
          AND lower(btrim(developer_agent_profile_id)) IS DISTINCT FROM lower(btrim(reviewer_agent_profile_id))
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ra_report_sha256_hex'
  ) THEN
    ALTER TABLE review_artifacts
      ADD CONSTRAINT chk_ra_report_sha256_hex
      CHECK (report_sha256 IS NULL OR report_sha256 ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ra_review_session'
  ) THEN
    ALTER TABLE review_artifacts
      ADD CONSTRAINT fk_ra_review_session
      FOREIGN KEY (review_session_id, project_id)
      REFERENCES review_sessions(review_session_id, project_id) ON DELETE RESTRICT;
  END IF;
END
$$;

-- 3. Approval Requests Table with TTL Window & 8-Field Candidate/Review Foreign Key Binding
CREATE TABLE IF NOT EXISTS approval_requests (
  approval_request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  merge_candidate_id UUID NOT NULL,
  agent_commit_hash CHAR(40) NOT NULL,
  base_main_commit_hash CHAR(40) NOT NULL,
  merge_candidate_hash CHAR(40) NOT NULL,
  verified_tree_hash CHAR(40) NOT NULL,
  verification_run_id UUID NOT NULL,
  review_artifact_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING',
      'APPROVED',
      'REJECTED',
      'INVALIDATED_EXPIRED',
      'INVALIDATED_STALE_BASE',
      'INVALIDATED_STALE_CANDIDATE'
    )
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_ar_ttl_window CHECK (expires_at > created_at),
  CONSTRAINT uq_ar_id_project UNIQUE (approval_request_id, project_id),
  CONSTRAINT fk_ar_candidate_8fields FOREIGN KEY (
    merge_candidate_id, project_id, task_id, agent_commit_hash,
    base_main_commit_hash, merge_candidate_hash, verified_tree_hash
  ) REFERENCES merge_candidates(
    merge_candidate_id, project_id, task_id, agent_commit_hash,
    base_main_commit_hash, merge_candidate_hash, verified_tree_hash
  ) ON DELETE RESTRICT,
  CONSTRAINT fk_ar_review_binding FOREIGN KEY (
    review_artifact_id, project_id, task_id, merge_candidate_id,
    verification_run_id, merge_candidate_hash, verified_tree_hash
  ) REFERENCES review_artifacts(
    review_artifact_id, project_id, task_id, merge_candidate_id,
    verification_run_id, merge_candidate_hash, verified_tree_hash
  ) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pending_approval_request_per_candidate
  ON approval_requests (merge_candidate_id)
  WHERE status = 'PENDING';

-- 4. Link approval_decisions back to approval_requests & allow composite FK from merge_operations
ALTER TABLE approval_decisions
  ADD COLUMN IF NOT EXISTS approval_request_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_ad_id_project'
  ) THEN
    ALTER TABLE approval_decisions
      ADD CONSTRAINT uq_ad_id_project UNIQUE (approval_id, project_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ad_approval_request'
  ) THEN
    ALTER TABLE approval_decisions
      ADD CONSTRAINT fk_ad_approval_request
      FOREIGN KEY (approval_request_id, project_id)
      REFERENCES approval_requests(approval_request_id, project_id) ON DELETE RESTRICT;
  END IF;
END
$$;

-- 5. Idempotent Atomic CAS Merge Operations Table (`merge_operations`)
CREATE TABLE IF NOT EXISTS merge_operations (
  merge_op_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  merge_candidate_id UUID NOT NULL,
  approval_id UUID NOT NULL,
  merge_idempotency_key TEXT NOT NULL,
  base_main_commit_hash CHAR(40) NOT NULL,
  merge_candidate_hash CHAR(40) NOT NULL,
  verified_tree_hash CHAR(40) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'MERGED', 'CAS_CONFLICT_ABORTED')),
  reconciled_after_lost_response BOOLEAN NOT NULL DEFAULT FALSE,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ NULL,
  CONSTRAINT uq_mo_idempotency UNIQUE (project_id, merge_idempotency_key),
  CONSTRAINT fk_mo_approval FOREIGN KEY (approval_id, project_id)
    REFERENCES approval_decisions(approval_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mo_candidate FOREIGN KEY (merge_candidate_id, project_id)
    REFERENCES merge_candidates(merge_candidate_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mo_task FOREIGN KEY (task_id, project_id)
    REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT
);

-- 6. Enable & FORCE Row-Level Security + Tenant Policies + Explicit Grants
ALTER TABLE review_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;

ALTER TABLE merge_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_operations FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['review_sessions', 'approval_requests', 'merge_operations']
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

GRANT SELECT, INSERT, UPDATE ON
  review_sessions, approval_requests, merge_operations
TO app_runtime;

GRANT UPDATE (status, is_invalidated, invalidated_reason) ON review_artifacts TO app_runtime;
