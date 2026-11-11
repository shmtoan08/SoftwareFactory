-- =============================================================================
-- Software Factory v1.5 — Milestone M5: Baseline Execution Metrics (AC-12a),
--                         Orphaned Push Recovery Flag & Runtime Pool Support
-- Spec Reference: Roadmap Milestone M5 (M5-AC6, M5-AC7, M5-AC8, AC-11a, AC-12a)
-- Additive & idempotent migration.
-- =============================================================================

-- 1. Optional cached main_ref_commit_hash pointer on projects
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS main_ref_commit_hash CHAR(40) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_projects_main_ref_sha1'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT chk_projects_main_ref_sha1
      CHECK (main_ref_commit_hash IS NULL OR main_ref_commit_hash ~ '^[0-9a-f]{40}$');
  END IF;
END
$$;

-- 2. Extend verified_code_imports with Orphaned Push Reconciler recovery flag (`M5-AC7b`)
ALTER TABLE verified_code_imports
  ADD COLUMN IF NOT EXISTS recovered_by_reconciler BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Tier 3 Append-Only Baseline Execution Metrics (`resource_usage_metrics`, `AC-12a`)
CREATE TABLE IF NOT EXISTS resource_usage_metrics (
  metric_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  task_id UUID NOT NULL,
  lease_id UUID NULL,
  lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 0),
  attempt_no INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no >= 1),
  rework_cycle INTEGER NOT NULL DEFAULT 0 CHECK (rework_cycle >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('DEVELOPER', 'VERIFIER', 'REVIEWER')),
  wall_time_ms INTEGER NOT NULL CHECK (wall_time_ms >= 0),
  cpu_usage_usec BIGINT NOT NULL CHECK (cpu_usage_usec >= 0),
  peak_memory_bytes BIGINT NOT NULL CHECK (peak_memory_bytes >= 0),
  sandbox_backend_mode TEXT NOT NULL CHECK (NULLIF(btrim(sandbox_backend_mode), '') IS NOT NULL),
  metrics_source TEXT NOT NULL CHECK (metrics_source IN ('cgroup-v2', 'process-rusage', 'wall-clock-only')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_rum_task FOREIGN KEY (task_id, project_id)
    REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_rum_lease FOREIGN KEY (lease_id, project_id)
    REFERENCES task_leases(lease_id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_rum_project_task_epoch
  ON resource_usage_metrics (project_id, task_id, lease_epoch, recorded_at);

-- 4. Enable & FORCE Row-Level Security + Append-Only Grants on resource_usage_metrics
ALTER TABLE resource_usage_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_usage_metrics FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS resource_usage_metrics_evidence_select ON resource_usage_metrics;
CREATE POLICY resource_usage_metrics_evidence_select ON resource_usage_metrics
  FOR SELECT
  USING (project_id = current_app_project_id());

DROP POLICY IF EXISTS resource_usage_metrics_evidence_insert ON resource_usage_metrics;
CREATE POLICY resource_usage_metrics_evidence_insert ON resource_usage_metrics
  FOR INSERT
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  );

REVOKE ALL ON resource_usage_metrics FROM PUBLIC;
GRANT SELECT, INSERT ON resource_usage_metrics TO app_runtime;

-- 5. Allow core_api_service to update project main_ref_commit_hash within active tenant scope
DROP POLICY IF EXISTS projects_core_api_main_ref_update ON projects;
CREATE POLICY projects_core_api_main_ref_update ON projects
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  );

