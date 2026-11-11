-- =============================================================================
-- Software Factory v1.5 — Milestone M6A Review Hardening Migration (`0007`)
-- Addresses GitHub Issue #4 (M6A-FIX-01..04 + Minor Notes 1, 5, 6, 7, 8, 17, 18)
-- Additive & idempotent forward migration preserving `0001`..`0006` compatibility.
-- =============================================================================

-- 1. Ledger fallback usage telemetry column (`M6A-FIX-07`)
ALTER TABLE model_call_ledgers
  ADD COLUMN IF NOT EXISTS usage_estimated BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Stage 1 clarification_question invariant for ASSUMPTION & RECOMMENDATION (Minor Note 1)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_s1_assumption_clarification'
      AND conrelid = 'stage1_discovery_items'::regclass
  ) THEN
    ALTER TABLE stage1_discovery_items
      ADD CONSTRAINT chk_s1_assumption_clarification CHECK (
        kind <> 'ASSUMPTION' OR NULLIF(btrim(clarification_question), '') IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_s1_recommendation_clarification'
      AND conrelid = 'stage1_discovery_items'::regclass
  ) THEN
    ALTER TABLE stage1_discovery_items
      ADD CONSTRAINT chk_s1_recommendation_clarification CHECK (
        kind <> 'RECOMMENDATION' OR NULLIF(btrim(clarification_question), '') IS NOT NULL
      );
  END IF;
END
$$;

-- 3. Composite deferrable FK from model_cost_sessions -> product_pipeline_sessions (Minor Note 6)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_mcs_pipeline_session'
      AND conrelid = 'model_cost_sessions'::regclass
  ) THEN
    ALTER TABLE model_cost_sessions
      ADD CONSTRAINT fk_mcs_pipeline_session FOREIGN KEY (pipeline_session_id, project_id)
      REFERENCES product_pipeline_sessions (pipeline_session_id, project_id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

-- 4. Defense-in-depth REVOKE UPDATE/DELETE on append-only tables + forward M5 projects GRANT (Minor Notes 5 & 18)
REVOKE UPDATE, DELETE ON
  model_call_ledgers,
  stage_artifacts,
  stage_approval_gates,
  baseline_spec_freezes
FROM app_runtime;

GRANT SELECT, INSERT ON
  model_call_ledgers,
  stage_artifacts,
  stage_approval_gates,
  baseline_spec_freezes
TO app_runtime;

REVOKE UPDATE ON projects FROM app_runtime;
GRANT UPDATE (main_ref_commit_hash, updated_at) ON projects TO app_runtime;

-- 5. Lock Stage 1 discovery item transitions (`UNCONFIRMED -> CONFIRMED|REJECTED` one-way only, `M6A-FIX-02`)
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

    IF OLD.confirmation_status IS DISTINCT FROM 'UNCONFIRMED' THEN
      RAISE EXCEPTION 'Stage 1 discovery item % is already % and cannot be re-resolved or overwritten',
        OLD.item_id, OLD.confirmation_status
        USING ERRCODE = '23514';
    END IF;

    IF NEW.confirmation_status IS DISTINCT FROM OLD.confirmation_status
      AND NEW.confirmation_status NOT IN ('CONFIRMED', 'REJECTED') THEN
      RAISE EXCEPTION 'Stage 1 discovery item % can only transition from UNCONFIRMED to CONFIRMED or REJECTED (got %)',
        OLD.item_id, NEW.confirmation_status
        USING ERRCODE = '23514';
    END IF;

    IF NEW.confirmation_status = 'UNCONFIRMED'
      AND (NEW.confirmed_by_principal_id IS NOT NULL OR NEW.confirmed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'UNCONFIRMED Stage 1 discovery item % cannot set confirmed_by_principal_id or confirmed_at',
        OLD.item_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- 6. Hardened Stage Artifact Invariants (`M6A-FIX-01`: NULL-safe key check + Minor Note 7: 23514 on non-array)
CREATE OR REPLACE FUNCTION fn_enforce_stage_artifact_invariants()
RETURNS TRIGGER AS $$
DECLARE
  v_session_status TEXT;
  v_srs JSONB;
  v_fr JSONB;
  v_nfr JSONB;
  v_req JSONB;
  v_src_elem JSONB;
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

  IF jsonb_typeof(NEW.content_json) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Stage artifact content_json must be a JSON object'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stage = 'STAGE_2_REQUIREMENTS' THEN
    v_srs := NEW.content_json->'srs';
    IF v_srs IS NULL OR jsonb_typeof(v_srs) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Stage 2 artifact must contain object content_json.srs'
        USING ERRCODE = '23514';
    END IF;

    v_fr := v_srs->'functional_requirements';
    IF v_fr IS NOT NULL AND jsonb_typeof(v_fr) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'AC-10 violation: content_json.srs.functional_requirements must be a JSON array'
        USING ERRCODE = '23514';
    END IF;

    v_nfr := v_srs->'non_functional_requirements';
    IF v_nfr IS NOT NULL AND jsonb_typeof(v_nfr) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'AC-10 violation: content_json.srs.non_functional_requirements must be a JSON array'
        USING ERRCODE = '23514';
    END IF;

    FOR v_req IN
      SELECT elem FROM jsonb_array_elements(COALESCE(v_fr, '[]'::jsonb)) AS elem
      UNION ALL
      SELECT elem FROM jsonb_array_elements(COALESCE(v_nfr, '[]'::jsonb)) AS elem
    LOOP
      IF jsonb_typeof(v_req) IS DISTINCT FROM 'object'
        OR v_req->'source_discovery_item_ids' IS NULL
        OR jsonb_typeof(v_req->'source_discovery_item_ids') IS DISTINCT FROM 'array'
        OR jsonb_array_length(v_req->'source_discovery_item_ids') < 1 THEN
        RAISE EXCEPTION 'AC-10 violation: Stage 2 requirement % must reference >= 1 Stage 1 discovery item',
          CASE WHEN jsonb_typeof(v_req) = 'object' THEN COALESCE(v_req->>'req_id', 'unknown') ELSE 'unknown' END
          USING ERRCODE = '23514';
      END IF;

      FOR v_src_elem IN
        SELECT elem FROM jsonb_array_elements(v_req->'source_discovery_item_ids') AS elem
      LOOP
        IF jsonb_typeof(v_src_elem) IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'AC-10 violation: Stage 1 source ID in requirement % must be a UUID string',
            COALESCE(v_req->>'req_id', 'unknown')
            USING ERRCODE = '23514';
        END IF;

        v_src_id_text := v_src_elem #>> '{}';
        IF v_src_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RAISE EXCEPTION 'AC-10 violation: invalid Stage 1 source UUID % in requirement %',
            v_src_id_text, COALESCE(v_req->>'req_id', 'unknown')
            USING ERRCODE = '23514';
        END IF;

        SELECT kind, confirmation_status INTO v_item_kind, v_item_status
        FROM stage1_discovery_items
        WHERE item_id = v_src_id_text::uuid
          AND project_id = NEW.project_id
          AND pipeline_session_id = NEW.pipeline_session_id;

        IF v_item_status IS NULL THEN
          RAISE EXCEPTION 'AC-10 violation: referenced Stage 1 item % does not belong to session %',
            v_src_id_text, NEW.pipeline_session_id
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

-- 7. Hardened Freeze Invariants (`M6A-FIX-02` live AC-10 re-check + `M6A-FIX-03` latest Stage 4 report)
CREATE OR REPLACE FUNCTION fn_enforce_baseline_freeze_invariants()
RETURNS TRIGGER AS $$
DECLARE
  v_session_status TEXT;
  v_stage1 TEXT;
  v_stage2 TEXT;
  v_stage2_json JSONB;
  v_stage3 TEXT;
  v_stage4 TEXT;
  v_s4_version INTEGER;
  v_latest_s4_version INTEGER;
  v_report_json JSONB;
  v_srs JSONB;
  v_fr JSONB;
  v_nfr JSONB;
  v_req JSONB;
  v_src_elem JSONB;
  v_src_id_text TEXT;
  v_item_kind TEXT;
  v_item_status TEXT;
  v_ref_s1 TEXT;
  v_ref_s2 TEXT;
  v_ref_s3 TEXT;
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
  SELECT stage, content_json INTO v_stage2, v_stage2_json FROM stage_artifacts WHERE artifact_id = NEW.stage2_artifact_id;
  SELECT stage INTO v_stage3 FROM stage_artifacts WHERE artifact_id = NEW.stage3_artifact_id;
  SELECT stage, version, content_json
    INTO v_stage4, v_s4_version, v_report_json
  FROM stage_artifacts
  WHERE artifact_id = NEW.validation_report_artifact_id;

  IF v_stage1 IS DISTINCT FROM 'STAGE_1_IDEA_DISCOVERY'
    OR v_stage2 IS DISTINCT FROM 'STAGE_2_REQUIREMENTS'
    OR v_stage3 IS DISTINCT FROM 'STAGE_3_ARCHITECTURE'
    OR v_stage4 IS DISTINCT FROM 'STAGE_4_SPEC_FREEZE' THEN
    RAISE EXCEPTION 'BaselineSpecFreeze stage artifact references do not match Stages 1..4'
      USING ERRCODE = '23514';
  END IF;

  -- M6A-FIX-03: Freeze MUST reference the latest Stage 4 validation report for this session
  SELECT MAX(version) INTO v_latest_s4_version
  FROM stage_artifacts
  WHERE project_id = NEW.project_id
    AND pipeline_session_id = NEW.pipeline_session_id
    AND stage = 'STAGE_4_SPEC_FREEZE';

  IF v_s4_version IS NULL OR v_latest_s4_version IS NULL OR v_s4_version <> v_latest_s4_version THEN
    RAISE EXCEPTION 'Cannot freeze baseline: Stage 4 validation report % (v%) is not the latest report (latest v%)',
      NEW.validation_report_artifact_id, COALESCE(v_s4_version, 0), COALESCE(v_latest_s4_version, 0)
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE((v_report_json->>'passed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Cannot freeze baseline: Stage 4 CrossArtifactConsistencyChecker report passed is not TRUE'
      USING ERRCODE = '23514';
  END IF;

  -- If the Stage 4 report records explicit bound artifact IDs, ensure freeze matches those exact artifacts
  v_ref_s1 := NULLIF(btrim(COALESCE(v_report_json->>'referenced_stage1_artifact_id', '')), '');
  v_ref_s2 := NULLIF(btrim(COALESCE(v_report_json->>'referenced_stage2_artifact_id', '')), '');
  v_ref_s3 := NULLIF(btrim(COALESCE(v_report_json->>'referenced_stage3_artifact_id', '')), '');
  IF (v_ref_s1 IS NOT NULL AND v_ref_s1 <> NEW.stage1_artifact_id::text)
    OR (v_ref_s2 IS NOT NULL AND v_ref_s2 <> NEW.stage2_artifact_id::text)
    OR (v_ref_s3 IS NOT NULL AND v_ref_s3 <> NEW.stage3_artifact_id::text) THEN
    RAISE EXCEPTION 'Cannot freeze baseline: Stage 1..3 artifact IDs do not match Stage 4 validation report % references',
      NEW.validation_report_artifact_id
      USING ERRCODE = '23514';
  END IF;

  -- M6A-FIX-02: Re-verify Stage 2 AC-10 traceability against live stage1_discovery_items at freeze time
  v_srs := v_stage2_json->'srs';
  IF v_srs IS NULL OR jsonb_typeof(v_srs) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Cannot freeze baseline: Stage 2 artifact % lacks object content_json.srs', NEW.stage2_artifact_id
      USING ERRCODE = '23514';
  END IF;
  v_fr := v_srs->'functional_requirements';
  v_nfr := v_srs->'non_functional_requirements';
  IF (v_fr IS NOT NULL AND jsonb_typeof(v_fr) IS DISTINCT FROM 'array')
    OR (v_nfr IS NOT NULL AND jsonb_typeof(v_nfr) IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'Cannot freeze baseline: invalid Stage 2 requirements array in %', NEW.stage2_artifact_id
      USING ERRCODE = '23514';
  END IF;

  FOR v_req IN
    SELECT elem FROM jsonb_array_elements(COALESCE(v_fr, '[]'::jsonb)) AS elem
    UNION ALL
    SELECT elem FROM jsonb_array_elements(COALESCE(v_nfr, '[]'::jsonb)) AS elem
  LOOP
    IF jsonb_typeof(v_req) IS DISTINCT FROM 'object'
      OR v_req->'source_discovery_item_ids' IS NULL
      OR jsonb_typeof(v_req->'source_discovery_item_ids') IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_req->'source_discovery_item_ids') < 1 THEN
      RAISE EXCEPTION 'AC-10 freeze violation: Stage 2 requirement % lacks source_discovery_item_ids',
        CASE WHEN jsonb_typeof(v_req) = 'object' THEN COALESCE(v_req->>'req_id', 'unknown') ELSE 'unknown' END
        USING ERRCODE = '23514';
    END IF;

    FOR v_src_elem IN
      SELECT elem FROM jsonb_array_elements(v_req->'source_discovery_item_ids') AS elem
    LOOP
      IF jsonb_typeof(v_src_elem) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'AC-10 freeze violation: invalid source ID type in Stage 2 requirement'
          USING ERRCODE = '23514';
      END IF;
      v_src_id_text := v_src_elem #>> '{}';
      IF v_src_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'AC-10 freeze violation: invalid UUID % in Stage 2 requirement', v_src_id_text
          USING ERRCODE = '23514';
      END IF;

      SELECT kind, confirmation_status INTO v_item_kind, v_item_status
      FROM stage1_discovery_items
      WHERE item_id = v_src_id_text::uuid
        AND project_id = NEW.project_id
        AND pipeline_session_id = NEW.pipeline_session_id;

      IF v_item_status IS NULL OR v_item_status NOT IN ('AUTO_VERIFIED', 'CONFIRMED') THEN
        RAISE EXCEPTION 'AC-10 freeze violation: Stage 2 requirement % cites Stage 1 item % (%) with live status %',
          COALESCE(v_req->>'req_id', 'unknown'), v_src_id_text, COALESCE(v_item_kind, 'MISSING'), COALESCE(v_item_status, 'MISSING')
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- 8. Lock ALL immutable columns on frozen product_pipeline_sessions (Minor Note 8)
CREATE OR REPLACE FUNCTION fn_enforce_pipeline_session_freeze_lock()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.created_by_principal_id IS DISTINCT FROM OLD.created_by_principal_id THEN
    RAISE EXCEPTION 'Immutable columns (project_id/created_by_principal_id) on pipeline session % cannot be modified', OLD.pipeline_session_id
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'FROZEN' THEN
    IF NEW.status IS DISTINCT FROM 'FROZEN'
      OR NEW.frozen_baseline_id IS DISTINCT FROM OLD.frozen_baseline_id
      OR NEW.current_stage IS DISTINCT FROM OLD.current_stage
      OR NEW.cost_session_id IS DISTINCT FROM OLD.cost_session_id
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.raw_idea_text IS DISTINCT FROM OLD.raw_idea_text THEN
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

-- 9. Reject stage_approval_gates writes once pipeline session is no longer ACTIVE (Minor Note 17)
CREATE OR REPLACE FUNCTION fn_enforce_stage_approval_gate_invariants()
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
    RAISE EXCEPTION 'Session % is %; new stage approval gates are forbidden after baseline freeze',
      NEW.pipeline_session_id, v_session_status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

DROP TRIGGER IF EXISTS trg_sag_mutable_until_frozen ON stage_approval_gates;
CREATE TRIGGER trg_sag_mutable_until_frozen
  BEFORE INSERT ON stage_approval_gates
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_stage_approval_gate_invariants();
