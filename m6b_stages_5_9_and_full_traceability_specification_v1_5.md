# Software Factory v1.5 — Milestone M6B Specification (`M6B-SPEC-01`)
## Stages 5–9 Software Development Lifecycle, Multi-Target Execution Model & 100% Bidirectional Traceability (`AC-11b`)

**Document ID:** `M6B-SPEC-01`  
**Version:** `1.5.0`  
**Status:** Normative Implementation Specification for Milestone `M6B` (Phase 7)  
**Prerequisites:** `MVP-SPEC-01..05` (`M1`–`M5`), `M6A-SPEC-01` (`M6A`, `AC-10`, `AC-12b`, Stages 1–4 Baseline Freeze)

---

## 1. Scope & Architectural Continuity

Milestone `M6B` completes the **Stage 1 → Stage 9** end-to-end Software Factory lifecycle by bridging frozen Stage 4 specifications (`BaselineSpecFreezeRecord` with `status = 'FROZEN'`) into automated project bootstrap (**Stage 5**), org-level multi-target agent profiles & 3D separation (**Stage 6**), structured LLM development planning (**Stage 7**), real Stage 8 execution & merge verification (`M5`), post-freeze Change Request control (**Stage 9 CR**), **100% Bidirectional Traceability Matrix (`AC-11b`)**, and cryptographically sealed **Release Acceptance Packages**.

### 1.1 Hard Invariants Preserved from M1–M6A
1. **Frozen Baseline Immutability (`0006` / `0007`):** Once `product_pipeline_sessions.status = 'FROZEN'`, `stage1_discovery_items`, `stage_artifacts`, `stage_approval_gates`, `baseline_spec_freezes`, and `product_pipeline_sessions.current_stage/status/frozen_baseline_id` remain permanently immutable. Stages 5, 7, and 9 anchor strictly via composite foreign keys `(baseline_id, project_id, pipeline_session_id)` without mutating frozen artifacts or resetting `product_pipeline_sessions`.
2. **Existing `tasks` Contract Stability (`M1`–`M5`):** Core `tasks` columns, `TaskContractSpec`, 11-state lifecycle, lease epochs, Gatekeeper validation, `Docker3TierVerifier`, `IndependentReviewerService`, Human Approval Binding (`8` fields), and `AtomicCasMerge` remain unchanged. Stage 7 and Stage 9 materialize real `tasks` rows linked through `task_plan_links`.
3. **4-Tier Tenant Isolation & Fail-Closed RLS (`0008`):** Every new table has `ENABLE` + `FORCE ROW LEVEL SECURITY`, `REVOKE ALL FROM PUBLIC`, explicit least-privilege `app_runtime` grants, composite tenant-scoped foreign keys `(..., project_id)`, and append-only revocation (`REVOKE UPDATE, DELETE`) on immutable ledger/artifact/release records.

---

## 2. Stage 5 — User Project Bootstrapper (`project_bootstraps`)

Given a `FROZEN` `BaselineSpecFreezeRecord`:
1. **Validation:** Verify `session.status === 'FROZEN'`, `baseline.status === 'FROZEN'`, and load frozen `STAGE_2_PRD_SRS` & `STAGE_3_ARCHITECTURE_DESIGN`. Reject duplicate bootstrap attempts for the same `(project_id, baseline_id)` (`SQLSTATE 23505`).
2. **Protected Paths Generation:** Create immutable governance and integrity test files in the user project repository:
   - `policy/trusted-verification-policy.json` (canonical manifest of `baseline_id`, `pipeline_session_id`, `stage2_artifact_sha256`, `stage3_artifact_sha256`, `protected_paths`, requirement → AC mappings)
   - `tests/protected/baseline-spec.test.mjs` (Tier 2 integrity test validating protected baseline manifest consistency)
   - `protected_paths` = `["policy/trusted-verification-policy.json", "tests/protected/**", "README.md", "package.json"]` (plus caller extensions if non-overlapping).
3. **Trusted Acceptance Tests (`trusted_acceptance_dir`):** Outside the agent-writable repository workspace, synthesize runnable `node:test` acceptance suites (`acceptance.test.mjs`) mapped 1:1 from every frozen Stage 2 `acceptance_criteria[]` (`ac_id`, `req_id`, `given`, `when`, `then`).
   - Supports custom per-`ac_id` behavioral test checks (`acceptance_specs`) and deterministic generic Stage 3 component deliverable assertions (`src/components/<component-slug>.mjs` or mapped deliverable modules verifying implemented `ac_id`s).
   - Computes `trusted_policy_sha256 = computeDirectorySha256(trusted_acceptance_dir)` identically to `Docker3TierVerifier` so Stage 8 verification enforces cryptographic policy pinning (`TaskContractSpec.trusted_policy_sha256`).
4. **Git Initialization / Commit on `refs/heads/main`:** Initialize or fast-forward commit the bootstrapped baseline onto `refs/heads/main` in `repo_path` (`bare` or working repo), capture the resulting 40-hex `base_main_commit_hash`, update `projects.main_ref_commit_hash` (`0007` column-level `UPDATE` grant), and insert the immutable `project_bootstraps` row with `bootstrap_sha256`.

---

## 3. Stage 6 — Agent Organization & Multi-Target Execution Binding (`agent_organization_profiles`)

1. **Roles:** `PLANNER`, `DEVELOPER`, `REVIEWER_READONLY`, `VERIFIER`.
2. **Execution Target Taxonomy:**
   - `factory_managed_worker` (`TIER_1_FACTORY_MANAGED`)
   - `user_managed_worker` (`TIER_2_USER_MANAGED`)
   - `provider_managed_vm` (`TIER_3_PROVIDER_VM`)
   - `remote_agent_session` (`TIER_4_REMOTE_SESSION`)
3. **3D Reviewer Separation Enforcement:** When pairing or validating a `DEVELOPER` profile against a `REVIEWER_READONLY` profile, Stage 6 & Core API strictly enforce all 3 orthogonal axes:
   - Distinct identity (`lower(btrim(dev.principal_id)) !== lower(btrim(rev.principal_id))`)
   - Distinct profile (`dev.agent_profile_id !== rev.agent_profile_id` / `dev.profile_id !== rev.profile_id`)
   - Distinct provider+model pair (`(lower(btrim(dev.provider)), lower(btrim(dev.model))) !== (lower(btrim(rev.provider)), lower(btrim(rev.model)))`)
4. **RBAC:** Upserting/modifying profiles requires `MUTATION_ROLES` (`DEVELOPER`, `PROJECT_APPROVER`, `ORG_ADMIN`); listing requires `READ_ROLES`.

---

## 4. Stage 7 — Automated Development Planning & Task Materialization

Tables: `dev_milestones`, `dev_epics`, `dev_user_stories`, `task_plan_links`.

1. **Prompt Registry & AC-12b Cost Guard:** Uses versioned immutable prompt `stage7.planning.decompose@1.0.0` with fail-closed `STAGE7_PLANNING_OUTPUT_SCHEMA`, `ManagedModelProviderExecutor`, `AC-12b` preflight + actual ledger recording tied to the session's `cost_session_id`. Model calls run **outside** open SQL transactions.
2. **Plan Completeness & Security Validation (`validateStage7PlanCoverage`):**
   - Every Stage 2 `req_id` (FR + NFR) MUST be covered by ≥ 1 story and ≥ 1 planned task (`100%` requirement coverage).
   - Zero unknown/dangling `req_id`s or `ac_id`s are permitted.
   - Task `allowed_files` must be safe relative POSIX paths, must NEVER overlap Stage 5 `protected_paths` or `DEFAULT_SYSTEM_FORBIDDEN_PATHS` (`.git/**`, `.github/workflows/**`, `.env*`, `**/*.pem`, `**/*.key`, etc.).
   - All `depends_on_task_keys` and `story_key` references must resolve strictly inside the plan.
3. **Control Plane Materialization:** Within a short atomic RLS write transaction:
   - Persist `dev_milestones`, `dev_epics`, `dev_user_stories`.
   - Materialize real Stage 8 `tasks` rows with `TaskContractSpec` inheriting Stage 5 `protected_paths` & `trusted_policy_sha256` and current `base_main_commit_hash`.
   - Persist `task_plan_links` linking `(task_id, story_id, baseline_id, bootstrap_id, assigned_profile_id, requirement_ids, ac_ids)`.

---

## 5. Stage 8 — Execution & Merge Bridge

Each materialized Stage 8 task executes identically to `M5`:
- `WnaWorkerDaemon` isolated workspace (`allowed_files` + path precedence enforcement) → Git push Gatekeeper → `BuildMergeCandidate` → `Docker3TierVerifier` (verifying Stage 5 `trusted_policy_sha256` + running Stage 5 `acceptance.test.mjs` & Tier 2 `protected_paths`) → `IndependentReviewerService` (validated against Stage 6 3D separation) → `HumanApproval` (`PROJECT_APPROVER`/`ORG_ADMIN`) → `AtomicCasMerge` (`refs/heads/main`).

---

## 6. Stage 9 — Change Requests (`change_requests`), `AC-11b` Bidirectional Traceability & Release Acceptance (`release_acceptance_packages`)

### 6.1 Post-Freeze Change Requests (`change_requests`)
- Direct mutation of frozen Stage 1–4 records remains blocked by `0006`/`0007` DB triggers.
- Post-freeze changes are submitted as `ChangeRequestRecord` (`PENDING_APPROVAL`) targeting specific `impacted_requirement_ids`, `impacted_component_ids`, and `proposed_tasks[]`.
- **Workflow State Machine (DB Trigger `fn_enforce_change_request_transitions`):**
  - `PENDING_APPROVAL → APPROVED | REJECTED` (RBAC strictly `PROJECT_APPROVER` or `ORG_ADMIN`; `DEVELOPER`/`AUDITOR` denied `403`).
  - `APPROVED → APPLIED` via `applyChangeRequestAndMaterializeTasks`: materializes new Stage 8 `tasks` inheriting Stage 5 `protected_paths` & `trusted_policy_sha256` and links via `task_plan_links.cr_id`.
  - DB trigger `fn_enforce_task_plan_link_invariants` strictly rejects any `task_plan_links` with non-null `cr_id` unless the referenced CR has `status = 'APPROVED'`.
  - `REJECTED` and `APPLIED` are terminal; immutable CR payload columns cannot be altered once created.

### 6.2 `AC-11b` — 100% Bidirectional Traceability Matrix
`buildBidirectionalTraceabilityMatrix` inspects Stages 1, 2, 3, 5, 7, 8 (`getCandidateBoundLineage` for each linked task), and Stage 9 (`APPLIED` CRs):
- **Per-Requirement Chain (`req_id`):**
  - **Stage 1:** `stage1_item_ids[]` (each verified `AUTO_VERIFIED` or `CONFIRMED`, non-empty)
  - **Stage 2:** `ac_ids[]` (≥ 1 acceptance criterion in frozen Stage 2)
  - **Stage 3:** at least one architectural component (`stage3_component_ids[]`) AND technical design reference (`stage3_erd_tables` / `stage3_api_endpoints` / `stage3_security_controls` / `stage3_adr_ids`)
  - **Stage 5:** `bootstrap_id` + covered `trusted_acceptance_test_files[]` covering all `ac_ids[]`
  - **Stage 7:** `milestone_ids[]`, `epic_ids[]`, `story_ids[]`, `task_ids[]` (and valid `TaskContractSpec` with Stage 5 `trusted_policy_sha256`)
  - **Stage 8:** for the requirement's latest/active linked implementation path (including applied CR tasks when an applied CR supersedes/extends a requirement): `MergedAndCompleted`, valid non-empty `lease_ids`, `import_ids`, `merge_candidate_ids`, PASS `verification_run_ids`, PASS `review_session_ids` + `review_artifact_ids`, APPROVED `approval_request_ids` + `approval_decision_ids`, `merged_commit_hash` present (and reachable on `refs/heads/main` when checked against repo).
  - **Stage 9:** any applied `cr_id`s targeting `req_id` must have their CR-linked tasks likewise `MergedAndCompleted` with complete Stage 8 lineage.
- **Bidirectional Indexes & Metrics:**
  - `forward_index`: `req_id → Stage 1 → Stage 2 ACs → Stage 3 → Stage 5 → Stage 7 → Stage 8 → Stage 9 CRs`
  - `backward_index`: `main commit / task / story / CR / trusted test / component / AC / Stage 1 item → req_id[]`
  - `orphan_links`: detects any tasks/stories/CRs/artifacts referencing unknown `req_id`s or unlinked tasks.
  - `coverage_percent`: `floor((covered_requirements / total_requirements) * 10000) / 100` (100 ONLY when every requirement is 100% linked forward & backward AND `orphan_links.length === 0` AND `missing_links.length === 0`).
  - `traceability_sha256`: canonical JSON SHA-256 of the matrix body.

### 6.3 Release Acceptance Package (`release_acceptance_packages`)
- Strictly **append-only** (`REVOKE UPDATE, DELETE FROM app_runtime`).
- Strictly requires `PROJECT_APPROVER` or `ORG_ADMIN`.
- Strictly **fail-closed (`422` / `SQLSTATE 23514`)** unless `matrix.complete === true && matrix.coverage_percent === 100 && matrix.missing_links.length === 0 && matrix.orphan_links.length === 0`.
- Reinforced by PostgreSQL CHECK constraint `chk_rap_complete_100 CHECK (coverage_percent = 100 AND is_complete = TRUE)`.

---

## 7. Binary Acceptance Criteria (`M6B-AC1` .. `M6B-AC7`)

| Criterion | Description | Pass Condition |
|---|---|---|
| `M6B-AC1` | Stage 5 Project Bootstrapper | Frozen baseline generates Git `main` commit, `protected_paths`, matching `trusted_policy_sha256`, and runnable `node:test` acceptance tests derived from Stage 2 ACs; unimplemented workspace fails Tier 1 acceptance, implemented workspace passes. |
| `M6B-AC2` | Stage 6 Org Profiles & 3D Separation | All 4 roles + 4 execution target types + 4 trust tiers persist in Postgres; 3D reviewer separation rejects matching principal/profile/provider+model. |
| `M6B-AC3` | Stage 7 LLM Planning + `AC-12b` | `stage7.planning.decompose@1.0.0` runs outside TX with schema + cost guard; 100% req coverage validated; missing/dangling `req_id` or `protected_paths` overlap rejected; real Stage 8 `tasks` & `task_plan_links` created. |
| `M6B-AC4` | Real Stage 1 → Stage 9 E2E Vertical Slice | Idea → Stage 4 Freeze → Stage 5 Bootstrap → Stage 6 Profiles → Stage 7 Tasks → Stage 8 Real Git/WNA/Gatekeeper/Verifier/3D Review/Human Approval/CAS Merge → `AC-11b` 100% matrix. |
| `M6B-AC5` | Stage 9 CR & Release Acceptance | Direct baseline mutation blocked; `CR` requires `PROJECT_APPROVER`/`ORG_ADMIN`; `REJECTED` cannot apply; `APPROVED` materializes CR task → Stage 8 merge → `ReleaseAcceptancePackage` rejected before 100% (`422`), sealed at 100%, immutable afterwards. |
| `M6B-AC6` | Core API + Web Workbench Stages 5–9 & RBAC | REST + HTML/MD/JSON endpoints, clickable links to Stage 8 `/approval-center` & `/lineage`, error banners, cross-tenant RLS & role isolation enforced. |
| `M6B-AC7` | PostgreSQL `0008` Security & Upgrade Verification | `FORCE RLS`, `REVOKE ALL FROM PUBLIC`, `REVOKE UPDATE/DELETE` (`42501`), CR & release triggers/constraints, `DISCARD ALL`, clean migration upgrade `6f1faa8 -> HEAD`. |
