-- M6C review notes: definition verification must run before accepting an upgrade.
CREATE OR REPLACE FUNCTION sf_verify_m6c_constraint_definitions() RETURNS void AS $$
DECLARE expected RECORD; actual TEXT;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
('verified_code_imports','uq_vci_submission_binding','UNIQUE (import_id, project_id, task_id, lease_id, lease_epoch, agent_commit_hash, verified_tree_hash, staging_ref)'),
('project_bootstraps','uq_pb_trusted_acceptance_dir','UNIQUE (trusted_acceptance_dir)'),
('merge_candidates','uq_mc_id_project_task','UNIQUE (merge_candidate_id, project_id, task_id)'),
('approval_decisions','uq_ad_id_project_task_candidate','UNIQUE (approval_id, project_id, task_id, merge_candidate_id)'),
('task_dependencies','task_dependencies_dependency_kind_check','CHECK ((dependency_kind = ANY (ARRAY[''PLAN_DAG''::text, ''PATH_OVERLAP_SERIALIZED''::text, ''MANUAL''::text])))'),
('task_dependencies','chk_td_no_self_loop','CHECK ((task_id <> depends_on_task_id))'),
('task_dependencies','task_dependencies_pkey','PRIMARY KEY (project_id, task_id, depends_on_task_id)'),
('task_dependencies','task_dependencies_project_id_fkey','FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT'),
('task_dependencies','fk_td_task','FOREIGN KEY (task_id, project_id) REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT'),
('task_dependencies','fk_td_depends_on','FOREIGN KEY (depends_on_task_id, project_id) REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT'),
('merge_queue_entries','merge_queue_entries_status_check','CHECK ((status = ANY (ARRAY[''QUEUED''::text, ''PROCESSING''::text, ''MERGED''::text, ''REBASED_NEEDS_REVERIFY''::text, ''FAILED''::text, ''CANCELLED''::text])))'),
('merge_queue_entries','merge_queue_entries_attempt_count_check','CHECK ((attempt_count >= 0))'),
('merge_queue_entries','merge_queue_entries_merged_commit_hash_check','CHECK (((merged_commit_hash IS NULL) OR (merged_commit_hash ~ ''^[0-9a-f]{40}$''::text)))'),
('merge_queue_entries','merge_queue_entries_pkey','PRIMARY KEY (queue_entry_id)'),
('merge_queue_entries','merge_queue_entries_project_id_fkey','FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT'),
('merge_queue_entries','fk_mqe_task','FOREIGN KEY (task_id, project_id) REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT'),
('merge_queue_entries','fk_mqe_candidate','FOREIGN KEY (merge_candidate_id, project_id, task_id) REFERENCES merge_candidates(merge_candidate_id, project_id, task_id) ON DELETE RESTRICT'),
('merge_queue_entries','fk_mqe_approval','FOREIGN KEY (approval_id, project_id, task_id, merge_candidate_id) REFERENCES approval_decisions(approval_id, project_id, task_id, merge_candidate_id) ON DELETE RESTRICT'),
('merge_queue_entries','fk_mqe_rebased_from','FOREIGN KEY (rebased_from_candidate_id, project_id, task_id) REFERENCES merge_candidates(merge_candidate_id, project_id, task_id) ON DELETE RESTRICT'),
('merge_queue_entries','fk_mqe_rebased_to','FOREIGN KEY (rebased_to_candidate_id, project_id, task_id) REFERENCES merge_candidates(merge_candidate_id, project_id, task_id) ON DELETE RESTRICT'),
('code_import_submissions','code_import_submissions_lease_epoch_check','CHECK ((lease_epoch >= 1))'),
('project_budget_policies','project_budget_policies_max_project_tokens_check','CHECK (((max_project_tokens IS NULL) OR (max_project_tokens > 0)))'),
('project_budget_policies','project_budget_policies_max_project_cost_micro_usd_check','CHECK (((max_project_cost_micro_usd IS NULL) OR (max_project_cost_micro_usd > 0)))'),
('project_budget_policies','project_budget_policies_max_project_wall_time_ms_check','CHECK (((max_project_wall_time_ms IS NULL) OR (max_project_wall_time_ms > 0)))'),
('project_budget_policies','project_budget_policies_default_task_max_tokens_check','CHECK (((default_task_max_tokens IS NULL) OR (default_task_max_tokens > 0)))'),
('project_budget_policies','project_budget_policies_default_task_max_cost_micro_usd_check','CHECK (((default_task_max_cost_micro_usd IS NULL) OR (default_task_max_cost_micro_usd > 0)))'),
('project_budget_policies','project_budget_policies_default_task_max_wall_time_ms_check','CHECK (((default_task_max_wall_time_ms IS NULL) OR (default_task_max_wall_time_ms > 0)))'),
('project_budget_policies','project_budget_policies_max_concurrent_tasks_check','CHECK (((max_concurrent_tasks >= 1) AND (max_concurrent_tasks <= 128)))'),
('project_budget_policies','project_budget_policies_status_check','CHECK ((status = ANY (ARRAY[''ACTIVE''::text, ''AUTO_PAUSED''::text])))'),
('budget_pause_events','budget_pause_events_event_type_check','CHECK ((event_type = ANY (ARRAY[''AUTO_PAUSED''::text, ''BUDGET_UPDATED''::text, ''RESUMED''::text])))'),
('project_budget_policies','project_budget_policies_pause_scope_check','CHECK (((pause_scope IS NULL) OR (pause_scope = ANY (ARRAY[''PROJECT_TOKENS''::text, ''PROJECT_COST''::text, ''PROJECT_WALL_TIME''::text, ''TASK_TOKENS''::text, ''TASK_COST''::text, ''TASK_WALL_TIME''::text]))))'),
('project_budget_policies','project_budget_policies_pkey','PRIMARY KEY (project_id)'),
('project_budget_policies','project_budget_policies_project_id_fkey','FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT'),
('project_budget_policies','fk_pbp_paused_task','FOREIGN KEY (paused_task_id, project_id) REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT'),
('task_budget_policies','task_budget_policies_max_task_tokens_check','CHECK (((max_task_tokens IS NULL) OR (max_task_tokens > 0)))'),
('task_budget_policies','task_budget_policies_max_task_cost_micro_usd_check','CHECK (((max_task_cost_micro_usd IS NULL) OR (max_task_cost_micro_usd > 0)))'),
('task_budget_policies','task_budget_policies_max_task_wall_time_ms_check','CHECK (((max_task_wall_time_ms IS NULL) OR (max_task_wall_time_ms > 0)))'),
('task_budget_policies','task_budget_policies_status_check','CHECK ((status = ANY (ARRAY[''ACTIVE''::text, ''AUTO_PAUSED''::text])))'),
('task_budget_policies','task_budget_policies_pause_scope_check','CHECK (((pause_scope IS NULL) OR (pause_scope = ANY (ARRAY[''TASK_TOKENS''::text, ''TASK_COST''::text, ''TASK_WALL_TIME''::text]))))'),
('task_budget_policies','task_budget_policies_pkey','PRIMARY KEY (project_id, task_id)'),
('task_budget_policies','task_budget_policies_project_id_fkey','FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT'),
('task_budget_policies','fk_tbp_task','FOREIGN KEY (task_id, project_id) REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT'),
('budget_pause_events','budget_pause_events_pause_scope_check','CHECK (((pause_scope IS NULL) OR (pause_scope = ANY (ARRAY[''PROJECT_TOKENS''::text, ''PROJECT_COST''::text, ''PROJECT_WALL_TIME''::text, ''TASK_TOKENS''::text, ''TASK_COST''::text, ''TASK_WALL_TIME''::text]))))'),
('budget_pause_events','budget_pause_events_reason_check','CHECK ((btrim(reason) <> ''''::text))'),
('budget_pause_events','budget_pause_events_observed_tokens_check','CHECK ((observed_tokens >= 0))'),
('budget_pause_events','budget_pause_events_observed_cost_micro_usd_check','CHECK ((observed_cost_micro_usd >= 0))'),
('budget_pause_events','budget_pause_events_observed_wall_time_ms_check','CHECK ((observed_wall_time_ms >= 0))'),
('budget_pause_events','budget_pause_events_pkey','PRIMARY KEY (event_id)'),
('budget_pause_events','budget_pause_events_project_id_fkey','FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE RESTRICT'),
('budget_pause_events','fk_bpe_task','FOREIGN KEY (task_id, project_id) REFERENCES tasks(task_id, project_id) ON DELETE RESTRICT'),
('code_import_submissions','code_import_submissions_source_type_check','CHECK ((source_type = ANY (ARRAY[''bundle''::text, ''patch''::text, ''artifact''::text])))'),
('code_import_submissions','code_import_submissions_payload_sha256_check','CHECK ((payload_sha256 ~ ''^[0-9a-f]{64}$''::text))'),
('code_import_submissions','code_import_submissions_agent_commit_hash_check','CHECK ((agent_commit_hash ~ ''^[0-9a-f]{40}$''::text))'),
('code_import_submissions','code_import_submissions_verified_tree_hash_check','CHECK ((verified_tree_hash ~ ''^[0-9a-f]{40}$''::text))'),
('code_import_submissions','code_import_submissions_submitted_by_principal_id_check','CHECK ((length(btrim(submitted_by_principal_id)) > 0))'),
('code_import_submissions','code_import_submissions_pkey','PRIMARY KEY (submission_id)'),
('code_import_submissions','code_import_submissions_project_id_lease_id_key','UNIQUE (project_id, lease_id)'),
('code_import_submissions','code_import_submissions_import_id_project_id_task_id_lease_fkey','FOREIGN KEY (import_id, project_id, task_id, lease_id, lease_epoch, agent_commit_hash, verified_tree_hash, staging_ref) REFERENCES verified_code_imports(import_id, project_id, task_id, lease_id, lease_epoch, agent_commit_hash, verified_tree_hash, staging_ref) ON DELETE RESTRICT')
  ) AS definitions(table_name, constraint_name, definition) LOOP
    SELECT pg_get_constraintdef(c.oid) INTO actual FROM pg_constraint c
      WHERE c.conrelid = to_regclass('public.' || expected.table_name) AND c.conname = expected.constraint_name;
    IF actual IS DISTINCT FROM expected.definition THEN
      RAISE EXCEPTION 'M6C constraint definition mismatch: %.%', expected.table_name, expected.constraint_name USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public;
SELECT sf_verify_m6c_constraint_definitions();

CREATE INDEX IF NOT EXISTS idx_code_import_submissions_lease ON code_import_submissions(lease_id);

CREATE OR REPLACE FUNCTION fn_m6c_merge_queue_transition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUEUED' OR NEW.attempt_count <> 0 OR NEW.started_at IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.merged_commit_hash IS NOT NULL OR NEW.rebased_to_candidate_id IS NOT NULL THEN
      RAISE EXCEPTION 'Merge queue entry must start QUEUED' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.queue_entry_id,NEW.project_id,NEW.task_id,NEW.merge_candidate_id,NEW.approval_id,NEW.queue_position,NEW.enqueued_at,NEW.rebased_from_candidate_id)
    IS DISTINCT FROM ROW(OLD.queue_entry_id,OLD.project_id,OLD.task_id,OLD.merge_candidate_id,OLD.approval_id,OLD.queue_position,OLD.enqueued_at,OLD.rebased_from_candidate_id) THEN
    RAISE EXCEPTION 'Merge queue identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF OLD.status = 'QUEUED' AND NEW.status = 'PROCESSING' AND NEW.attempt_count = OLD.attempt_count + 1
    AND NEW.started_at IS NOT NULL AND NEW.completed_at IS NULL AND NEW.merged_commit_hash IS NULL AND NEW.rebased_to_candidate_id IS NULL THEN RETURN NEW; END IF;
  IF OLD.status = 'PROCESSING' AND NEW.status IN ('MERGED','REBASED_NEEDS_REVERIFY','FAILED','CANCELLED')
    AND NEW.attempt_count = OLD.attempt_count AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at AND NEW.completed_at IS NOT NULL
    AND (NEW.status <> 'MERGED' OR NEW.merged_commit_hash IS NOT NULL)
    AND (NEW.status <> 'REBASED_NEEDS_REVERIFY' OR NEW.rebased_to_candidate_id IS NOT NULL) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Invalid merge queue transition: % -> %',OLD.status,NEW.status USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;
DROP TRIGGER IF EXISTS trg_m6c_merge_queue_transition ON merge_queue_entries;
CREATE TRIGGER trg_m6c_merge_queue_transition BEFORE INSERT OR UPDATE ON merge_queue_entries
  FOR EACH ROW EXECUTE FUNCTION fn_m6c_merge_queue_transition();

-- Match ECMAScript Object.keys().sort(): order keys by UTF-16 code units.
CREATE OR REPLACE FUNCTION sf_json_utf16_key(value TEXT) RETURNS TEXT AS $$
DECLARE result TEXT := ''; cp INTEGER; i INTEGER;
BEGIN
  FOR i IN 1..length(value) LOOP
    cp := ascii(substr(value,i,1));
    IF cp > 65535 THEN
      result := result || lpad(to_hex(55296 + (cp-65536)/1024),4,'0') || lpad(to_hex(56320 + (cp-65536)%1024),4,'0');
    ELSE result := result || lpad(to_hex(cp),4,'0'); END IF;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog;

CREATE OR REPLACE FUNCTION sf_canonical_json(value JSONB) RETURNS TEXT AS $$
DECLARE result TEXT; number_value DOUBLE PRECISION; number_text TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(string_agg(to_json(key)::text || ':' || public.sf_canonical_json(val),',' ORDER BY public.sf_json_utf16_key(key) COLLATE "C"),'') || '}'
      INTO result FROM jsonb_each(value) AS pairs(key,val); RETURN result;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(public.sf_canonical_json(val),',' ORDER BY ordinal),'') || ']'
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS items(val,ordinal); RETURN result;
    WHEN 'number' THEN
      number_value := (value::text)::double precision;
      IF number_value = 0 THEN RETURN '0'; END IF;
      number_text := number_value::text;
      IF abs(number_value) >= 0.000001 AND abs(number_value) < 1e21 THEN RETURN trim_scale(number_text::numeric)::text; END IF;
      RETURN regexp_replace(number_text,'e([+-])0+','e\1');
    ELSE RETURN value::text;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog SET extra_float_digits = 3;

CREATE OR REPLACE FUNCTION fn_stage_artifact_canonical_sha256() RETURNS trigger AS $$
BEGIN
  IF NEW.artifact_sha256 IS DISTINCT FROM encode(public.digest(convert_to(public.sf_canonical_json(NEW.content_json),'UTF8'),'sha256'),'hex') THEN
    RAISE EXCEPTION 'Stage artifact canonical SHA-256 mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public;
DROP TRIGGER IF EXISTS trg_stage_artifact_canonical_sha256 ON stage_artifacts;
CREATE TRIGGER trg_stage_artifact_canonical_sha256 BEFORE INSERT OR UPDATE ON stage_artifacts
  FOR EACH ROW EXECUTE FUNCTION fn_stage_artifact_canonical_sha256();
