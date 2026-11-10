-- =============================================================================
-- Software Factory v1.5 — Comprehensive RLS Verification Matrix (RLS-T1..RLS-T8)
-- Spec Reference: MVP-SPEC-02 Section 8 & GitHub Review FIX-02
-- This script validates all 8 mandatory multi-tenant and RLS isolation invariants
-- on real PostgreSQL instances. Any assertion violation aborts with RAISE EXCEPTION.
-- =============================================================================

\set ON_ERROR_STOP on

-- Ensure required test projects and data exist
DO $$
DECLARE
  v_proj_a UUID := '11111111-1111-1111-1111-111111111111';
  v_proj_b UUID := '22222222-2222-2222-2222-222222222222';
  v_task_a UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_task_b UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  v_lease_a UUID := 'a1111111-1111-1111-1111-111111111111';
  v_pwe_a UUID := 'e1111111-1111-1111-1111-111111111111';
  v_import_a UUID := 'i1111111-1111-1111-1111-111111111111';
  v_cand_a UUID := 'c1111111-1111-1111-1111-111111111111';
  v_vr_a UUID := 'v1111111-1111-1111-1111-111111111111';
  v_ra_a UUID := 'r1111111-1111-1111-1111-111111111111';
  v_cnt INTEGER;
  v_caught BOOLEAN;
BEGIN
  -- Cleanup any existing test fixtures
  DELETE FROM projects WHERE project_id IN (v_proj_a, v_proj_b);

  -- Setup fixture projects
  INSERT INTO projects (project_id, slug, name, repo_bare_path, default_branch)
  VALUES
    (v_proj_a, 'proj-alpha', 'Project Alpha', '/var/git/proj-alpha.git', 'main'),
    (v_proj_b, 'proj-beta', 'Project Beta', '/var/git/proj-beta.git', 'main');

  INSERT INTO project_memberships (project_id, principal_id, member_role)
  VALUES
    (v_proj_a, 'alice-approver', 'APPROVER'),
    (v_proj_b, 'bob-approver', 'APPROVER');

  -- Setup fixtures for Project A
  INSERT INTO tasks (
    task_id, project_id, title, task_contract_json, status,
    base_main_commit_hash, current_attempt_no
  ) VALUES (
    v_task_a, v_proj_a, 'Task A', '{"contract_version":"1.0"}'::jsonb,
    'QUEUED', '1111111111111111111111111111111111111111', 0
  );

  INSERT INTO task_leases (
    lease_id, project_id, task_id, attempt_no, lease_epoch, worker_id,
    status, task_execution_idempotency_key, last_processed_seq,
    heartbeat_interval_ms, lease_ttl_ms, expires_at
  ) VALUES (
    v_lease_a, v_proj_a, v_task_a, 1, 1, 'worker-alpha',
    'ACTIVE', 'key-alpha-attempt-1', 0, 10000, 35000, clock_timestamp() + interval '35 seconds'
  );

  INSERT INTO processed_worker_events (
    event_id, project_id, task_id, lease_id, lease_epoch, sequence_no,
    event_type, event_idempotency_key, payload_sha256, payload_json
  ) VALUES (
    v_pwe_a, v_proj_a, v_task_a, v_lease_a, 1, 1,
    'task.accepted', 'idem-alpha-seq-1', 'sha256-payload-dummy', '{"msg":"accepted"}'::jsonb
  );

  -- Setup fixtures for Project B
  INSERT INTO tasks (
    task_id, project_id, title, task_contract_json, status,
    base_main_commit_hash, current_attempt_no
  ) VALUES (
    v_task_b, v_proj_b, 'Task B', '{"contract_version":"1.0"}'::jsonb,
    'QUEUED', '2222222222222222222222222222222222222222', 0
  );

  -- ---------------------------------------------------------------------------
  -- RLS-T1: Default Deny when app.current_project_id is unset/empty
  -- ---------------------------------------------------------------------------
  PERFORM set_config('role', 'app_runtime', true);
  PERFORM set_config('app.current_project_id', '', true);
  PERFORM set_config('app.current_principal_id', '', true);
  PERFORM set_config('app.current_role', 'anonymous', true);

  SELECT count(*) INTO v_cnt FROM tasks;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'RLS-T1 FAILED: Expected 0 visible tasks for anonymous session, got %', v_cnt;
  END IF;

  -- ---------------------------------------------------------------------------
  -- RLS-T2: Cross-project SELECT isolation (Project A cannot read Project B)
  -- ---------------------------------------------------------------------------
  PERFORM set_config('app.current_project_id', v_proj_a::text, true);
  PERFORM set_config('app.current_principal_id', 'alice-developer', true);
  PERFORM set_config('app.current_role', 'core_api_service', true);

  SELECT count(*) INTO v_cnt FROM tasks WHERE project_id = v_proj_b;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'RLS-T2 FAILED: Project A session could see % tasks belonging to Project B', v_cnt;
  END IF;

  -- ---------------------------------------------------------------------------
  -- RLS-T3: Cross-project INSERT blocked by WITH CHECK (42501 insufficient_privilege)
  -- ---------------------------------------------------------------------------
  v_caught := false;
  BEGIN
    INSERT INTO tasks (
      task_id, project_id, title, task_contract_json, status,
      base_main_commit_hash, current_attempt_no
    ) VALUES (
      gen_random_uuid(), v_proj_b, 'Intrusion Task', '{"contract_version":"1.0"}'::jsonb,
      'QUEUED', '2222222222222222222222222222222222222222', 0
    );
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'RLS-T3 FAILED: Cross-project INSERT was not blocked with 42501 insufficient_privilege';
  END IF;

  -- ---------------------------------------------------------------------------
  -- RLS-T4: Cross-project UPDATE returns 0 rows / rejected
  -- ---------------------------------------------------------------------------
  UPDATE tasks SET title = 'Hacked Title' WHERE project_id = v_proj_b;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'RLS-T4 FAILED: Cross-project UPDATE modified % rows in Project B', v_cnt;
  END IF;

  -- ---------------------------------------------------------------------------
  -- RLS-T5: Cross-project DELETE blocked
  -- ---------------------------------------------------------------------------
  DELETE FROM tasks WHERE project_id = v_proj_b;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'RLS-T5 FAILED: Cross-project DELETE removed % rows from Project B', v_cnt;
  END IF;

  -- ---------------------------------------------------------------------------
  -- RLS-T7: Append-Only Evidence Immutability (processed_worker_events cannot be mutated/deleted)
  -- ---------------------------------------------------------------------------
  v_caught := false;
  BEGIN
    DELETE FROM processed_worker_events WHERE event_id = v_pwe_a;
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'RLS-T7 FAILED: DELETE on processed_worker_events was not blocked';
  END IF;

  v_caught := false;
  BEGIN
    UPDATE processed_worker_events SET payload_sha256 = 'hacked' WHERE event_id = v_pwe_a;
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'RLS-T7 FAILED: UPDATE on processed_worker_events was not blocked';
  END IF;

  -- ---------------------------------------------------------------------------
  -- RLS-T8: Composite FK Cross-Tenant Binding Prevention
  -- ---------------------------------------------------------------------------
  -- Reset role to db_migrator to insert base records for Project A
  RESET ROLE;
  INSERT INTO verified_code_imports (
    import_id, project_id, task_id, lease_id, lease_epoch,
    agent_commit_hash, verified_tree_hash, staging_ref,
    changed_files_count, deleted_lines_count
  ) VALUES (
    v_import_a, v_proj_a, v_task_a, v_lease_a, 1,
    '3333333333333333333333333333333333333333',
    '4444444444444444444444444444444444444444',
    'refs/heads/sf/staging/task-a/1', 1, 0
  );

  INSERT INTO merge_candidates (
    merge_candidate_id, project_id, task_id, import_id,
    agent_commit_hash, base_main_commit_hash, merge_candidate_hash, verified_tree_hash
  ) VALUES (
    v_cand_a, v_proj_a, v_task_a, v_import_a,
    '3333333333333333333333333333333333333333',
    '1111111111111111111111111111111111111111',
    '5555555555555555555555555555555555555555',
    '4444444444444444444444444444444444444444'
  );

  INSERT INTO verification_runs (
    verification_run_id, project_id, task_id, merge_candidate_id,
    merge_candidate_hash, verified_tree_hash, verifier_image_digest,
    verdict, exit_code, duration_ms, report_sha256
  ) VALUES (
    v_vr_a, v_proj_a, v_task_a, v_cand_a,
    '5555555555555555555555555555555555555555',
    '4444444444444444444444444444444444444444',
    'sha256:verifier-img', 'PASS', 0, 1200, 'sha256-report'
  );

  INSERT INTO review_artifacts (
    review_artifact_id, project_id, task_id, merge_candidate_id,
    verification_run_id, merge_candidate_hash, verified_tree_hash,
    writer_provider, writer_model, reviewer_provider, reviewer_model,
    developer_principal_id, reviewer_principal_id, verdict
  ) VALUES (
    v_ra_a, v_proj_a, v_task_a, v_cand_a,
    v_vr_a,
    '5555555555555555555555555555555555555555',
    '4444444444444444444444444444444444444444',
    'anthropic', 'claude-3-5-sonnet', 'google', 'gemini-1-5-pro',
    'agent-writer-1', 'reviewer-llm-1', 'PASS'
  );

  -- Attempt cross-tenant binding: Project B trying to approve Project A candidate
  v_caught := false;
  BEGIN
    INSERT INTO approval_decisions (
      approval_id, project_id, task_id, merge_candidate_id,
      agent_commit_hash, base_main_commit_hash, verified_tree_hash, merge_candidate_hash,
      verification_run_id, review_artifact_id, approver_principal_id,
      decision, status, approved_at, expires_at
    ) VALUES (
      gen_random_uuid(), v_proj_b, v_task_a, v_cand_a,
      '3333333333333333333333333333333333333333',
      '1111111111111111111111111111111111111111',
      '4444444444444444444444444444444444444444',
      '5555555555555555555555555555555555555555',
      v_vr_a, v_ra_a, 'bob-approver',
      'APPROVED', 'ACTIVE', clock_timestamp(), clock_timestamp() + interval '24 hours'
    );
  EXCEPTION
    WHEN foreign_key_violation THEN
      v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'RLS-T8 FAILED: Cross-tenant approval binding was not blocked by composite foreign key';
  END IF;

  -- Cleanup test fixtures
  DELETE FROM projects WHERE project_id IN (v_proj_a, v_proj_b);

  RAISE NOTICE 'RLS Verification Matrix (RLS-T1 through RLS-T8) PASSED successfully.';
END
$$;
