-- =============================================================================
-- Software Factory v1.5 — Milestone M6C-1 Migration (`0009`)
-- Spec Reference: M6C-SPEC-01 (Task DAG Dependencies, Serialized CAS Merge Queue,
--   Project/Task Budget Auto-Pause AC-12c, and 038d19a Bootstrapper Uniqueness)
-- Additive & idempotent forward migration preserving `0001`..`0008` invariants.
-- =============================================================================

-- 1. Hardening existing tables (038d19a Minor Note #3 + composite FK bindings)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_pb_trusted_acceptance_dir'
      AND conrelid = 'project_bootstraps'::regclass
  ) THEN
    ALTER TABLE project_bootstraps
      ADD CONSTRAINT uq_pb_trusted_acceptance_dir UNIQUE (trusted_acceptance_dir);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_mc_id_project_task'
      AND conrelid = 'merge_candidates'::regclass
  ) THEN
    ALTER TABLE merge_candidates
      ADD CONSTRAINT uq_mc_id_project_task UNIQUE (merge_candidate_id, project_id, task_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_ad_id_project_task_candidate'
      AND conrelid = 'approval_decisions'::regclass
  ) THEN
    ALTER TABLE approval_decisions
      ADD CONSTRAINT uq_ad_id_project_task_candidate
      UNIQUE (approval_id, project_id, task_id, merge_candidate_id);
  END IF;
END
$$;

-- 2. Task DAG Dependencies (Strictly Append-Only + Recursive Acyclicity Guard)
CREATE TABLE IF NOT EXISTS task_dependencies (
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  task_id UUID NOT NULL,
  depends_on_task_id UUID NOT NULL,
  dependency_kind TEXT NOT NULL DEFAULT 'PLAN_DAG' CHECK (
    dependency_kind IN ('PLAN_DAG', 'PATH_OVERLAP_SERIALIZED', 'MANUAL')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, task_id, depends_on_task_id),
  CONSTRAINT chk_td_no_self_loop CHECK (task_id <> depends_on_task_id),
  CONSTRAINT fk_td_task FOREIGN KEY (task_id, project_id)
    REFERENCES tasks (task_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_td_depends_on FOREIGN KEY (depends_on_task_id, project_id)
    REFERENCES tasks (task_id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_td_project_depends_on
  ON task_dependencies (project_id, depends_on_task_id);

CREATE OR REPLACE FUNCTION fn_prevent_task_dependency_cycle()
RETURNS TRIGGER AS $$
DECLARE
  v_creates_cycle BOOLEAN := FALSE;
BEGIN
  -- Serialize graph edits with lease dispatch, including direct SQL clients.
  PERFORM pg_advisory_xact_lock(hashtext('lease-dispatch:' || NEW.project_id::text));
  IF NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = NEW.project_id
      AND task_id = NEW.task_id AND status IN ('Ready', 'ReworkRequired')) THEN
    RAISE EXCEPTION 'Dependencies can only be added before task dispatch' USING ERRCODE = '23514';
  END IF;

  IF NEW.task_id = NEW.depends_on_task_id THEN
    RAISE EXCEPTION 'Task % cannot depend on itself', NEW.task_id
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE upstream(node_id) AS (
    SELECT NEW.depends_on_task_id
    UNION
    SELECT td.depends_on_task_id
    FROM task_dependencies td
    JOIN upstream u ON td.task_id = u.node_id
    WHERE td.project_id = NEW.project_id
  )
  SELECT EXISTS (
    SELECT 1 FROM upstream WHERE node_id = NEW.task_id
  ) INTO v_creates_cycle;

  IF v_creates_cycle THEN
    RAISE EXCEPTION 'Task dependency edge (% -> %) creates a dependency cycle',
      NEW.task_id, NEW.depends_on_task_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_td_prevent_cycle ON task_dependencies;
CREATE TRIGGER trg_td_prevent_cycle
  BEFORE INSERT ON task_dependencies
  FOR EACH ROW
  EXECUTE FUNCTION fn_prevent_task_dependency_cycle();

-- 3. Per-Project Serialized Atomic CAS Merge Queue (`merge_queue_entries`)
CREATE TABLE IF NOT EXISTS merge_queue_entries (
  queue_entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  task_id UUID NOT NULL,
  merge_candidate_id UUID NOT NULL,
  approval_id UUID NOT NULL,
  queue_position BIGSERIAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (
    status IN ('QUEUED', 'PROCESSING', 'MERGED', 'REBASED_NEEDS_REVERIFY', 'FAILED', 'CANCELLED')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  rebased_from_candidate_id UUID NULL,
  rebased_to_candidate_id UUID NULL,
  merged_commit_hash CHAR(40) NULL CHECK (
    merged_commit_hash IS NULL OR merged_commit_hash ~ '^[0-9a-f]{40}$'
  ),
  last_error TEXT NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_mqe_task FOREIGN KEY (task_id, project_id)
    REFERENCES tasks (task_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mqe_candidate FOREIGN KEY (merge_candidate_id, project_id, task_id)
    REFERENCES merge_candidates (merge_candidate_id, project_id, task_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mqe_approval FOREIGN KEY (approval_id, project_id, task_id, merge_candidate_id)
    REFERENCES approval_decisions (approval_id, project_id, task_id, merge_candidate_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mqe_rebased_from FOREIGN KEY (rebased_from_candidate_id, project_id, task_id)
    REFERENCES merge_candidates (merge_candidate_id, project_id, task_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mqe_rebased_to FOREIGN KEY (rebased_to_candidate_id, project_id, task_id)
    REFERENCES merge_candidates (merge_candidate_id, project_id, task_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mqe_active_task_per_project
  ON merge_queue_entries (project_id, task_id)
  WHERE status IN ('QUEUED', 'PROCESSING');

CREATE UNIQUE INDEX IF NOT EXISTS uq_mqe_processing_per_project
  ON merge_queue_entries (project_id) WHERE status = 'PROCESSING';

CREATE INDEX IF NOT EXISTS idx_mqe_project_fifo
  ON merge_queue_entries (project_id, queue_position ASC);

CREATE OR REPLACE FUNCTION fn_enforce_merge_queue_entry_invariants()
RETURNS TRIGGER AS $$
DECLARE
  v_decision TEXT;
  v_status TEXT;
BEGIN
  SELECT decision, status INTO v_decision, v_status
  FROM approval_decisions
  WHERE approval_id = NEW.approval_id
    AND project_id = NEW.project_id
    AND task_id = NEW.task_id
    AND merge_candidate_id = NEW.merge_candidate_id;

  IF v_decision IS NULL THEN
    RAISE EXCEPTION 'Approval % not found for task % and candidate %',
      NEW.approval_id, NEW.task_id, NEW.merge_candidate_id
      USING ERRCODE = '23503';
  END IF;

  IF v_decision <> 'APPROVED' OR v_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Cannot enqueue merge candidate %: approval % has decision=% status=%',
      NEW.merge_candidate_id, NEW.approval_id, v_decision, v_status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_mqe_insert_invariants ON merge_queue_entries;
CREATE TRIGGER trg_mqe_insert_invariants
  BEFORE INSERT ON merge_queue_entries
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_merge_queue_entry_invariants();

-- 4. Project & Task Budget Enforcement + Auto-Pause (`AC-12c`)
CREATE TABLE IF NOT EXISTS project_budget_policies (
  project_id UUID PRIMARY KEY REFERENCES projects(project_id) ON DELETE RESTRICT,
  max_project_tokens BIGINT NULL CHECK (max_project_tokens IS NULL OR max_project_tokens > 0),
  max_project_cost_micro_usd BIGINT NULL CHECK (max_project_cost_micro_usd IS NULL OR max_project_cost_micro_usd > 0),
  max_project_wall_time_ms BIGINT NULL CHECK (max_project_wall_time_ms IS NULL OR max_project_wall_time_ms > 0),
  default_task_max_tokens BIGINT NULL CHECK (default_task_max_tokens IS NULL OR default_task_max_tokens > 0),
  default_task_max_cost_micro_usd BIGINT NULL CHECK (default_task_max_cost_micro_usd IS NULL OR default_task_max_cost_micro_usd > 0),
  default_task_max_wall_time_ms BIGINT NULL CHECK (default_task_max_wall_time_ms IS NULL OR default_task_max_wall_time_ms > 0),
  max_concurrent_tasks INTEGER NOT NULL DEFAULT 4 CHECK (max_concurrent_tasks >= 1 AND max_concurrent_tasks <= 128),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'AUTO_PAUSED')),
  pause_scope TEXT NULL CHECK (
    pause_scope IS NULL OR pause_scope IN (
      'PROJECT_TOKENS',
      'PROJECT_COST',
      'PROJECT_WALL_TIME',
      'TASK_TOKENS',
      'TASK_COST',
      'TASK_WALL_TIME'
    )
  ),
  paused_task_id UUID NULL,
  pause_reason TEXT NULL,
  paused_at TIMESTAMPTZ NULL,
  resumed_by_principal_id TEXT NULL,
  resumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_pbp_paused_task FOREIGN KEY (paused_task_id, project_id)
    REFERENCES tasks (task_id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS task_budget_policies (
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  task_id UUID NOT NULL,
  max_task_tokens BIGINT NULL CHECK (max_task_tokens IS NULL OR max_task_tokens > 0),
  max_task_cost_micro_usd BIGINT NULL CHECK (max_task_cost_micro_usd IS NULL OR max_task_cost_micro_usd > 0),
  max_task_wall_time_ms BIGINT NULL CHECK (max_task_wall_time_ms IS NULL OR max_task_wall_time_ms > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'AUTO_PAUSED')),
  pause_scope TEXT NULL CHECK (
    pause_scope IS NULL OR pause_scope IN ('TASK_TOKENS', 'TASK_COST', 'TASK_WALL_TIME')
  ),
  pause_reason TEXT NULL,
  paused_at TIMESTAMPTZ NULL,
  resumed_by_principal_id TEXT NULL,
  resumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, task_id),
  CONSTRAINT fk_tbp_task FOREIGN KEY (task_id, project_id)
    REFERENCES tasks (task_id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS budget_pause_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  task_id UUID NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('AUTO_PAUSED', 'BUDGET_UPDATED', 'RESUMED')),
  pause_scope TEXT NULL CHECK (
    pause_scope IS NULL OR pause_scope IN (
      'PROJECT_TOKENS',
      'PROJECT_COST',
      'PROJECT_WALL_TIME',
      'TASK_TOKENS',
      'TASK_COST',
      'TASK_WALL_TIME'
    )
  ),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  observed_tokens BIGINT NOT NULL DEFAULT 0 CHECK (observed_tokens >= 0),
  observed_cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (observed_cost_micro_usd >= 0),
  observed_wall_time_ms BIGINT NOT NULL DEFAULT 0 CHECK (observed_wall_time_ms >= 0),
  limit_value BIGINT NULL,
  actor_principal_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_bpe_task FOREIGN KEY (task_id, project_id)
    REFERENCES tasks (task_id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_bpe_project_created
  ON budget_pause_events (project_id, created_at DESC);

-- 5. Enable & FORCE Row-Level Security + Policies + Least-Privilege Grants
DO $$
DECLARE
  tbl TEXT;
  m6c_tables TEXT[] := ARRAY[
    'task_dependencies',
    'merge_queue_entries',
    'project_budget_policies',
    'task_budget_policies',
    'budget_pause_events'
  ];
BEGIN
  FOREACH tbl IN ARRAY m6c_tables
  LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO db_migrator', tbl);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', tbl);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);

    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_select ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I_tenant_select ON %I FOR SELECT USING (project_id = current_app_project_id())',
      tbl, tbl
    );
  END LOOP;
END
$$;

-- task_dependencies: core_api_service SELECT + INSERT (Strictly Append-Only)
DROP POLICY IF EXISTS task_dependencies_tenant_insert ON task_dependencies;
CREATE POLICY task_dependencies_tenant_insert ON task_dependencies
  FOR INSERT
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  );

REVOKE UPDATE, DELETE ON task_dependencies FROM app_runtime;
GRANT SELECT, INSERT ON task_dependencies TO app_runtime;

-- merge_queue_entries: core_api_service SELECT + INSERT + Column-Level UPDATE
DROP POLICY IF EXISTS merge_queue_entries_tenant_insert ON merge_queue_entries;
CREATE POLICY merge_queue_entries_tenant_insert ON merge_queue_entries
  FOR INSERT
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  );

DROP POLICY IF EXISTS merge_queue_entries_tenant_update ON merge_queue_entries;
CREATE POLICY merge_queue_entries_tenant_update ON merge_queue_entries
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  );

REVOKE UPDATE, DELETE ON merge_queue_entries FROM app_runtime;
GRANT SELECT, INSERT, UPDATE (
  status,
  attempt_count,
  rebased_to_candidate_id,
  merged_commit_hash,
  last_error,
  started_at,
  completed_at,
  updated_at
) ON merge_queue_entries TO app_runtime;
GRANT USAGE, SELECT ON SEQUENCE merge_queue_entries_queue_position_seq TO app_runtime;

-- project_budget_policies & task_budget_policies: core_api_service & gateway_service
DROP POLICY IF EXISTS project_budget_policies_tenant_insert ON project_budget_policies;
CREATE POLICY project_budget_policies_tenant_insert ON project_budget_policies
  FOR INSERT
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  );

DROP POLICY IF EXISTS project_budget_policies_tenant_update ON project_budget_policies;
CREATE POLICY project_budget_policies_tenant_update ON project_budget_policies
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  );

REVOKE UPDATE, DELETE ON project_budget_policies FROM app_runtime;
GRANT SELECT, INSERT, UPDATE (
  max_project_tokens,
  max_project_cost_micro_usd,
  max_project_wall_time_ms,
  default_task_max_tokens,
  default_task_max_cost_micro_usd,
  default_task_max_wall_time_ms,
  max_concurrent_tasks,
  status,
  pause_scope,
  paused_task_id,
  pause_reason,
  paused_at,
  resumed_by_principal_id,
  resumed_at,
  updated_at
) ON project_budget_policies TO app_runtime;

DROP POLICY IF EXISTS task_budget_policies_tenant_insert ON task_budget_policies;
CREATE POLICY task_budget_policies_tenant_insert ON task_budget_policies
  FOR INSERT
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  );

DROP POLICY IF EXISTS task_budget_policies_tenant_update ON task_budget_policies;
CREATE POLICY task_budget_policies_tenant_update ON task_budget_policies
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  );

REVOKE UPDATE, DELETE ON task_budget_policies FROM app_runtime;
GRANT SELECT, INSERT, UPDATE (
  max_task_tokens,
  max_task_cost_micro_usd,
  max_task_wall_time_ms,
  status,
  pause_scope,
  pause_reason,
  paused_at,
  resumed_by_principal_id,
  resumed_at,
  updated_at
) ON task_budget_policies TO app_runtime;

-- budget_pause_events: Strictly Append-Only (SELECT + INSERT only)
DROP POLICY IF EXISTS budget_pause_events_tenant_insert ON budget_pause_events;
CREATE POLICY budget_pause_events_tenant_insert ON budget_pause_events
  FOR INSERT
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  );

REVOKE UPDATE, DELETE ON budget_pause_events FROM app_runtime;
GRANT SELECT, INSERT ON budget_pause_events TO app_runtime;

-- Direct SQL lease grants must respect the same dependency gate as the repository.
CREATE OR REPLACE FUNCTION fn_enforce_dispatch_dependencies()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'Leased' AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM pg_advisory_xact_lock(hashtext('lease-dispatch:' || NEW.project_id::text));
    IF EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks t
        ON t.project_id = d.project_id AND t.task_id = d.depends_on_task_id
        WHERE d.project_id = NEW.project_id AND d.task_id = NEW.task_id
          AND t.status <> 'MergedAndCompleted') THEN
      RAISE EXCEPTION 'Upstream dependencies are incomplete' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_tasks_dispatch_dependencies ON tasks;
CREATE TRIGGER trg_tasks_dispatch_dependencies BEFORE UPDATE OF status ON tasks
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_dispatch_dependencies();

CREATE OR REPLACE FUNCTION fn_enforce_lease_dependencies()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'ACTIVE' THEN
    PERFORM pg_advisory_xact_lock(hashtext('lease-dispatch:' || NEW.project_id::text));
    IF EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks t
      ON t.project_id = d.project_id AND t.task_id = d.depends_on_task_id
      WHERE d.project_id = NEW.project_id AND d.task_id = NEW.task_id
        AND t.status <> 'MergedAndCompleted') THEN
      RAISE EXCEPTION 'Cannot lease task with incomplete upstream dependencies' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_lease_dispatch_dependencies ON task_leases;
CREATE TRIGGER trg_lease_dispatch_dependencies BEFORE INSERT ON task_leases
  FOR EACH ROW EXECUTE FUNCTION fn_enforce_lease_dependencies();
