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
1. **Validation:** Verify `session.status === 'FROZEN'`, `baseline.status === 'FROZEN'`, and load frozen `STAGE_2_PRD_SRS` & `STAGE_3_ARCHITECTURE_DESIGN`. Reject duplicate bootstrap attempts for the same `(project_id, baseline_id)` (`SQLSTATE 23505`). Reject non-empty `trusted_acceptance_dir` or symlink escapes out of canonical `repo_path` (`realpath` check).
2. **Protected Paths Generation:** Create immutable governance and integrity test files in the user project repository:
   - `policy/trusted-verification-policy.json` (canonical manifest of `baseline_id`, `pipeline_session_id`, `stage2_artifact_sha256`, `stage3_artifact_sha256`, `protected_paths`, requirement → AC mappings)
   - `tests/protected/baseline-spec.test.mjs` (Tier 2 integrity test validating protected baseline manifest consistency)
   - `protected_paths` = `["policy/trusted-verification-policy.json", "tests/protected/**", "README.md", "package.json"]` (plus caller extensions; deleting/omitting required paths is rejected).
3. **Trusted Acceptance Tests (`trusted_acceptance_dir`):** Outside the agent-writable repository workspace, synthesize runnable `node:test` acceptance suites (`acceptance.test.mjs`) mapped 1:1 from every frozen Stage 2 `acceptance_criteria[]` (`ac_id`, `req_id`, `given`, `when`, `then`).
   - Supplying custom `acceptance_specs` requires `APPROVAL_ROLES` (`PROJECT_APPROVER` or `ORG_ADMIN`), undergoes strict static assertion syntax validation (declarative assertions only; rejects `process`, `require`, `import`, `eval`, control flow, statements separated by `;`), and **augments rather than replaces** independent Stage 2 AC + Stage 3 deliverable behavioral checks (`src/components/<component-slug>.mjs` / mapped deliverable modules verifying implemented `ac_id`s).
   - Computes `trusted_policy_sha256 = computeDirectorySha256(trusted_acceptance_dir)` identically to `Docker3TierVerifier` so Stage 8 verification enforces cryptographic policy pinning (`TaskContractSpec.trusted_policy_sha256`).
4. **Atomic Git Staging & Commit on `refs/heads/main`:** Stage files in a temporary directory and advance/initialize a staging branch before DB commit (`createProjectBootstrap`); only finalize `refs/heads/main` on success and clean up staged artifacts on rollback/failure, capturing the resulting 40-hex `base_main_commit_hash` (`projects.main_ref_commit_hash`) and `bootstrap_sha256`.

---

## 3. Stage 6 — Agent Organization & Multi-Target Execution Binding (`agent_organization_profiles`)

1. **Roles:** `PLANNER`, `DEVELOPER`, `REVIEWER_READONLY`, `VERIFIER`.
2. **Project Scoping (v1.5 Design Note):** `agent_organization_profiles` is project-scoped (anchored to `projects`), allowing validated org/execution profiles to be reused across pipeline sessions and baselines within the same project rather than keyed 1:1 to a single `pipeline_session_id`.
3. **Execution Target Taxonomy:**
   - `factory_managed_worker` (`TIER_1_FACTORY_MANAGED`)
   - `user_managed_worker` (`TIER_2_USER_MANAGED`)
   - `provider_managed_vm` (`TIER_3_PROVIDER_VM`)
   - `remote_agent_session` (`TIER_4_REMOTE_SESSION`)
4. **3D Reviewer Separation Enforcement:** When pairing or validating a `DEVELOPER` profile against a `REVIEWER_READONLY` profile, Stage 6 & Core API strictly enforce all 3 orthogonal axes:
   - Distinct identity (`lower(btrim(dev.principal_id)) !== lower(btrim(rev.principal_id))`)
   - Distinct profile (`dev.agent_profile_id !== rev.agent_profile_id` / `dev.profile_id !== rev.profile_id`)
   - Distinct provider+model pair (`(lower(btrim(dev.provider)), lower(btrim(dev.model))) !== (lower(btrim(rev.provider)), lower(btrim(rev.model)))`)
5. **RBAC:** Upserting/modifying profiles requires `MUTATION_ROLES` (`DEVELOPER`, `PROJECT_APPROVER`, `ORG_ADMIN`); listing requires `READ_ROLES`.

---

## 4. Stage 7 — Automated Development Planning & Task Materialization

Tables: `dev_milestones`, `dev_epics`, `dev_user_stories`, `task_plan_links`.

1. **Prompt Registry & AC-12b Cost Guard:** Uses versioned immutable prompt `stage7.planning.decompose@1.0.0` with fail-closed `STAGE7_PLANNING_OUTPUT_SCHEMA`, `ManagedModelProviderExecutor` (`executeStructuredPromptDeferred` committing `ALLOWED` ledger atomically with Stage 7 DB persistence / recording `FAILED_VALIDATION` or `FAILED_INTERNAL` on abort), `AC-12b` preflight + actual ledger recording tied to the session's `cost_session_id`. Model calls run **outside** open SQL transactions. Note that Stage 7 returns `{ milestone_count, epic_count, story_count, task_ids, plan_sha256, cost_ledger }` (coverage summary is surfaced on the Stage 9 / `AC-11b` traceability endpoint rather than duplicated on the Stage 7 write response).
2. **Plan Completeness & Security Validation (`validateStage7PlanAgainstBaseline`):**
   - Every Stage 2 `req_id` (FR + NFR) **AND** every Stage 2 `ac_id` MUST be covered by ≥ 1 story and ≥ 1 planned task (`100%` requirement AND AC coverage), with each `(req_id, ac_id)` pair validated against the canonical frozen Stage 2 mapping and each task's `requirement_ids` / `ac_ids` constrained to its parent story's assigned subset. (Stage 7 validates planning completeness + Stage 5 AC binding upfront, while Stage 9 Release also requires every requirement/AC to be backed by executed Tier 1 trusted acceptance tests and complete Stage 8 lineage.)
   - Zero unknown/dangling `req_id`s or `ac_id`s are permitted; task dependency graphs are iteratively validated to be acyclic (`23514` on cycles or deep chains without stack overflow).
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
- Post-freeze changes are submitted as `ChangeRequestRecord` (`PENDING_APPROVAL`) targeting specific `impacted_requirement_ids`, `impacted_component_ids`, and `proposed_tasks[]`. Creation validates a snapshot against the immutable frozen Stage 2/3/5 baseline (requiring every `impacted_requirement_id` to be covered by `proposed_tasks` and matching `(req_id, ac_id)` bindings). `get`/`list`/`decide`/`apply` verify `cr_sha256` integrity against the stored payload.
- **CR Supersede & Binding Semantics (v1.5):** There is no separate CR-supersedes-CR relation table in v1.5; every `APPROVED`/`APPLIED` CR remains binding against the frozen baseline, any still-open (`PENDING_APPROVAL` or unapplied `APPROVED`) CR blocks release, and `AC-11b` requires all `APPLIED` CRs targeting a `req_id` to have every linked CR task reach `MergedAndCompleted` with complete Stage 8 lineage covering `impacted_requirement_ids`.
- **RBAC & Concurrency Workflow (`fn_enforce_change_request_transitions`):**
  - Submitting a CR (`createChangeRequest`) and materializing Stage 8 tasks from an already-`APPROVED` CR (`applyChangeRequestAndMaterializeTasks`) require `MUTATION_ROLES` (`DEVELOPER`, `PROJECT_APPROVER`, `ORG_ADMIN`) — materialized CR tasks still traverse the full Stage 8 Verifier, 3D Reviewer, and Human Approval pipeline before reaching `main`.
  - `decideChangeRequest` (`PENDING_APPROVAL → APPROVED | REJECTED`, serialized in-memory per `change-request:${cr_id}` lock and row-locked in PostgreSQL) **strictly requires `APPROVAL_ROLES`** (`PROJECT_APPROVER` or `ORG_ADMIN`; `DEVELOPER`/`AUDITOR` denied `403`).
  - `APPROVED → APPLIED` via `applyChangeRequestAndMaterializeTasks`: materializes new Stage 8 `tasks` inheriting Stage 5 `protected_paths` & `trusted_policy_sha256` and links via `task_plan_links.cr_id`.
  - DB trigger `fn_enforce_task_plan_link_invariants` strictly rejects any `task_plan_links` with non-null `cr_id` unless the referenced CR has `status = 'APPROVED'`.
  - `REJECTED` and `APPLIED` are terminal; immutable CR payload columns cannot be altered once created.

### 6.2 `AC-11b` — 100% Bidirectional Traceability Matrix
`buildBidirectionalTraceabilityMatrix` inspects Stages 1, 2, 3, 5, 7, 8 (`getCandidateBoundLineage` for each linked task), and Stage 9 (`APPLIED` CRs):
- **Per-Requirement Chain (`req_id`):**
  - **Stage 1:** `stage1_item_ids[]` — each ID must resolve in the session's `stage1_discovery_items` with `verification_status IN ('AUTO_VERIFIED', 'CONFIRMED')` (non-empty).
  - **Stage 2:** `ac_ids[]` (≥ 1 acceptance criterion in canonical-hash-verified frozen Stage 2)
  - **Stage 3:** at least one architectural component (`stage3_component_ids[]`) AND technical design reference (`stage3_erd_tables` / `stage3_api_endpoints` / `stage3_security_controls` / `stage3_adr_ids`), all validated bidirectional in canonical-hash-verified Stage 3
  - **Stage 5:** `bootstrap_id` + covered `trusted_acceptance_test_files[]` covering all `ac_ids[]` (no unknown `req_id`/`ac_id` refs in `acceptance_tests`)
  - **Stage 7:** `milestone_ids[]`, `epic_ids[]`, `story_ids[]`, `task_ids[]` (and valid `TaskContractSpec` with Stage 5 `trusted_policy_sha256`)
  - **Stage 8:** for the requirement's linked tasks (and all applied CR tasks targeting the requirement): `MergedAndCompleted`, valid non-empty `lease_ids`, `import_ids`, `merge_candidate_ids`, PASS `verification_run_ids` (`tier1_trusted_acceptance_passed === true` AND `trusted_policy_sha256 === bootstrap.trusted_policy_sha256`), PASS `review_session_ids` + `review_artifact_ids`, APPROVED `approval_request_ids` + `approval_decision_ids`, `merged_commit_hash` present and reachable on real Git `refs/heads/main` (`git merge-base --is-ancestor`, without caller overrides) and recorded in `projects.main_ref_commit_hash` (or matched in merged lineage).
  - **Stage 9:** every `APPLIED` CR targeting `req_id` must have linked CR tasks covering `impacted_requirement_ids` that reached `MergedAndCompleted` with complete Stage 8 lineage.
- **Bidirectional Indexes & Metrics:**
  - `forward_index`: `req_id → Stage 1 → Stage 2 ACs → Stage 3 → Stage 5 → Stage 7 → Stage 8 → Stage 9 CRs`
  - `backward_index`: `main commit / task / story / CR / trusted test / component / AC / Stage 1 item → req_id[]`
  - `orphan_links`: detects unlinked tasks in the project (`project tasks` not in `task_plan_links`), tasks/stories/CRs referencing unknown `req_id`s, Stage 3 component/ERD/API/security references to unknown `req_id`s, and Stage 5 `acceptance_tests` entries referencing unknown `req_id`/`ac_id`s.
  - `coverage_percent`: `Math.floor((covered_requirements / total_requirements) * 10000) / 100` (equals `100` ONLY when `complete === true` — every requirement is 100% linked forward & backward AND `orphan_links.length === 0` AND `missing_links.length === 0` — preventing floating-point rounding up to `100`).
  - `traceability_sha256`: canonical JSON SHA-256 of the matrix body.

### 6.3 Release Acceptance Package (`release_acceptance_packages`)
- Strictly **append-only** (`REVOKE UPDATE, DELETE FROM app_runtime`).
- **RBAC (`AC-11b` Matrix vs Seal):** Reading the `AC-11b` traceability matrix requires `READ_ROLES`, while sealing `ReleaseAcceptancePackage` strictly requires `APPROVAL_ROLES` (`PROJECT_APPROVER` or `ORG_ADMIN`; `DEVELOPER`/`AUDITOR` denied `403`). v1.5 does not split matrix computation/viewing and release sealing into two separate human personas (unlike Stage 6/8 3D agent coder-vs-reviewer separation).
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
