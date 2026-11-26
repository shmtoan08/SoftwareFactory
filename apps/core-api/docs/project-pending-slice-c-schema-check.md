# Slice C project pending probe schema check

**Stopped before fixture setup and EXPLAIN.** The migration-defined schema at
`6aad381764390f1e67a385ccc85217d77dd0856b` differs from the supplied index
inventory. The following inventory includes indexes created by PRIMARY KEY and
UNIQUE constraints.

| Table | Migration-defined indexes |
| --- | --- |
| `change_requests` | PRIMARY KEY `(cr_id)`; `uq_cr_id_project (cr_id, project_id)`; `uq_cr_project_baseline_key (project_id, baseline_id, cr_key)`; `idx_cr_project_session (project_id, pipeline_session_id, created_at DESC)`; `idx_change_requests_decided_timeline (project_id, pipeline_session_id, decided_at DESC, cr_id DESC) WHERE decided_at IS NOT NULL`; `idx_change_requests_submitted_timeline (project_id, pipeline_session_id, created_at DESC, cr_id DESC)`; `idx_change_requests_applied_timeline (project_id, pipeline_session_id, applied_at DESC, cr_id DESC) WHERE applied_at IS NOT NULL`. |
| `approval_requests` | PRIMARY KEY `(approval_request_id)`; `uq_ar_id_project (approval_request_id, project_id)`; `uq_ar_composite_binding (approval_request_id, project_id, task_id, merge_candidate_id, agent_commit_hash, base_main_commit_hash, merge_candidate_hash, verified_tree_hash, verification_run_id, review_artifact_id)`; `uq_one_pending_approval_request_per_candidate (merge_candidate_id) WHERE status = 'PENDING'`. |
| `tasks` | PRIMARY KEY `(task_id)`; `uq_tasks_id_project (task_id, project_id)`. The migrations define no index on `(project_id, status)`. |

The `change_requests` inventory includes two unique constraints and a primary
key that lack the `(project_id, pipeline_session_id)` prefix. The
`approval_requests` inventory includes the composite binding constraint, and
the partial unique index has the full name shown above. The predicates in the
brief match the migration status values. Pending change requests require
`decided_at` and `applied_at` to be NULL, and approval requests have nonnull
`expires_at` with `expires_at > created_at`.

Sources

- [Tasks schema 0001](../../../packages/database/migrations/0001_mvp_core_schema_and_rls.sql#L67-L99)
- [Approval requests schema and index 0004](../../../packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql#L107-L156)
- [Change requests schema and index 0008](../../../packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql#L168-L230)
- [Decided index 0031](../../../packages/database/migrations/0031_timeline_read_indexes.sql#L6-L8)
- [Submitted index 0032](../../../packages/database/migrations/0032_change_request_submitted_timeline_index.sql#L2-L3)
- [Applied index 0033](../../../packages/database/migrations/0033_change_request_applied_timeline_index.sql#L2-L4)

Q1, Q2a, Q2b and Q3 were not run. Row counts, plan nodes, buffers, timings and
index recommendations remain unmeasured on PostgreSQL 16.16 and 17.12.
