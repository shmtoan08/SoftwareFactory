# Software Factory (v1.5)

Deterministic, lease-coordinated AI Software Factory Control Plane with 4-tier PostgreSQL Row-Level Security (RLS), write-ahead worker outbox, fail-closed Git pre-receive gating, 3D independent code review, 8-field cryptographically bound human approval, rework cycle controls, and atomic CAS merge recovery.

## Current Milestone Status

- **Milestone `M0` (Architecture & Specification Freeze):** Locked at `v1.5`
- **Milestone `M1` (`M1.1` → `M1.4` Core Vertical Slice & Adversarial Test Gate):** Completed (`18/18` M1 tests + real PostgreSQL `0001`/`0002` RLS matrix passing)
- **Milestone `M2` (Worker Plane, Sandbox Isolation, Controlled Git Push Import & Adapter `P-010`):** Completed (`6/6` M2 gate tests + `19/19` review-hardening `FIX-01..FIX-27` regression tests passing)
- **Milestone `M3` (`M3.1` → `M3.4` Merge Candidate Builder `C_candidate` & 3-Tier Trusted Docker Verifier):** Completed (`10/10` M3 gate, `FAH-01A/B/C`, `P0-3` & review-hardening tests + real PostgreSQL `0001`/`0003`/`0002` migrations passing)
- **Milestone `M4` (3D Independent Reviewer, Approval TTL, Idempotent Atomic CAS Merge & Crash Recovery `P0-3`, `P1-7`):** Completed (`8/8` M4 gate tests + real PostgreSQL `0001`/`0003`/`0004`/`0002` migrations passing)
- **Milestone `M5` (Live HTTP Control Plane, WNA Daemon, `PostgresRuntimePool`, Live Model Clients, Fault Recovery & `M5_EVIDENCE_BUNDLE`):** Completed (`test:m5` 8 live gate & hardening suites + PostgreSQL `0005` migration + production PG runtime entrypoints)
- **Milestone `M6A` (Model Provider Adapter v2, Cost Guard `AC-12b` & Stages 1–4 Product Pipeline):** Completed (`test:m6a` 7 acceptance suites `M6A-AC1..M6A-AC7`, review-hardening `M6A-FIX-01..10`, PostgreSQL `0006`/`0007` 7-table `FORCE RLS`, `AC-10` triggers & `86076639`/`8044774` upgrade paths passing)
- **Milestone `M6B` (Stages 5–9 Software Development Lifecycle, Multi-Target Execution Profiles, Post-Freeze CR & `AC-11b` Bidirectional Traceability):** Completed (`test:m6b` 8 acceptance suites `M6B-AC1..M6B-AC7b`, PostgreSQL `0008` 8-table `FORCE RLS`, `chk_aop_target_tier_mapping`, `chk_rap_complete_100`, `trg_cr_transitions`/`trg_tpl_invariants` triggers & `6f1faa8`/`8044774`/`86076639` upgrade paths passing)

## Quick Start

Requires **Node.js >= 22.18.0** (verified on Node `v26.3.0` with native TypeScript execution).

```bash
npm install
npm run lint
npm run scan:secrets
npm run typecheck
npm test
```

## Production Service Runtimes (`PostgreSQL 16` + TLS)

The runtime entrypoints automatically wire [`PostgresRuntimePool`](./packages/database/src/postgres-pool.ts) and [`PostgresControlPlaneRepository`](./packages/database/src/postgres-pool.ts) via [`createControlPlaneStoreFromEnv`](./packages/database/src/index.ts) whenever `DATABASE_URL` or `PGHOST` is configured (or fail closed when `SF_REQUIRE_POSTGRES=1`):

- **Unified Control Plane Stack (`Web + Core API + Agent Gateway`):** `npm run start:web` ([`apps/web/src/main.ts`](./apps/web/src/main.ts) -> [`createControlPlaneStackRuntime`](./apps/web/src/runtime.ts))
- **Core API + Agent Gateway:** `npm run start:core-api` ([`apps/core-api/src/main.ts`](./apps/core-api/src/main.ts) -> [`createCoreApiRuntime`](./apps/core-api/src/runtime.ts))
- **Standalone Agent Gateway:** `npm run start:gateway` ([`apps/agent-gateway/src/main.ts`](./apps/agent-gateway/src/main.ts) -> [`createAgentGatewayRuntime`](./apps/agent-gateway/src/runtime.ts))

PostgreSQL wire TLS & authentication defaults:
- Defaults to `sslmode=require` on non-loopback hosts (`prefer` on loopback; remote `sslmode=disable` rejected unless `PG_ALLOW_INSECURE_REMOTE_DISABLE_SSL=1`). Supports `sslmode=disable|prefer|require|verify-ca|verify-full` and `PGSSLROOTCERT` / `?sslrootcert=`.
- Enforces `SCRAM-SHA-256` authentication (cleartext/MD5 rejected unless explicitly opted in via `PG_ALLOW_INSECURE_CLEARTEXT_AUTH=1` / `PG_ALLOW_LEGACY_MD5_AUTH=1`), bounded query/acquire/socket timeouts (`PGQUERY_TIMEOUT_MS`, `PGACQUIRE_TIMEOUT_MS`, `PGSOCKET_TIMEOUT_MS`), frame buffer caps (`PGMAX_RECV_BUFFER_BYTES`), and SCRAM iteration caps (`PGMAX_SCRAM_ITERATIONS`).
- [`CoreApiHttpServer`](./apps/core-api/src/http-server.ts) disables `POST /cas-merge` crash fault injection (`enableTestFaultInjection: false`) and restricts `POST /verify` to allowlisted binaries/images/env keys with Docker isolation enforced by default.
- **Web Console Security Boundary (`M6A-FU-06`):** [`WebApprovalConsoleHttpServer`](./apps/web/src/index.ts) (`/m6a`, `/m6b`, Stage forms) accepts raw provider `apiKey` fields inside `model_config` for interactive operator workflows and **MUST only be deployed on trusted loopback or private internal networks** (or behind an authenticated zero-trust internal proxy — never exposed directly to public/untrusted networks). Loopback `http://127.0.0.1` model endpoints require `allowInsecureHttpBaseUrl: true` (`classifyHost` treats `127.0.0.1` as private); real model credentials should be injected via server/gateway environment secrets wherever possible.

To verify the real PostgreSQL 4-tier RLS SQL migrations, M3/M4/M5/M6A/M6B additive schema & hardening constraints (`0005` `resource_usage_metrics`, `projects.main_ref_commit_hash`, `verified_code_imports.recovered_by_reconciler`; `0006`/`0007` Cost Guard `AC-12b`, `usage_estimated`, `fk_mcs_pipeline_session`, `AC-10` triggers & freeze locks; `0008` Stages 5–9 `project_bootstraps`, `agent_organization_profiles`, `dev_milestones`, `dev_epics`, `dev_user_stories`, `change_requests`, `task_plan_links`, `release_acceptance_packages`), and isolation test matrix (`RLS-T1..RLS-T8`) against a PostgreSQL 16+ instance:

```bash
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0001_mvp_core_schema_and_rls.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0007_m6a_review_fixes.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0002_rls_verification_matrix.sql
```

Run M5/M6A/M6B live PostgreSQL tests against a migrated PostgreSQL 16+ database by setting `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` (or `DATABASE_URL`):

```bash
npm run test:m5
npm run test:m6a
npm run test:m6b
```

## Monorepo Structure

```text
SoftwareFactory/
├── apps/
│   ├── agent-gateway/      # Live AgentGatewayHttpServer + runtime bootstrap (createAgentGatewayRuntime/main.ts), pre-receive disk Git verification & EphemeralReviewerCredentialService (`ROLE_REVIEWER_READONLY`)
│   ├── core-api/           # Live CoreApiHttpServer + runtime bootstrap (createCoreApiRuntime/main.ts), signed HMAC AuthN, RBAC, M3 candidate/verifier, M4 reviewer/CAS-merge/rebase, M5 lineage/metrics/bundle export, M6A Cost Guard / Stages 1–4 & M6B Stages 5–9 HTTP API
│   └── web/                # Live WebApprovalConsoleHttpServer + unified stack bootstrap (createControlPlaneStackRuntime/main.ts), 8-field lock, Candidate-Bound Lineage / telemetry, M6A Stages 1–4 Workbench & M6B `/m6b`, `/traceability` & `/agent-profiles` UI
├── packages/
│   ├── adapter-sdk/        # AgentRuntimeAdapter, Model Provider Adapter v2 (PromptRegistry, StructuredJsonSchema fail-closed validator, AC-12b micro-USD CostGuard & ManagedModelProviderExecutor), LiveModelProviderClient, WorkspaceCodingAgentAdapter & ClaudeCodeCliAdapter
│   ├── database/           # PostgreSQL 4-tier RLS SQL migrations (`0001`..`0008`), PostgresRuntimePool (wire v3 + TLS SSLRequest + SCRAM-SHA-256 + SET LOCAL + DISCARD ALL), PostgresControlPlaneRepository, createControlPlaneStoreFromEnv, M6A/M6B validators & in-memory harness
│   ├── product-pipeline/   # M6A Stages 1–4 orchestration (ProductPipelineService), PromptRegistry templates (`1.0.0`), AC-10 3-layer enforcement, CrossArtifactConsistencyChecker (`CHK-01..CHK-05`), & M6B Stages 5–9 (Stage 5 Bootstrapper, Stage 6 Profiles & 3D Check, Stage 7 Planner, Stage 9 CR & Release Package, AC-11b Bidirectional Traceability)
│   ├── reviewer/           # IndependentReviewerService (Context Firewall, read-only WORM sandbox, TypeScript AST Tier-3 test inspection, diff/scope analysis)
│   ├── shared-types/       # Canonical 11-state TaskStatus transition matrix, M4 review/approval/merge records, M5 ResourceUsageMetricRecord/M5EvidenceBundle, M6A/M6B records + BigInt micro-USD helpers & canonical JSON SHA-256 helpers
│   ├── task-contract/      # Path policy precedence, 6-step validateGitTreeImport & inspectRealGitCommitForImport (quarantine-aware)
│   ├── test-harness/       # FakeAgentHarnessAdapter + M1 (18 tests), M2/FIX-01..27 (25 tests), M3 (10 tests), M4 (8 tests), M5 (8 live suites), M6A (`M6A-AC1..M6A-AC7b`), & M6B (`M6B-AC1..M6B-AC7b`)
│   ├── verifier/           # Real Git `C_candidate` builder (`git merge-tree --write-tree`), immutable WORM `.tar` snapshots, & 3-tier hardened Docker Verifier
│   └── wna/                # WnaWorkerDaemon (worktree + LocalOutboxBuffer WAL reconnect + task.failed flush), native C Linux supervisor (`native/sf_sandbox_supervisor.c`), & SandboxBackend
└── scripts/
    ├── ci/                 # Monorepo strict tsc/bash lint & secret-scan scripts
    └── git-hooks/
        └── pre-receive     # Fail-closed Git pre-receive hook gatekeeper (2000ms hard timeout, Bearer per-lease token, quarantine env forwarding)
```

## Core Specifications (`v1.5`)

- [`software-factory-design-plan.md`](./software-factory-design-plan.md) — System Design Plan v1.5
- [`software-factory-development-roadmap.md`](./software-factory-development-roadmap.md) — Development Roadmap v1.5
- [`mvp_scope_and_architecture_specification_v1_5.md`](./mvp_scope_and_architecture_specification_v1_5.md) — `MVP-SPEC-01`: Scope & Architecture
- [`mvp_database_schema_and_rls_specification_v1_5.md`](./mvp_database_schema_and_rls_specification_v1_5.md) — `MVP-SPEC-02`: Database Schema & 4-Tier RLS Policies
- [`mvp_lease_event_protocol_sandbox_and_git_import_specification_v1_5.md`](./mvp_lease_event_protocol_sandbox_and_git_import_specification_v1_5.md) — `MVP-SPEC-03`: Lease/Event Protocol, Linux Sandbox & Git Import
- [`mvp_verifier_3d_reviewer_approval_and_recovery_specification_v1_5.md`](./mvp_verifier_3d_reviewer_approval_and_recovery_specification_v1_5.md) — `MVP-SPEC-04`: Trusted Verifier, 3D Reviewer, 8-Field Approval & CAS Merge Recovery
- [`m6a_model_adapter_cost_guard_and_stages_1_4_specification_v1_5.md`](./m6a_model_adapter_cost_guard_and_stages_1_4_specification_v1_5.md) — `M6A-SPEC-01`: Model Provider Adapter v2, Cost Guard (`AC-12b`) & Stages 1–4 Product Pipeline
- [`m6b_stages_5_9_and_full_traceability_specification_v1_5.md`](./m6b_stages_5_9_and_full_traceability_specification_v1_5.md) — `M6B-SPEC-01`: Stages 5–9 Software Development Lifecycle, Multi-Target Execution Model & `AC-11b` Bidirectional Traceability
- [`mvp_fake_agent_harness_specification_v1_5.md`](./mvp_fake_agent_harness_specification_v1_5.md) — Fake Agent Harness Specification
- [`software_factory_spike_01_04_execution_playbook_report_templates_v1_5.md`](./software_factory_spike_01_04_execution_playbook_report_templates_v1_5.md) — SPIKE-01..04 Execution Playbook

## Verification Coverage & Honesty Boundary

Running `npm test` executes [`m1-acceptance.test.ts`](./packages/test-harness/src/m1-acceptance.test.ts), [`m2-acceptance.test.ts`](./packages/test-harness/src/m2-acceptance.test.ts), [`m3-acceptance.test.ts`](./packages/test-harness/src/m3-acceptance.test.ts), [`m4-acceptance.test.ts`](./packages/test-harness/src/m4-acceptance.test.ts), [`m5-acceptance.test.ts`](./packages/test-harness/src/m5-acceptance.test.ts), [`m6a-acceptance.test.ts`](./packages/test-harness/src/m6a-acceptance.test.ts), and [`m6b-acceptance.test.ts`](./packages/test-harness/src/m6b-acceptance.test.ts):

1. **8-Scenario PostgreSQL RLS Isolation Matrix (`RLS-T1` → `RLS-T8`) & M4/M5/M6A/M6B Schema Matrix:** Verified directly against PostgreSQL 16 & 17 via [`0001_mvp_core_schema_and_rls.sql`](./packages/database/migrations/0001_mvp_core_schema_and_rls.sql) + [`0003_m3_candidate_snapshot_and_verifier_tiers.sql`](./packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql) + [`0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql`](./packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql) + [`0005_m5_resource_metrics_and_runtime_pool.sql`](./packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql) + [`0006_m6a_model_cost_guard_and_stages_1_4.sql`](./packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql) + [`0007_m6a_review_fixes.sql`](./packages/database/migrations/0007_m6a_review_fixes.sql) + [`0008_m6b_stages_5_9_and_traceability.sql`](./packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql) + [`0002_rls_verification_matrix.sql`](./packages/database/migrations/0002_rls_verification_matrix.sql) (multi-transaction `SET LOCAL ROLE app_runtime` + `DISCARD ALL`, append-only immutability including explicit `REVOKE UPDATE, DELETE`, column-level `UPDATE` GRANTs, 8-field/10-column & Stage 4 Freeze composite FK bindings, `AC-10` NULL-safe triggers, one-way Stage 1 locks, latest Stage 4 freeze enforcement, `usage_estimated`, `fk_mcs_pipeline_session`, M6B Stage 5/6/7/9 constraints & triggers, and upgrade paths from `6f1faa8`, `8044774`, and `86076639`).
2. **10 Adversarial & Recovery Scenarios (`Scenario 1` → `Scenario 10`):** Full 11-state vertical slice happy path, duplicate retry vs payload mismatch, out-of-order sequence gap replay, invalid state transition rejection, concurrent lease revoke race + `clock_timestamp()` expiry + `killAndVerifyClean`, orphaned Git push recovery, 6-step Git tree import validation, 3D independent reviewer enforcement, mid-approval CAS conflict invalidation (`BuildingMergeCandidate`), and post-merge crash reconciliation + Approval TTL expiry.
3. **6 Milestone `M2` Gate Scenarios (`M2-Gate-1` → `M2-Gate-6`) & 19 Review Hardening Tests (`(a)` → `(s)`, `FIX-01..FIX-27`):** Real `git push` -> `scripts/git-hooks/pre-receive` -> `curl` -> live `AgentGatewayHttpServer` (`POST /internal/v1/git/pre-receive-verify`), 2000ms fail-closed timeout, Linux `sf_sandbox_supervisor.c` (`PR_SET_CHILD_SUBREAPER`, namespaces, `PR_SET_NO_NEW_PRIVS`, cgroup v2 cleanup when writable), signed `CoreApiTokenAuthenticator` + `project_memberships` RBAC, `REQUEST_CHANGES` rework escalation, and collision-free `canonicalizeJson`.
4. **10 Milestone `M3` Gate & Review Hardening Scenarios (`M3-Gate-1` → `M3-Gate-10`, `FAH-01A/B/C` & `P0-3`):** Real `git merge-tree --write-tree` + `git commit-tree` two-parent `C_candidate` construction, immutable WORM `.tar` snapshots, 3-Tier Verifier with `trusted_policy_sha256` & protected baseline tamper detection (`TEST_TAMPERING_DETECTED`), and `INFRA_ERROR` retry without incrementing `rework_count`.
5. **8 Milestone `M4` Gate & Review-Hardening Scenarios (`M4-Gate-1` → `M4-Gate-8`):** 3D Independent Reviewer (`ROLE_REVIEWER_READONLY`), Context Firewall, read-only WORM snapshot inspection, Approval Center 8-field lock + TTL enforcement, real `git update-ref` crash reconciliation (`RECONCILED_ALREADY_MERGED`), and CAS conflict rebase recovery.
6. **8 Milestone `M5` Live E2E, Fault Recovery, Model Provider, Security Hardening & PostgreSQL Gates (`M5-Gate-1` → `M5-Gate-8`):**
   - `M5-Gate-1 (P0-2)`: Full 8-step vertical slice over live `CoreApiHttpServer`, `AgentGatewayHttpServer`, and `WebApprovalConsoleHttpServer`, real `WnaWorkerDaemon` + `LocalOutboxBuffer` + `git push` -> `pre-receive` (`refs/heads/main` blocked, staging ref admitted) -> `C_candidate` + 3-Tier Verifier -> 3D Reviewer -> tampered 8-field HTTP rejection & valid approval -> atomic `refs/heads/main` CAS merge + `AC-11a` lineage + `AC-12a` 3-phase resource metrics + signed SHA-256 `M5EvidenceBundle`.
   - `M5-Gate-2 (M5-AC7a..d)`: Gateway `503` + lost ACK WAL reconnect replay (`reconnectSyncInvoked`), worker crash after push + Orphaned Push Reconciler completion without re-running coder agent, concurrent `main` advance CAS conflict rebase -> rebuild, and Approval TTL expiry (`409 ERR_APPROVAL_EXPIRED_OR_STALE`) + post-merge `500` crash idempotent reconciliation.
   - `M5-Gate-3 (M5-MODEL)`: Fail-closed `ModelProviderConfigurationError` + live loopback HTTP Anthropic (`/v1/messages`), OpenAI (`/v1/chat/completions`), and Gemini (`:generateContent`) client integration inside `WorkspaceCodingAgentAdapter` and `evaluateIndependentReviewWithLiveModel`.
   - `M5-Gate-4 (M5-PG)`: Live PostgreSQL 16 `PostgresRuntimePool` (`SET LOCAL ROLE app_runtime` + `DISCARD ALL`), cross-tenant RLS isolation, append-only `resource_usage_metrics` (`42501` on `UPDATE`/`DELETE`), column-level GRANT enforcement on `projects`, `SAVEPOINT` pre-receive rollback on timeout, cross-candidate `approval_request_id` validation, project-scoped `getMainRefCommitHash(projectId)`, production stack boot over PG16, full HTTP workflow -> `MERGED_BY_CAS`, and real short-TTL PostgreSQL `clock_timestamp()` Orphaned Push Reconciler. (Automatically runs in CI with PostgreSQL 16 service and skips cleanly when `PGHOST`/`DATABASE_URL` is unset.)
   - `M5-Gate-5` → `M5-Gate-8`: Wire TLS (`SSLRequest` + `require`/`verify-ca`/`verify-full`/`prefer`), cleartext/MD5 rejection by default, wire timeouts/buffer/SCRAM caps, HTTP `/verify` allowlist & fault-injection gating, pre-receive disk Git binding, stale `current_main_commit_hash` check, WNA `task.failed` flush on adapter/push errors, `WorkspaceCodingAgentAdapter` TaskContract path policy & empty-commit ban, OpenAI array content handling, `https://` `baseUrl` enforcement, and `createControlPlaneStoreFromEnv` / runtime factory verification.
7. **7 Milestone `M6A` Acceptance Suites (`M6A-AC1` → `M6A-AC7b`) & Review Hardening (`M6A-FIX-01` → `M6A-FIX-10`, `M6A-FU-01` → `M6A-FU-06`):**
   - `M6A-AC1` (Config-Driven Multi-Provider Runtime Swap & Fail-Closed Config): Swapping `anthropic`, `openai`, and `google` on identical prompts with 0 code change; fail-closed missing API key & non-loopback `http://` validation (`503 ERR_MODEL_PROVIDER_NOT_CONFIGURED`), upstream HTTP `502` `FAILED_PROVIDER` ledger recording, and accurate partial `usage` extraction on provider HTTP errors (`M6A-FU-05`).
   - `M6A-AC2` (Immutable `PromptRegistry` Versioning & Fail-Closed `StructuredJsonSchema`): Immutable `promptSha256` registration (`409 ERR_PROMPT_VERSION_CONFLICT`), strict JSON extraction/schema validation, `FAILED_VALIDATION` ledger recording (`422 ERR_STRUCTURED_OUTPUT_INVALID`), and deferred post-persist `ALLOWED` ledger commit (`executeStructuredPromptDeferred`) so downstream validation/DB rollbacks never leave orphan `ALLOWED` ledgers (`M6A-FU-02`).
   - `M6A-AC3` (`AC-12b` Exact Integer `micro-USD` Cost Guard): `BigInt` ceiling arithmetic, preflight blocking (`0` HTTP calls, `BLOCKED_PREFLIGHT`, `402 ERR_COST_LIMIT_EXCEEDED`), post-call overshoot (`BLOCKED_POSTCALL` + `EXHAUSTED` + subsequent `SESSION_EXHAUSTED`), and deadlock-safe autonomous TX durability even when outer TX rolls back (`M6A-FU-03`).
   - `M6A-AC4` (Stage 1 Verification Discipline & `AC-10` 3-Layer Enforcement): `FACT`=`AUTO_VERIFIED` vs `ASSUMPTION`/`RECOMMENDATION`=`UNCONFIRMED`, Stage 2 `UNCONFIRMED` rejection (`422 ERR_AC10_UNCONFIRMED_ASSUMPTION`), and unlock only after `CONFIRM`.
   - `M6A-AC5` (End-to-End Stages 1 → 4 Product Pipeline & Canonical SHA-256 Baseline Freeze): Interactive browser form & JSON HTTP workflow across [`CoreApiHttpServer`](./apps/core-api/src/http-server.ts) and [`WebApprovalConsoleHttpServer`](./apps/web/src/index.ts) (session list/create, Stage 1–4 controls, error alert banners, `(est)` fallback token markers) -> `FROZEN` `BaselineSpecFreeze`, plus canonical SHA-256 integrity verification on reads (`M6A-FU-01`).
   - `M6A-AC6` (Consistency Checker, RBAC, Tenant Isolation & Freeze Immutability): `CHK-01..CHK-05` freeze blocking (`422`), `DEVELOPER` RBAC `403` on Approval Gate / Freeze, cross-tenant `403`/`404`, and `FROZEN` immutability (`422`, `0` LLM hits).
   - `M6A-AC7` / `M6A-AC7b` (Live PostgreSQL 16/17 `0006` + `0007` & Upgrade Matrix Verification): `FORCE ROW LEVEL SECURITY`, append-only `42501` (`REVOKE UPDATE, DELETE`), column-level `UPDATE` GRANTs, `DISCARD ALL` isolation, atomic multi-statement repository TX safety (`M6A-FU-04`), SQL triggers (`AC-10`, one-way Stage 1 locks, latest Stage 4 & freeze locks), durable `AC-12b` `EXHAUSTED` state, `usage_estimated`, `fk_mcs_pipeline_session`, and upgrade paths from `86076639` and `8044774` (skips cleanly when `PGHOST`/`DATABASE_URL` is unset).
8. **8 Milestone `M6B` Acceptance Suites (`M6B-AC1` → `M6B-AC7b`, Stages 5–9 & `AC-11b`) & Review Hardening (`M6B-FIX-01` → `M6B-FIX-09`):**
   - `M6B-AC1` (Stage 5 Project Bootstrapper): Frozen Stage 4 baseline atomically materializes bare/working Git `main` commit (`M6B-FIX-09` staged Git ref & symlink/empty-dir guards), `policy/trusted-verification-policy.json`, `tests/protected/**`, external immutable `trusted_acceptance_dir` `node:test` acceptance suites mapped 1:1 from Stage 2 `acceptance_criteria[]` (requiring `APPROVAL_ROLES` + static assertion validation whenever `acceptance_specs` is supplied, while always executing independent behavioral checks, `M6B-FIX-02`), failing Tier 1 before implementation, passing after implementation, and rejecting external policy tampering (`ERR_TRUSTED_POLICY_SHA256_MISMATCH`).
   - `M6B-AC2` (Stage 6 Agent Organization & Multi-Target Execution Profiles): Project-scoped persistence & validation of all 4 roles (`PLANNER`, `DEVELOPER`, `REVIEWER_READONLY`, `VERIFIER`), canonical 1:1 target/trust tier mapping (`factory_managed_worker`/`TIER_1_FACTORY_MANAGED`, `user_managed_worker`/`TIER_2_USER_MANAGED`, `provider_managed_vm`/`TIER_3_PROVIDER_VM`, `remote_agent_session`/`TIER_4_REMOTE_SESSION`), and 3D reviewer separation checks.
   - `M6B-AC3` (Stage 7 Automated Development Planning): Versioned `stage7.planning.decompose@1.0.0` prompt outside transactions with `AC-12b` deferred ledger billing, 100% Stage 2 requirement/AC coverage & per-`(req_id, ac_id)` pairing integrity (`M6B-FIX-08`), `protected_paths`/forbidden-path overlap and iterative cyclic DAG blocking, duplicate Stage 7 blocking (`409`), and Stage 8 `tasks` + `task_plan_links` materialization.
   - `M6B-AC4` (True End-to-End Stage 1 → Stage 9 Vertical Slice): Stage 1..4 Freeze -> Stage 5 Bootstrap -> Stage 6 Profiles -> Stage 7 Plan -> Stage 8 `WnaWorkerDaemon` + `pre-receive` + `Docker3TierVerifier` + `IndependentReviewerService` + Human Approval + `AtomicCasMerge` -> Stage 9 `CR-01` -> Stage 8 `CR-01` merge -> `AC-11b` 100% Bidirectional Traceability Matrix (with Stage 1 provenance `M6B-FIX-03`, bidirectional orphan scan `M6B-FIX-06`, Tier 1 + policy SHA pinning `M6B-FIX-07`, real Git `refs/heads/main` ancestry without caller overrides `M6B-FIX-01`, and floored `coverage_percent`) -> immutable `ReleaseAcceptancePackage`.
   - `M6B-AC5` (Stage 9 Change Request & Release Governance): RBAC `403`, one-way CR state locks (`APPROVED | REJECTED`), CR `impacted_requirement_ids`/`proposed_tasks` pairing & `APPLIED` CR task coverage (`M6B-FIX-05`), dangling requirement/`protected_paths` blocks, and fail-closed `422` Release Package blocking while coverage < 100% or CR remains open.
   - `M6B-AC6` (Interactive Web Workbench `/m6b`, `/traceability`, `/agent-profiles`): PRG HTML `303` forms, `[data-error-banner]` validation feedback, `/traceability?format=html|md|json` variants, clickable Approval Center/Lineage links, and cross-tenant `403`/`404` isolation.
   - `M6B-AC7` / `M6B-AC7b` (Live PostgreSQL 16/17 `0008` RLS, Triggers, Grants & Upgrade Paths): `FORCE ROW LEVEL SECURITY` on all 8 M6B tables, `42501` append-only & column-level `UPDATE` GRANT enforcement, `chk_aop_target_tier_mapping`, `chk_rap_complete_100`, `trg_cr_transitions`, `trg_tpl_invariants`, `trg_*_frozen_anchor`, `DISCARD ALL` isolation, live PG17 E2E Stage 1–9 -> `ReleaseAcceptancePackage`, and upgrade paths from `6f1faa8`, `8044774`, and `86076639` (skips cleanly when `PGHOST`/`DATABASE_URL` is unset).
9. **Explicitly scoped runtime & platform telemetry honesty:** Non-Linux workstations (e.g., macOS without Docker Desktop) honestly report host fallback telemetry (`metricsSource: "process-rusage"` / `"wall-clock-only"`, `isDockerIsolated: false`) while Linux CI runners execute real `cgroup v2` / `sf_sandbox_supervisor.c` / Docker `node:22-alpine` isolation and live PostgreSQL 16 & 17 (`M5-PG`, `M6A-AC7`, `M6A-AC7b`, `M6B-AC7`, `M6B-AC7b`) verification.

