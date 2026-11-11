-- =============================================================================
-- Software Factory v1.5 — Milestone M6A: Model Provider Cost Guard (AC-12b)
--                         & Stages 1–4 Product Pipeline Schema (AC-10, Spec Freeze)
-- Spec Reference: M6A-SPEC-01 (m6a_model_adapter_cost_guard_and_stages_1_4_specification_v1_5.md)
-- Additive & idempotent migration with FORCE ROW LEVEL SECURITY on all 7 tables.
-- =============================================================================

-- 1. Model Cost Sessions (`AC-12b` Per-Request & Session Budgets in integer micro-USD)
CREATE TABLE IF NOT EXISTS model_cost_sessions (
  cost_session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  pipeline_session_id UUID NULL,
  task_id UUID NULL,
  max_tokens_per_request BIGINT NOT NULL CHECK (max_tokens_per_request > 0),
  max_cost_micro_usd_per_request BIGINT NOT NULL CHECK (max_cost_micro_usd_per_request >= 0),
  session_token_budget BIGINT NOT NULL CHECK (session_token_budget > 0),
  session_cost_budget_micro_usd BIGINT NOT NULL CHECK (session_cost_budget_micro_usd >= 0),
  tokens_used_total BIGINT NOT NULL DEFAULT 0 CHECK (tokens_used_total >= 0),
  cost_used_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (cost_used_micro_usd >= 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXHAUSTED', 'CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_mcs_id_project UNIQUE (cost_session_id, project_id),
  CONSTRAINT fk_mcs_task FOREIGN KEY (task_id, project_id)
    REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_mcs_project_status
  ON model_cost_sessions (project_id, status, created_at);

-- 2. Product Pipeline Sessions (Stages 1–4 State Machine & Baseline Freeze Link)
CREATE TABLE IF NOT EXISTS product_pipeline_sessions (
  pipeline_session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  cost_session_id UUID NULL,
  title TEXT NOT NULL CHECK (NULLIF(btrim(title), '') IS NOT NULL),
  raw_idea_text TEXT NOT NULL CHECK (NULLIF(btrim(raw_idea_text), '') IS NOT NULL),
  current_stage TEXT NOT NULL DEFAULT 'STAGE_1_IDEA_DISCOVERY' CHECK (
    current_stage IN (
      'STAGE_1_IDEA_DISCOVERY',
      'STAGE_2_REQUIREMENTS',
      'STAGE_3_ARCHITECTURE',
      'STAGE_4_SPEC_FREEZE'
    )
  ),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'FROZEN', 'CANCELLED')),
  frozen_baseline_id UUID NULL,
  created_by_principal_id TEXT NOT NULL CHECK (NULLIF(btrim(created_by_principal_id), '') IS NOT NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_pps_id_project UNIQUE (pipeline_session_id, project_id),
  CONSTRAINT fk_pps_cost_session FOREIGN KEY (cost_session_id, project_id)
    REFERENCES model_cost_sessions(cost_session_id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pps_project_status
  ON product_pipeline_sessions (project_id, status, created_at);

-- 3. Append-Only Model Call Ledgers (`AC-12b` Request/Response Audit & Telemetry)
CREATE TABLE IF NOT EXISTS model_call_ledgers (
  call_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  cost_session_id UUID NOT NULL,
  pipeline_session_id UUID NULL,
  task_id UUID NULL,
  stage TEXT NOT NULL CHECK (NULLIF(btrim(stage), '') IS NOT NULL),
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google')),
  model TEXT NOT NULL CHECK (NULLIF(btrim(model), '') IS NOT NULL),
  prompt_id TEXT NOT NULL CHECK (NULLIF(btrim(prompt_id), '') IS NOT NULL),
  prompt_version TEXT NOT NULL CHECK (NULLIF(btrim(prompt_version), '') IS NOT NULL),
  prompt_sha256 CHAR(64) NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens >= 0),
  actual_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (actual_input_tokens >= 0),
  actual_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (actual_output_tokens >= 0),
  actual_total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (actual_total_tokens >= 0),
  estimated_cost_micro_usd BIGINT NOT NULL CHECK (estimated_cost_micro_usd >= 0),
  actual_cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (actual_cost_micro_usd >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('ALLOWED', 'BLOCKED_PREFLIGHT', 'BLOCKED_POSTCALL', 'FAILED_VALIDATION', 'FAILED_PROVIDER')
  ),
  block_reason TEXT NULL,
  error_message TEXT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_mcl_cost_session FOREIGN KEY (cost_session_id, project_id)
    REFERENCES model_cost_sessions(cost_session_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mcl_pipeline_session FOREIGN KEY (pipeline_session_id, project_id)
    REFERENCES product_pipeline_sessions(pipeline_session_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_mcl_task FOREIGN KEY (task_id, project_id)
    REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_mcl_project_cost_session
  ON model_call_ledgers (project_id, cost_session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_mcl_project_pipeline_session
  ON model_call_ledgers (project_id, pipeline_session_id, created_at);

-- 4. Stage 1 Discovery Items (`FACT` / `ASSUMPTION` / `RECOMMENDATION` — `AC-10`)
CREATE TABLE IF NOT EXISTS stage1_discovery_items (
  item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  pipeline_session_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('FACT', 'ASSUMPTION', 'RECOMMENDATION')),
  title TEXT NOT NULL CHECK (NULLIF(btrim(title), '') IS NOT NULL),
  statement TEXT NOT NULL CHECK (NULLIF(btrim(statement), '') IS NOT NULL),
  rationale TEXT NOT NULL,
  clarification_question TEXT NULL,
  confirmation_status TEXT NOT NULL CHECK (
    confirmation_status IN ('AUTO_VERIFIED', 'UNCONFIRMED', 'CONFIRMED', 'REJECTED')
  ),
  confirmed_by_principal_id TEXT NULL,
  confirmed_at TIMESTAMPTZ NULL,
  resolution_note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_s1_pipeline_session FOREIGN KEY (pipeline_session_id, project_id)
    REFERENCES product_pipeline_sessions(pipeline_session_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT chk_s1_assumption_not_auto_verified CHECK (
    kind <> 'ASSUMPTION' OR confirmation_status IN ('UNCONFIRMED', 'CONFIRMED', 'REJECTED')
  ),
  CONSTRAINT chk_s1_recommendation_not_auto_verified CHECK (
    kind <> 'RECOMMENDATION' OR confirmation_status IN ('UNCONFIRMED', 'CONFIRMED', 'REJECTED')
  ),
  CONSTRAINT chk_s1_resolution_actor CHECK (
    confirmation_status NOT IN ('CONFIRMED', 'REJECTED')
    OR (NULLIF(btrim(confirmed_by_principal_id), '') IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_s1_project_session
  ON stage1_discovery_items (project_id, pipeline_session_id, kind, created_at);

-- 5. Append-Only Stage Artifacts (Stage 1..4 Immutable Versioned Payloads + Canonical Hash)
CREATE TABLE IF NOT EXISTS stage_artifacts (
  artifact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  pipeline_session_id UUID NOT NULL,
  stage TEXT NOT NULL CHECK (
    stage IN (
      'STAGE_1_IDEA_DISCOVERY',
      'STAGE_2_REQUIREMENTS',
      'STAGE_3_ARCHITECTURE',
      'STAGE_4_SPEC_FREEZE'
    )
  ),
  artifact_kind TEXT NOT NULL CHECK (
    artifact_kind IN (
      'STAGE_1_DISCOVERY_BUNDLE',
      'STAGE_2_PRD_SRS',
      'STAGE_3_ARCHITECTURE_DESIGN',
      'STAGE_4_VALIDATION_REPORT'
    )
  ),
  version INTEGER NOT NULL CHECK (version >= 1),
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google', 'system')),
  model TEXT NOT NULL CHECK (NULLIF(btrim(model), '') IS NOT NULL),
  prompt_id TEXT NOT NULL CHECK (NULLIF(btrim(prompt_id), '') IS NOT NULL),
  prompt_version TEXT NOT NULL CHECK (NULLIF(btrim(prompt_version), '') IS NOT NULL),
  prompt_sha256 CHAR(64) NOT NULL CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  content_json JSONB NOT NULL,
  artifact_sha256 CHAR(64) NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_principal_id TEXT NOT NULL CHECK (NULLIF(btrim(created_by_principal_id), '') IS NOT NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_sa_pipeline_session FOREIGN KEY (pipeline_session_id, project_id)
    REFERENCES product_pipeline_sessions(pipeline_session_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT uq_sa_session_stage_version UNIQUE (pipeline_session_id, stage, version),
  CONSTRAINT uq_sa_composite_binding UNIQUE (artifact_id, project_id, pipeline_session_id, artifact_sha256),
  CONSTRAINT chk_sa_stage_kind CHECK (
    (stage = 'STAGE_1_IDEA_DISCOVERY' AND artifact_kind = 'STAGE_1_DISCOVERY_BUNDLE') OR
    (stage = 'STAGE_2_REQUIREMENTS' AND artifact_kind = 'STAGE_2_PRD_SRS') OR
    (stage = 'STAGE_3_ARCHITECTURE' AND artifact_kind = 'STAGE_3_ARCHITECTURE_DESIGN') OR
    (stage = 'STAGE_4_SPEC_FREEZE' AND artifact_kind = 'STAGE_4_VALIDATION_REPORT')
  )
);

CREATE INDEX IF NOT EXISTS idx_sa_project_session_stage
  ON stage_artifacts (project_id, pipeline_session_id, stage, version);

-- 6. Append-Only Stage Approval Gates
CREATE TABLE IF NOT EXISTS stage_approval_gates (
  gate_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  pipeline_session_id UUID NOT NULL,
  gate_stage TEXT NOT NULL CHECK (
    gate_stage IN (
      'STAGE_1_DISCOVERY',
      'STAGE_2_REQUIREMENTS',
      'STAGE_3_ARCHITECTURE',
      'STAGE_4_SPEC_FREEZE'
    )
  ),
  target_artifact_id UUID NOT NULL,
  target_artifact_sha256 CHAR(64) NOT NULL CHECK (target_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  approver_principal_id TEXT NOT NULL CHECK (NULLIF(btrim(approver_principal_id), '') IS NOT NULL),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED', 'REQUEST_CHANGES')),
  rationale TEXT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_sag_pipeline_session FOREIGN KEY (pipeline_session_id, project_id)
    REFERENCES product_pipeline_sessions(pipeline_session_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sag_artifact FOREIGN KEY (
    target_artifact_id, project_id, pipeline_session_id, target_artifact_sha256
  ) REFERENCES stage_artifacts (
    artifact_id, project_id, pipeline_session_id, artifact_sha256
  ) ON DELETE RESTRICT,
  CONSTRAINT uq_sag_freeze_binding UNIQUE (
    gate_id, project_id, pipeline_session_id, gate_stage,
    target_artifact_id, target_artifact_sha256, decision
  )
);

CREATE INDEX IF NOT EXISTS idx_sag_project_session
  ON stage_approval_gates (project_id, pipeline_session_id, gate_stage, decided_at);

-- 7. Append-Only Immutable Baseline Spec Freezes (Stage 4 Final Spec Freeze)
CREATE TABLE IF NOT EXISTS baseline_spec_freezes (
  baseline_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  pipeline_session_id UUID NOT NULL,
  stage1_artifact_id UUID NOT NULL,
  stage1_artifact_sha256 CHAR(64) NOT NULL CHECK (stage1_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  stage2_artifact_id UUID NOT NULL,
  stage2_artifact_sha256 CHAR(64) NOT NULL CHECK (stage2_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  stage3_artifact_id UUID NOT NULL,
  stage3_artifact_sha256 CHAR(64) NOT NULL CHECK (stage3_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  validation_report_artifact_id UUID NOT NULL,
  validation_report_sha256 CHAR(64) NOT NULL CHECK (validation_report_sha256 ~ '^[0-9a-f]{64}$'),
  approval_gate_id UUID NOT NULL,
  required_gate_stage TEXT NOT NULL DEFAULT 'STAGE_4_SPEC_FREEZE' CHECK (
    required_gate_stage = 'STAGE_4_SPEC_FREEZE'
  ),
  required_gate_decision TEXT NOT NULL DEFAULT 'APPROVED' CHECK (
    required_gate_decision = 'APPROVED'
  ),
  frozen_by_principal_id TEXT NOT NULL CHECK (NULLIF(btrim(frozen_by_principal_id), '') IS NOT NULL),
  freeze_bundle_sha256 CHAR(64) NOT NULL CHECK (freeze_bundle_sha256 ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'FROZEN' CHECK (status = 'FROZEN'),
  frozen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_one_frozen_baseline_per_session UNIQUE (pipeline_session_id),
  CONSTRAINT uq_bsf_id_project_session UNIQUE (baseline_id, project_id, pipeline_session_id),
  CONSTRAINT fk_bsf_pipeline_session FOREIGN KEY (pipeline_session_id, project_id)
    REFERENCES product_pipeline_sessions(pipeline_session_id, project_id) ON DELETE RESTRICT,
  CONSTRAINT fk_bsf_stage1 FOREIGN KEY (
    stage1_artifact_id, project_id, pipeline_session_id, stage1_artifact_sha256
  ) REFERENCES stage_artifacts (
    artifact_id, project_id, pipeline_session_id, artifact_sha256
  ) ON DELETE RESTRICT,
  CONSTRAINT fk_bsf_stage2 FOREIGN KEY (
    stage2_artifact_id, project_id, pipeline_session_id, stage2_artifact_sha256
  ) REFERENCES stage_artifacts (
    artifact_id, project_id, pipeline_session_id, artifact_sha256
  ) ON DELETE RESTRICT,
  CONSTRAINT fk_bsf_stage3 FOREIGN KEY (
    stage3_artifact_id, project_id, pipeline_session_id, stage3_artifact_sha256
  ) REFERENCES stage_artifacts (
    artifact_id, project_id, pipeline_session_id, artifact_sha256
  ) ON DELETE RESTRICT,
  CONSTRAINT fk_bsf_stage4_report FOREIGN KEY (
    validation_report_artifact_id, project_id, pipeline_session_id, validation_report_sha256
  ) REFERENCES stage_artifacts (
    artifact_id, project_id, pipeline_session_id, artifact_sha256
  ) ON DELETE RESTRICT,
  CONSTRAINT fk_bsf_gate FOREIGN KEY (
    approval_gate_id, project_id, pipeline_session_id, required_gate_stage,
    validation_report_artifact_id, validation_report_sha256, required_gate_decision
  ) REFERENCES stage_approval_gates (
    gate_id, project_id, pipeline_session_id, gate_stage,
    target_artifact_id, target_artifact_sha256, decision
  ) ON DELETE RESTRICT
);

-- 8. Database-Level AC-10 & Freeze Immutability Triggers (SECURITY INVOKER — preserves RLS)
CREATE OR REPLACE FUNCTION fn_enforce_stage1_mutable_until_frozen()
RETURNS TRIGGER AS $$
DECLARE
  v_session_status TEXT;
BEGIN
  SELECT status INTO v_session_status
  FROM product_pipeline_sessions
  WHERE pipeline_session_id = NEW.pipeline_session_id
    AND project_id = NEW.project_id;

  IF v_session_status IS NULL THEN
    RAISE EXCEPTION 'Product pipeline session % not found for project %', NEW.pipeline_session_id, NEW.project_id
      USING ERRCODE = '23503';
  END IF;

  IF v_session_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Session % is %; stage1_discovery_items cannot be added or modified after baseline freeze', NEW.pipeline_session_id, v_session_status
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.pipeline_session_id IS DISTINCT FROM OLD.pipeline_session_id
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.statement IS DISTINCT FROM OLD.statement
      OR NEW.rationale IS DISTINCT FROM OLD.rationale THEN
      RAISE EXCEPTION 'Immutable columns on stage1_discovery_items cannot be modified'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_s1_mutable_until_frozen ON stage1_discovery_items;
CREATE TRIGGER trg_s1_mutable_until_frozen
  BEFORE INSERT OR UPDATE ON stage1_discovery_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_stage1_mutable_until_frozen();

CREATE OR REPLACE FUNCTION fn_enforce_stage_artifact_invariants()
RETURNS TRIGGER AS $$
DECLARE
  v_session_status TEXT;
  v_req JSONB;
  v_src_id_text TEXT;
  v_item_kind TEXT;
  v_item_status TEXT;
BEGIN
  SELECT status INTO v_session_status
  FROM product_pipeline_sessions
  WHERE pipeline_session_id = NEW.pipeline_session_id
    AND project_id = NEW.project_id;

  IF v_session_status IS NULL THEN
    RAISE EXCEPTION 'Product pipeline session % not found for project %', NEW.pipeline_session_id, NEW.project_id
      USING ERRCODE = '23503';
  END IF;

  IF v_session_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Session % is %; new stage artifacts are forbidden after baseline freeze', NEW.pipeline_session_id, v_session_status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stage = 'STAGE_2_REQUIREMENTS' THEN
    IF jsonb_typeof(NEW.content_json->'srs') <> 'object' THEN
      RAISE EXCEPTION 'Stage 2 artifact must contain object content_json.srs'
        USING ERRCODE = '23514';
    END IF;

    FOR v_req IN
      SELECT elem FROM jsonb_array_elements(COALESCE(NEW.content_json->'srs'->'functional_requirements', '[]'::jsonb)) AS elem
      UNION ALL
      SELECT elem FROM jsonb_array_elements(COALESCE(NEW.content_json->'srs'->'non_functional_requirements', '[]'::jsonb)) AS elem
    LOOP
      IF jsonb_typeof(v_req->'source_discovery_item_ids') <> 'array'
        OR jsonb_array_length(v_req->'source_discovery_item_ids') < 1 THEN
        RAISE EXCEPTION 'AC-10 violation: Stage 2 requirement % must reference >= 1 Stage 1 discovery item', COALESCE(v_req->>'req_id', 'unknown')
          USING ERRCODE = '23514';
      END IF;

      FOR v_src_id_text IN
        SELECT jsonb_array_elements_text(v_req->'source_discovery_item_ids')
      LOOP
        IF v_src_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'AC-10 violation: invalid Stage 1 source UUID % in requirement %', v_src_id_text, COALESCE(v_req->>'req_id', 'unknown')
            USING ERRCODE = '23514';
        END IF;

        SELECT kind, confirmation_status INTO v_item_kind, v_item_status
        FROM stage1_discovery_items
        WHERE item_id = v_src_id_text::uuid
          AND project_id = NEW.project_id
          AND pipeline_session_id = NEW.pipeline_session_id;

        IF v_item_status IS NULL THEN
          RAISE EXCEPTION 'AC-10 violation: referenced Stage 1 item % does not belong to session %', v_src_id_text, NEW.pipeline_session_id
            USING ERRCODE = '23514';
        END IF;

        IF v_item_status NOT IN ('AUTO_VERIFIED', 'CONFIRMED') THEN
          RAISE EXCEPTION 'AC-10 violation: Stage 2 requirement % references Stage 1 % (%) in non-confirmed status %',
            COALESCE(v_req->>'req_id', 'unknown'), v_item_kind, v_src_id_text, v_item_status
            USING ERRCODE = '23514';
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_stage_artifact_invariants ON stage_artifacts;
CREATE TRIGGER trg_stage_artifact_invariants
  BEFORE INSERT ON stage_artifacts
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_stage_artifact_invariants();

CREATE OR REPLACE FUNCTION fn_enforce_baseline_freeze_invariants()
RETURNS TRIGGER AS $$
DECLARE
  v_session_status TEXT;
  v_stage1 TEXT;
  v_stage2 TEXT;
  v_stage3 TEXT;
  v_stage4 TEXT;
  v_report_json JSONB;
BEGIN
  SELECT status INTO v_session_status
  FROM product_pipeline_sessions
  WHERE pipeline_session_id = NEW.pipeline_session_id
    AND project_id = NEW.project_id;

  IF v_session_status IS NULL THEN
    RAISE EXCEPTION 'Pipeline session % not found', NEW.pipeline_session_id
      USING ERRCODE = '23503';
  END IF;
  IF v_session_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Cannot freeze baseline when session % status is %', NEW.pipeline_session_id, v_session_status
      USING ERRCODE = '23514';
  END IF;

  SELECT stage INTO v_stage1 FROM stage_artifacts WHERE artifact_id = NEW.stage1_artifact_id;
  SELECT stage INTO v_stage2 FROM stage_artifacts WHERE artifact_id = NEW.stage2_artifact_id;
  SELECT stage INTO v_stage3 FROM stage_artifacts WHERE artifact_id = NEW.stage3_artifact_id;
  SELECT stage, content_json INTO v_stage4, v_report_json FROM stage_artifacts WHERE artifact_id = NEW.validation_report_artifact_id;

  IF v_stage1 IS DISTINCT FROM 'STAGE_1_IDEA_DISCOVERY'
    OR v_stage2 IS DISTINCT FROM 'STAGE_2_REQUIREMENTS'
    OR v_stage3 IS DISTINCT FROM 'STAGE_3_ARCHITECTURE'
    OR v_stage4 IS DISTINCT FROM 'STAGE_4_SPEC_FREEZE' THEN
    RAISE EXCEPTION 'BaselineSpecFreeze stage artifact references do not match Stages 1..4'
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE((v_report_json->>'passed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Cannot freeze baseline: Stage 4 CrossArtifactConsistencyChecker report passed is not TRUE'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_baseline_freeze_invariants ON baseline_spec_freezes;
CREATE TRIGGER trg_baseline_freeze_invariants
  BEFORE INSERT ON baseline_spec_freezes
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_baseline_freeze_invariants();

CREATE OR REPLACE FUNCTION fn_enforce_pipeline_session_freeze_lock()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'FROZEN' THEN
    IF NEW.status IS DISTINCT FROM 'FROZEN'
      OR NEW.frozen_baseline_id IS DISTINCT FROM OLD.frozen_baseline_id
      OR NEW.current_stage IS DISTINCT FROM OLD.current_stage
      OR NEW.cost_session_id IS DISTINCT FROM OLD.cost_session_id THEN
      RAISE EXCEPTION 'Frozen pipeline session % cannot be unfrozen or mutated', OLD.pipeline_session_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'FROZEN' THEN
    IF NEW.frozen_baseline_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM baseline_spec_freezes b
      WHERE b.baseline_id = NEW.frozen_baseline_id
        AND b.project_id = NEW.project_id
        AND b.pipeline_session_id = NEW.pipeline_session_id
        AND b.status = 'FROZEN'
    ) THEN
      RAISE EXCEPTION 'Cannot mark session % FROZEN without a committed baseline_spec_freezes row', NEW.pipeline_session_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_pipeline_session_freeze_lock ON product_pipeline_sessions;
CREATE TRIGGER trg_pipeline_session_freeze_lock
  BEFORE UPDATE ON product_pipeline_sessions
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_pipeline_session_freeze_lock();

-- 9. Enable & FORCE Row-Level Security + Policies on All 7 M6A Tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'model_cost_sessions',
    'model_call_ledgers',
    'product_pipeline_sessions',
    'stage1_discovery_items',
    'stage_artifacts',
    'stage_approval_gates',
    'baseline_spec_freezes'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);

    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_select ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I_tenant_select ON %I FOR SELECT USING (project_id = current_app_project_id())',
      tbl, tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_insert ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY %I_tenant_insert ON %I FOR INSERT WITH CHECK (project_id = current_app_project_id() AND current_app_role() IN (''core_api_service'', ''gateway_service''))',
      tbl, tbl
    );
  END LOOP;
END
$$;

-- Scoped UPDATE policies only on mutable-state tables
DROP POLICY IF EXISTS model_cost_sessions_tenant_update ON model_cost_sessions;
CREATE POLICY model_cost_sessions_tenant_update ON model_cost_sessions
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() IN ('core_api_service', 'gateway_service')
  );

DROP POLICY IF EXISTS product_pipeline_sessions_tenant_update ON product_pipeline_sessions;
CREATE POLICY product_pipeline_sessions_tenant_update ON product_pipeline_sessions
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  );

DROP POLICY IF EXISTS stage1_discovery_items_tenant_update ON stage1_discovery_items;
CREATE POLICY stage1_discovery_items_tenant_update ON stage1_discovery_items
  FOR UPDATE
  USING (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  )
  WITH CHECK (
    project_id = current_app_project_id()
    AND current_app_role() = 'core_api_service'
  );

-- 10. Least-Privilege & Append-Only GRANTs for app_runtime
REVOKE ALL ON
  model_cost_sessions,
  model_call_ledgers,
  product_pipeline_sessions,
  stage1_discovery_items,
  stage_artifacts,
  stage_approval_gates,
  baseline_spec_freezes
FROM PUBLIC;

-- Strictly append-only tables: SELECT + INSERT only (NO UPDATE, NO DELETE)
GRANT SELECT, INSERT ON
  model_call_ledgers,
  stage_artifacts,
  stage_approval_gates,
  baseline_spec_freezes
TO app_runtime;

-- State-tracked tables: SELECT + INSERT + Column-Level UPDATE only (NO DELETE)
REVOKE UPDATE, DELETE ON model_cost_sessions FROM app_runtime;
GRANT SELECT, INSERT, UPDATE (tokens_used_total, cost_used_micro_usd, status, updated_at)
  ON model_cost_sessions TO app_runtime;

REVOKE UPDATE, DELETE ON product_pipeline_sessions FROM app_runtime;
GRANT SELECT, INSERT, UPDATE (cost_session_id, current_stage, status, frozen_baseline_id, updated_at)
  ON product_pipeline_sessions TO app_runtime;

REVOKE UPDATE, DELETE ON stage1_discovery_items FROM app_runtime;
GRANT SELECT, INSERT, UPDATE (
  clarification_question,
  confirmation_status,
  confirmed_by_principal_id,
  confirmed_at,
  resolution_note,
  updated_at
) ON stage1_discovery_items TO app_runtime;
