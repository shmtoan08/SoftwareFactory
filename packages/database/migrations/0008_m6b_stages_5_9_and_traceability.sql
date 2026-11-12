-- =============================================================================
-- Software Factory v1.5 — Milestone M6B Migration (`0008`)
-- Spec Reference: M6B-SPEC-01 (Stages 5-9, Multi-Target Profiles, CR, AC-11b, Release)
-- Additive & idempotent forward migration preserving `0001`..`0007` invariants.
-- =============================================================================

-- 1. Stage 5: Project Bootstraps (Strictly Append-Only)
CREATE TABLE IF NOT EXISTS project_bootstraps (
  bootstrap_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  pipeline_session_id UUID NOT NULL,
  baseline_id UUID NOT NULL,
  repo_path TEXT NOT NULL CHECK (btrim(repo_path) <> ''),
  trusted_acceptance_dir TEXT NOT NULL CHECK (btrim(trusted_acceptance_dir) <> ''),
  base_main_commit_hash CHAR(40) NOT NULL CHECK (base_main_commit_hash ~ '^[0-9a-f]{40}$'),
  protected_paths_json JSONB NOT NULL CHECK (jsonb_typeof(protected_paths_json) = 'array'),
  trusted_policy_sha256 CHAR(64) NOT NULL CHECK (trusted_policy_sha256 ~ '^[0-9a-f]{64}$'),
  generated_files_json JSONB NOT NULL CHECK (jsonb_typeof(generated_files_json) = 'array'),
  acceptance_tests_json JSONB NOT NULL CHECK (
    jsonb_typeof(acceptance_tests_json) = 'array'
    AND jsonb_array_length(acceptance_tests_json) >= 1
  ),
  bootstrap_sha256 CHAR(64) NOT NULL CHECK (bootstrap_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_principal_id TEXT NOT NULL CHECK (btrim(created_by_principal_id) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_pb_baseline FOREIGN KEY (baseline_id, project_id, pipeline_session_id)
    REFERENCES baseline_spec_freezes (baseline_id, project_id, pipeline_session_id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_pb_id_project UNIQUE (bootstrap_id, project_id),
  CONSTRAINT uq_pb_project_baseline UNIQUE (project_id, baseline_id),
  CONSTRAINT uq_pb_id_project_session UNIQUE (bootstrap_id, project_id, pipeline_session_id)
);

CREATE INDEX IF NOT EXISTS idx_pb_project_session
  ON project_bootstraps (project_id, pipeline_session_id, created_at DESC);

-- 2. Stage 6: Agent Organization & Execution Target Profiles
CREATE TABLE IF NOT EXISTS agent_organization_profiles (
  profile_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  profile_key TEXT NOT NULL CHECK (btrim(profile_key) <> ''),
  role TEXT NOT NULL CHECK (role IN ('PLANNER', 'DEVELOPER', 'REVIEWER_READONLY', 'VERIFIER')),
  principal_id TEXT NOT NULL CHECK (btrim(principal_id) <> ''),
  provider TEXT NOT NULL CHECK (btrim(provider) <> ''),
  model TEXT NOT NULL CHECK (btrim(model) <> ''),
  execution_target_type TEXT NOT NULL CHECK (
    execution_target_type IN (
      'factory_managed_worker',
      'user_managed_worker',
      'provider_managed_vm',
      'remote_agent_session'
    )
  ),
  trust_tier TEXT NOT NULL CHECK (
    trust_tier IN (
      'TIER_1_FACTORY_MANAGED',
      'TIER_2_USER_MANAGED',
      'TIER_3_PROVIDER_VM',
      'TIER_4_REMOTE_SESSION'
    )
  ),
  target_locator TEXT NULL,
  capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities_json) = 'object'),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_principal_id TEXT NOT NULL CHECK (btrim(created_by_principal_id) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_aop_id_project UNIQUE (profile_id, project_id),
  CONSTRAINT uq_aop_project_key UNIQUE (project_id, profile_key),
  CONSTRAINT chk_aop_target_tier_mapping CHECK (
    (execution_target_type = 'factory_managed_worker' AND trust_tier = 'TIER_1_FACTORY_MANAGED')
    OR (execution_target_type = 'user_managed_worker' AND trust_tier = 'TIER_2_USER_MANAGED')
    OR (execution_target_type = 'provider_managed_vm' AND trust_tier = 'TIER_3_PROVIDER_VM')
    OR (execution_target_type = 'remote_agent_session' AND trust_tier = 'TIER_4_REMOTE_SESSION')
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_aop_target_tier_mapping'
      AND conrelid = 'agent_organization_profiles'::regclass
  ) THEN
    ALTER TABLE agent_organization_profiles
      ADD CONSTRAINT chk_aop_target_tier_mapping CHECK (
        (execution_target_type = 'factory_managed_worker' AND trust_tier = 'TIER_1_FACTORY_MANAGED')
        OR (execution_target_type = 'user_managed_worker' AND trust_tier = 'TIER_2_USER_MANAGED')
        OR (execution_target_type = 'provider_managed_vm' AND trust_tier = 'TIER_3_PROVIDER_VM')
        OR (execution_target_type = 'remote_agent_session' AND trust_tier = 'TIER_4_REMOTE_SESSION')
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_aop_project_role
  ON agent_organization_profiles (project_id, role, is_active);

-- 3. Stage 7: Development Plan Hierarchy (Milestones -> Epics -> User Stories)
CREATE TABLE IF NOT EXISTS dev_milestones (
  milestone_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  pipeline_session_id UUID NOT NULL,
  baseline_id UUID NOT NULL,
  milestone_key TEXT NOT NULL CHECK (btrim(milestone_key) <> ''),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  description TEXT NOT NULL,
  sequence_order INTEGER NOT NULL CHECK (sequence_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_dm_baseline FOREIGN KEY (baseline_id, project_id, pipeline_session_id)
    REFERENCES baseline_spec_freezes (baseline_id, project_id, pipeline_session_id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_dm_id_project UNIQUE (milestone_id, project_id),
  CONSTRAINT uq_dm_id_project_session UNIQUE (milestone_id, project_id, pipeline_session_id),
  CONSTRAINT uq_dm_project_baseline_key UNIQUE (project_id, baseline_id, milestone_key)
);

CREATE INDEX IF NOT EXISTS idx_dm_project_session
  ON dev_milestones (project_id, pipeline_session_id, sequence_order);

CREATE TABLE IF NOT EXISTS dev_epics (
  epic_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  milestone_id UUID NOT NULL,
  epic_key TEXT NOT NULL CHECK (btrim(epic_key) <> ''),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  description TEXT NOT NULL,
  sequence_order INTEGER NOT NULL CHECK (sequence_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_de_milestone FOREIGN KEY (milestone_id, project_id)
    REFERENCES dev_milestones (milestone_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_de_id_project UNIQUE (epic_id, project_id),
  CONSTRAINT uq_de_project_milestone_key UNIQUE (project_id, milestone_id, epic_key)
);

CREATE INDEX IF NOT EXISTS idx_de_project_milestone
  ON dev_epics (project_id, milestone_id, sequence_order);

CREATE TABLE IF NOT EXISTS dev_user_stories (
  story_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  epic_id UUID NOT NULL,
  story_key TEXT NOT NULL CHECK (btrim(story_key) <> ''),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  description TEXT NOT NULL,
  requirement_ids_json JSONB NOT NULL CHECK (
    jsonb_typeof(requirement_ids_json) = 'array'
    AND jsonb_array_length(requirement_ids_json) >= 1
  ),
  ac_ids_json JSONB NOT NULL CHECK (
    jsonb_typeof(ac_ids_json) = 'array'
    AND jsonb_array_length(ac_ids_json) >= 1
  ),
  sequence_order INTEGER NOT NULL CHECK (sequence_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_dus_epic FOREIGN KEY (epic_id, project_id)
    REFERENCES dev_epics (epic_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_dus_id_project UNIQUE (story_id, project_id),
  CONSTRAINT uq_dus_project_epic_key UNIQUE (project_id, epic_id, story_key)
);

CREATE INDEX IF NOT EXISTS idx_dus_project_epic
  ON dev_user_stories (project_id, epic_id, sequence_order);

-- 4. Stage 9: Post-Freeze Change Requests
CREATE TABLE IF NOT EXISTS change_requests (
  cr_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  pipeline_session_id UUID NOT NULL,
  baseline_id UUID NOT NULL,
  cr_key TEXT NOT NULL CHECK (btrim(cr_key) <> ''),
  title TEXT NOT NULL CHECK (btrim(title) <> ''),
  rationale TEXT NOT NULL CHECK (btrim(rationale) <> ''),
  impacted_requirement_ids_json JSONB NOT NULL CHECK (
    jsonb_typeof(impacted_requirement_ids_json) = 'array'
    AND jsonb_array_length(impacted_requirement_ids_json) >= 1
  ),
  impacted_component_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(impacted_component_ids_json) = 'array'
  ),
  proposed_tasks_json JSONB NOT NULL CHECK (
    jsonb_typeof(proposed_tasks_json) = 'array'
    AND jsonb_array_length(proposed_tasks_json) >= 1
  ),
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (
    status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'APPLIED')
  ),
  requested_by_principal_id TEXT NOT NULL CHECK (btrim(requested_by_principal_id) <> ''),
  decided_by_principal_id TEXT NULL,
  decision_rationale TEXT NULL,
  decided_at TIMESTAMPTZ NULL,
  applied_by_principal_id TEXT NULL,
  applied_at TIMESTAMPTZ NULL,
  cr_sha256 CHAR(64) NOT NULL CHECK (cr_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_cr_baseline FOREIGN KEY (baseline_id, project_id, pipeline_session_id)
    REFERENCES baseline_spec_freezes (baseline_id, project_id, pipeline_session_id)
    ON DELETE RESTRICT,
  CONSTRAINT uq_cr_id_project UNIQUE (cr_id, project_id),
  CONSTRAINT uq_cr_project_baseline_key UNIQUE (project_id, baseline_id, cr_key),
  CONSTRAINT chk_cr_status_columns CHECK (
    (
      status = 'PENDING_APPROVAL'
      AND decided_by_principal_id IS NULL
      AND decided_at IS NULL
      AND applied_by_principal_id IS NULL
      AND applied_at IS NULL
    )
    OR (
      status IN ('APPROVED', 'REJECTED')
      AND NULLIF(btrim(decided_by_principal_id), '') IS NOT NULL
      AND decided_at IS NOT NULL
      AND applied_by_principal_id IS NULL
      AND applied_at IS NULL
    )
    OR (
      status = 'APPLIED'
      AND NULLIF(btrim(decided_by_principal_id), '') IS NOT NULL
      AND decided_at IS NOT NULL
      AND NULLIF(btrim(applied_by_principal_id), '') IS NOT NULL
      AND applied_at IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_cr_project_session
  ON change_requests (project_id, pipeline_session_id, created_at DESC);

-- 5. Task Plan Links (Bridges Stage 4/5/6/7/9 <-> Stage 8 tasks; Strictly Append-Only)
CREATE TABLE IF NOT EXISTS task_plan_links (
  link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  pipeline_session_id UUID NOT NULL,
  baseline_id UUID NOT NULL,
  bootstrap_id UUID NULL,
  story_id UUID NULL,
  task_id UUID NOT NULL,
  cr_id UUID NULL,
  requirement_ids_json JSONB NOT NULL CHECK (
    jsonb_typeof(requirement_ids_json) = 'array'
    AND jsonb_array_length(requirement_ids_json) >= 1
  ),
  ac_ids_json JSONB NOT NULL CHECK (
    jsonb_typeof(ac_ids_json) = 'array'
    AND jsonb_array_length(ac_ids_json) >= 1
  ),
  assigned_profile_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_tpl_baseline FOREIGN KEY (baseline_id, project_id, pipeline_session_id)
    REFERENCES baseline_spec_freezes (baseline_id, project_id, pipeline_session_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_tpl_task FOREIGN KEY (task_id, project_id)
    REFERENCES tasks (task_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_tpl_bootstrap FOREIGN KEY (bootstrap_id, project_id)
    REFERENCES project_bootstraps (bootstrap_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_tpl_story FOREIGN KEY (story_id, project_id)
    REFERENCES dev_user_stories (story_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_tpl_cr FOREIGN KEY (cr_id, project_id)
    REFERENCES change_requests (cr_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_tpl_profile FOREIGN KEY (assigned_profile_id, project_id)
    REFERENCES agent_organization_profiles (profile_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_tpl_story_or_cr CHECK (story_id IS NOT NULL OR cr_id IS NOT NULL),
  CONSTRAINT uq_tpl_project_task UNIQUE (project_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_tpl_project_session
  ON task_plan_links (project_id, pipeline_session_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_tpl_project_cr
  ON task_plan_links (project_id, cr_id) WHERE cr_id IS NOT NULL;

-- 6. Stage 9: Release Acceptance Packages (Strictly Append-Only, Fail-Closed 100% AC-11b)
CREATE TABLE IF NOT EXISTS release_acceptance_packages (
  release_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  pipeline_session_id UUID NOT NULL,
  baseline_id UUID NOT NULL,
  traceability_sha256 CHAR(64) NOT NULL CHECK (traceability_sha256 ~ '^[0-9a-f]{64}$'),
  coverage_percent NUMERIC(5,2) NOT NULL,
  is_complete BOOLEAN NOT NULL,
  total_requirements INTEGER NOT NULL CHECK (total_requirements >= 1),
  merged_task_ids_json JSONB NOT NULL CHECK (
    jsonb_typeof(merged_task_ids_json) = 'array'
    AND jsonb_array_length(merged_task_ids_json) >= 1
  ),
  applied_cr_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(applied_cr_ids_json) = 'array'
  ),
  main_head_commit_hash CHAR(40) NOT NULL CHECK (main_head_commit_hash ~ '^[0-9a-f]{40}$'),
  summary_markdown TEXT NOT NULL CHECK (btrim(summary_markdown) <> ''),
  package_json JSONB NOT NULL CHECK (jsonb_typeof(package_json) = 'object'),
  package_sha256 CHAR(64) NOT NULL CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_by_principal_id TEXT NOT NULL CHECK (btrim(accepted_by_principal_id) <> ''),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_rap_baseline FOREIGN KEY (baseline_id, project_id, pipeline_session_id)
    REFERENCES baseline_spec_freezes (baseline_id, project_id, pipeline_session_id)
    ON DELETE RESTRICT,
  CONSTRAINT chk_rap_complete_100 CHECK (coverage_percent = 100 AND is_complete = TRUE)
);

CREATE INDEX IF NOT EXISTS idx_rap_project_session
  ON release_acceptance_packages (project_id, pipeline_session_id, accepted_at DESC);

-- 7. DB Integrity & Transition Triggers
CREATE OR REPLACE FUNCTION fn_enforce_baseline_frozen_anchor()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status
  FROM baseline_spec_freezes
  WHERE baseline_id = NEW.baseline_id
    AND project_id = NEW.project_id
    AND pipeline_session_id = NEW.pipeline_session_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Baseline % not found for project % and session %',
      NEW.baseline_id, NEW.project_id, NEW.pipeline_session_id
      USING ERRCODE = '23503';
  END IF;

  IF v_status <> 'FROZEN' THEN
    RAISE EXCEPTION 'Baseline % is in status %; Stages 5-9 require a FROZEN baseline',
      NEW.baseline_id, v_status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_pb_frozen_anchor ON project_bootstraps;
CREATE TRIGGER trg_pb_frozen_anchor
  BEFORE INSERT ON project_bootstraps
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_baseline_frozen_anchor();

DROP TRIGGER IF EXISTS trg_dm_frozen_anchor ON dev_milestones;
CREATE TRIGGER trg_dm_frozen_anchor
  BEFORE INSERT ON dev_milestones
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_baseline_frozen_anchor();

DROP TRIGGER IF EXISTS trg_cr_frozen_anchor ON change_requests;
CREATE TRIGGER trg_cr_frozen_anchor
  BEFORE INSERT ON change_requests
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_baseline_frozen_anchor();

DROP TRIGGER IF EXISTS trg_rap_frozen_anchor ON release_acceptance_packages;
CREATE TRIGGER trg_rap_frozen_anchor
  BEFORE INSERT ON release_acceptance_packages
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_baseline_frozen_anchor();

-- Enforce Change Request one-way workflow & immutable spec fields
CREATE OR REPLACE FUNCTION fn_enforce_change_request_transitions()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.pipeline_session_id IS DISTINCT FROM OLD.pipeline_session_id
    OR NEW.baseline_id IS DISTINCT FROM OLD.baseline_id
    OR NEW.cr_key IS DISTINCT FROM OLD.cr_key
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.rationale IS DISTINCT FROM OLD.rationale
    OR NEW.impacted_requirement_ids_json IS DISTINCT FROM OLD.impacted_requirement_ids_json
    OR NEW.impacted_component_ids_json IS DISTINCT FROM OLD.impacted_component_ids_json
    OR NEW.proposed_tasks_json IS DISTINCT FROM OLD.proposed_tasks_json
    OR NEW.requested_by_principal_id IS DISTINCT FROM OLD.requested_by_principal_id
    OR NEW.cr_sha256 IS DISTINCT FROM OLD.cr_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Immutable columns on change_requests cannot be modified'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'PENDING_APPROVAL' THEN
    IF NEW.status NOT IN ('APPROVED', 'REJECTED') THEN
      RAISE EXCEPTION 'Change Request % must transition from PENDING_APPROVAL to APPROVED or REJECTED (got %)',
        OLD.cr_id, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NEW.applied_by_principal_id IS NOT NULL OR NEW.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'Change Request % cannot set applied metadata during approval decision',
        OLD.cr_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status = 'APPROVED' THEN
    IF NEW.status <> 'APPLIED' THEN
      RAISE EXCEPTION 'APPROVED Change Request % can only transition to APPLIED (got %)',
        OLD.cr_id, NEW.status
        USING ERRCODE = '23514';
    END IF;
    IF NEW.decided_by_principal_id IS DISTINCT FROM OLD.decided_by_principal_id
      OR NEW.decision_rationale IS DISTINCT FROM OLD.decision_rationale
      OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
      RAISE EXCEPTION 'Original approval decision on Change Request % cannot be modified',
        OLD.cr_id
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Change Request % is in terminal status % and cannot transition to %',
      OLD.cr_id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_cr_transitions ON change_requests;
CREATE TRIGGER trg_cr_transitions
  BEFORE UPDATE ON change_requests
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_change_request_transitions();

-- Enforce task_plan_links cross-baseline consistency & APPROVED CR gate
CREATE OR REPLACE FUNCTION fn_enforce_task_plan_link_invariants()
RETURNS TRIGGER AS $$
DECLARE
  v_cr_status TEXT;
  v_cr_baseline UUID;
  v_boot_baseline UUID;
  v_story_baseline UUID;
BEGIN
  IF NEW.bootstrap_id IS NOT NULL THEN
    SELECT baseline_id INTO v_boot_baseline
    FROM project_bootstraps
    WHERE bootstrap_id = NEW.bootstrap_id
      AND project_id = NEW.project_id;
    IF v_boot_baseline IS DISTINCT FROM NEW.baseline_id THEN
      RAISE EXCEPTION 'task_plan_links bootstrap % does not match baseline %',
        NEW.bootstrap_id, NEW.baseline_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.story_id IS NOT NULL THEN
    SELECT m.baseline_id INTO v_story_baseline
    FROM dev_user_stories s
    JOIN dev_epics e ON e.epic_id = s.epic_id AND e.project_id = s.project_id
    JOIN dev_milestones m ON m.milestone_id = e.milestone_id AND m.project_id = e.project_id
    WHERE s.story_id = NEW.story_id
      AND s.project_id = NEW.project_id;
    IF v_story_baseline IS DISTINCT FROM NEW.baseline_id THEN
      RAISE EXCEPTION 'task_plan_links story % does not match baseline %',
        NEW.story_id, NEW.baseline_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.cr_id IS NOT NULL THEN
    SELECT status, baseline_id INTO v_cr_status, v_cr_baseline
    FROM change_requests
    WHERE cr_id = NEW.cr_id
      AND project_id = NEW.project_id;
    IF v_cr_status IS NULL THEN
      RAISE EXCEPTION 'Change Request % not found for project %', NEW.cr_id, NEW.project_id
        USING ERRCODE = '23503';
    END IF;
    IF v_cr_baseline IS DISTINCT FROM NEW.baseline_id THEN
      RAISE EXCEPTION 'task_plan_links Change Request % does not match baseline %',
        NEW.cr_id, NEW.baseline_id
        USING ERRCODE = '23514';
    END IF;
    IF v_cr_status <> 'APPROVED' THEN
      RAISE EXCEPTION 'Change Request % has status %; only APPROVED Change Requests can materialize Stage 8 tasks',
        NEW.cr_id, v_cr_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_tpl_invariants ON task_plan_links;
CREATE TRIGGER trg_tpl_invariants
  BEFORE INSERT ON task_plan_links
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_task_plan_link_invariants();

-- Prevent inserting into agent_organization_profiles with immutable identity changes only if key changes
-- Also enforce tenant RLS across all 8 M6B tables
DO $$
DECLARE
  tbl TEXT;
  m6b_tables TEXT[] := ARRAY[
    'project_bootstraps',
    'agent_organization_profiles',
    'dev_milestones',
    'dev_epics',
    'dev_user_stories',
    'change_requests',
    'task_plan_links',
    'release_acceptance_packages'
  ];
BEGIN
  FOREACH tbl IN ARRAY m6b_tables
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', tbl);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);

    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_select ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I_tenant_select ON %I FOR SELECT USING (project_id = current_app_project_id())',
      tbl, tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_insert ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I_tenant_insert ON %I FOR INSERT WITH CHECK (project_id = current_app_project_id() AND current_app_role() = ''core_api_service'')',
      tbl, tbl
    );
  END LOOP;
END
$$;

DROP POLICY IF EXISTS agent_organization_profiles_tenant_update ON agent_organization_profiles;
CREATE POLICY agent_organization_profiles_tenant_update ON agent_organization_profiles
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  );

DROP POLICY IF EXISTS change_requests_tenant_update ON change_requests;
CREATE POLICY change_requests_tenant_update ON change_requests
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  );

-- Strictly append-only M6B tables (SELECT + INSERT only)
REVOKE UPDATE, DELETE ON
  project_bootstraps,
  dev_milestones,
  dev_epics,
  dev_user_stories,
  task_plan_links,
  release_acceptance_packages
FROM app_runtime;

GRANT SELECT, INSERT ON
  project_bootstraps,
  dev_milestones,
  dev_epics,
  dev_user_stories,
  task_plan_links,
  release_acceptance_packages
TO app_runtime;

-- Column-level least-privilege UPDATE on mutable config & CR workflow tables (NO DELETE)
REVOKE UPDATE, DELETE ON agent_organization_profiles FROM app_runtime;
GRANT SELECT, INSERT, UPDATE (
  role,
  principal_id,
  provider,
  model,
  execution_target_type,
  trust_tier,
  target_locator,
  capabilities_json,
  is_active,
  updated_at
) ON agent_organization_profiles TO app_runtime;

REVOKE UPDATE, DELETE ON change_requests FROM app_runtime;
GRANT SELECT, INSERT, UPDATE (
  status,
  decided_by_principal_id,
  decision_rationale,
  decided_at,
  applied_by_principal_id,
  applied_at,
  updated_at
) ON change_requests TO app_runtime;
