-- All rows use deterministic IDs, with FK and CHECK constraints enabled.
CREATE TEMP TABLE pending_fixture AS
SELECT g, md5('task-'||g)::uuid AS task, md5('lease-'||g)::uuid AS lease,
       md5('import-'||g)::uuid AS import, md5('candidate-'||g)::uuid AS candidate,
       md5('verify-'||g)::uuid AS verify, md5('review-'||g)::uuid AS review,
       md5('approval-'||g)::uuid AS approval,
       '2025-01-01T00:00:00Z'::timestamptz + g * interval '1 second' AS stamp
FROM generate_series(1,10000) AS g;

INSERT INTO tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash,created_at)
SELECT task,:p,'fixture','{}',CASE WHEN g % 20 = 0 THEN 'AwaitingHumanApproval' ELSE 'Ready' END,
       repeat('a',40),stamp FROM pending_fixture;

INSERT INTO task_leases(lease_id,project_id,task_id,attempt_no,lease_epoch,worker_id,status,task_execution_idempotency_key,expires_at)
SELECT lease,:p,task,1,1,'fixture','COMPLETED',md5(lease::text)||md5(task::text),stamp+interval '1 minute'
FROM pending_fixture;

INSERT INTO verified_code_imports(import_id,project_id,task_id,lease_id,lease_epoch,agent_commit_hash,verified_tree_hash,staging_ref,changed_files_count,deleted_lines_count)
SELECT import,:p,task,lease,1,repeat('b',40),repeat('c',40),'refs/fixture',1,0 FROM pending_fixture;

INSERT INTO merge_candidates(merge_candidate_id,project_id,task_id,import_id,agent_commit_hash,base_main_commit_hash,merge_candidate_hash,verified_tree_hash)
SELECT candidate,:p,task,import,repeat('b',40),repeat('a',40),repeat('d',40),repeat('c',40) FROM pending_fixture;

INSERT INTO verification_runs(verification_run_id,project_id,task_id,merge_candidate_id,merge_candidate_hash,verified_tree_hash,verifier_image_digest,verdict,exit_code,duration_ms,report_sha256)
SELECT verify,:p,task,candidate,repeat('d',40),repeat('c',40),'fixture','PASS',0,1,repeat('e',64)
FROM pending_fixture;

INSERT INTO review_artifacts(review_artifact_id,project_id,task_id,merge_candidate_id,verification_run_id,merge_candidate_hash,verified_tree_hash,writer_provider,writer_model,reviewer_provider,reviewer_model,developer_principal_id,reviewer_principal_id,developer_session_id,reviewer_session_id,verdict)
SELECT review,:p,task,candidate,verify,repeat('d',40),repeat('c',40),'fixture','writer','fixture','reviewer',
       'author','reviewer','author-session','reviewer-session','PASS' FROM pending_fixture;

-- The latest 200 pending records are expired, which exercises the ordered scan's TTL filter.
INSERT INTO approval_requests(approval_request_id,project_id,task_id,merge_candidate_id,agent_commit_hash,base_main_commit_hash,merge_candidate_hash,verified_tree_hash,verification_run_id,review_artifact_id,status,expires_at,created_at)
SELECT approval,:p,task,candidate,repeat('b',40),repeat('a',40),repeat('d',40),repeat('c',40),verify,review,
       CASE WHEN g > 9000 THEN 'PENDING' ELSE 'APPROVED' END,
       CASE WHEN g BETWEEN 9001 AND 9800 THEN now()+interval '1 day' ELSE stamp+interval '1 minute' END,
       stamp FROM pending_fixture;
DROP TABLE pending_fixture;
