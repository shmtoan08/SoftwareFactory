# Software Factory (v1.5)

Deterministic, lease-coordinated AI Software Factory Control Plane with 4-tier PostgreSQL Row-Level Security (RLS), write-ahead worker outbox, fail-closed Git pre-receive gating, 3D independent code review, 8-field cryptographically bound human approval, rework cycle controls, and atomic CAS merge recovery.

## Current Milestone Status

- **Milestone `M0` (Architecture & Specification Freeze):** Locked at `v1.5`
- **Milestone `M1` (`M1.1` → `M1.4` Core Vertical Slice & Adversarial Test Gate):** Completed (`18/18` M1 tests + real PostgreSQL `0001`/`0002` RLS matrix passing)
- **Milestone `M2` (Worker Plane, Sandbox Isolation, Controlled Git Push Import & Adapter `P-010`):** Completed (`6/6` M2 gate tests + `19/19` review-hardening `FIX-01..FIX-27` regression tests passing)
- **Milestone `M3` (`M3.1` → `M3.4` Merge Candidate Builder `C_candidate` & 3-Tier Trusted Docker Verifier):** Completed (`10/10` M3 gate, `FAH-01A/B/C`, `P0-3` & review-hardening tests + real PostgreSQL `0001`/`0003`/`0002` migrations passing)
- **Milestone `M4` (3D Independent Reviewer, Approval TTL, Idempotent Atomic CAS Merge & Crash Recovery `P0-3`, `P1-7`):** Completed (`8/8` M4 gate tests + real PostgreSQL `0001`/`0003`/`0004`/`0002` migrations passing)
- **Milestone `M5` (Live HTTP Control Plane, WNA Daemon, `PostgresRuntimePool`, Live Model Clients, Fault Recovery & `M5_EVIDENCE_BUNDLE`):** Completed (`test:m5` 8 live gate & hardening suites + PostgreSQL `0005` migration + production PG runtime entrypoints)

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

To verify the real PostgreSQL 4-tier RLS SQL migrations, M3/M4/M5 additive schema & constraints (`0005` `resource_usage_metrics`, `projects.main_ref_commit_hash`, `verified_code_imports.recovered_by_reconciler`), and isolation test matrix (`RLS-T1..RLS-T8`) against a PostgreSQL 16+ instance:

```bash
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0001_mvp_core_schema_and_rls.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0002_rls_verification_matrix.sql
```

Run M5 live PostgreSQL tests against a migrated PostgreSQL 16+ database by setting `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD` (or `DATABASE_URL`):

```bash
npm run test:m5
```

## Monorepo Structure

```text
SoftwareFactory/
├── apps/
│   ├── agent-gateway/      # Live AgentGatewayHttpServer + runtime bootstrap (createAgentGatewayRuntime/main.ts), pre-receive disk Git verification & EphemeralReviewerCredentialService (`ROLE_REVIEWER_READONLY`)
│   ├── core-api/           # Live CoreApiHttpServer + runtime bootstrap (createCoreApiRuntime/main.ts), signed HMAC AuthN, RBAC, M3 candidate/verifier, M4 reviewer/CAS-merge/rebase & M5 lineage/metrics/bundle export
│   └── web/                # Live WebApprovalConsoleHttpServer + unified stack bootstrap (createControlPlaneStackRuntime/main.ts), 8-field lock & Candidate-Bound Lineage / telemetry views
├── packages/
│   ├── adapter-sdk/        # AgentRuntimeAdapter, LiveModelProviderClient (https:// enforcement + Anthropic/OpenAI/Gemini fetch), WorkspaceCodingAgentAdapter (TaskContract path policy + empty-commit ban) & ClaudeCodeCliAdapter
│   ├── database/           # PostgreSQL 4-tier RLS SQL migrations (`0001`..`0005`), PostgresRuntimePool (wire v3 + TLS SSLRequest + SCRAM-SHA-256 + SET LOCAL + DISCARD ALL), PostgresControlPlaneRepository, createControlPlaneStoreFromEnv & in-memory harness
│   ├── reviewer/           # IndependentReviewerService (Context Firewall, read-only WORM sandbox, TypeScript AST Tier-3 test inspection, diff/scope analysis)
│   ├── shared-types/       # Canonical 11-state TaskStatus transition matrix, M4 review/approval/merge records, M5 ResourceUsageMetricRecord/M5EvidenceBundle & canonical JSON SHA-256 helpers
│   ├── task-contract/      # Path policy precedence, 6-step validateGitTreeImport & inspectRealGitCommitForImport (quarantine-aware)
│   ├── test-harness/       # FakeAgentHarnessAdapter + M1 (18 tests), M2/FIX-01..27 (25 tests), M3 (10 tests), M4 (8 tests), & M5 (8 live E2E/recovery/model/PG/security hardening gate suites)
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
- [`mvp_fake_agent_harness_specification_v1_5.md`](./mvp_fake_agent_harness_specification_v1_5.md) — Fake Agent Harness Specification
- [`software_factory_spike_01_04_execution_playbook_report_templates_v1_5.md`](./software_factory_spike_01_04_execution_playbook_report_templates_v1_5.md) — SPIKE-01..04 Execution Playbook

## Verification Coverage & Honesty Boundary

Running `npm test` executes [`m1-acceptance.test.ts`](./packages/test-harness/src/m1-acceptance.test.ts), [`m2-acceptance.test.ts`](./packages/test-harness/src/m2-acceptance.test.ts), [`m3-acceptance.test.ts`](./packages/test-harness/src/m3-acceptance.test.ts), [`m4-acceptance.test.ts`](./packages/test-harness/src/m4-acceptance.test.ts), and [`m5-acceptance.test.ts`](./packages/test-harness/src/m5-acceptance.test.ts):

1. **8-Scenario PostgreSQL RLS Isolation Matrix (`RLS-T1` → `RLS-T8`) & M4/M5 Schema Matrix:** Verified directly against PostgreSQL 16 via [`0001_mvp_core_schema_and_rls.sql`](./packages/database/migrations/0001_mvp_core_schema_and_rls.sql) + [`0003_m3_candidate_snapshot_and_verifier_tiers.sql`](./packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql) + [`0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql`](./packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql) + [`0005_m5_resource_metrics_and_runtime_pool.sql`](./packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql) + [`0002_rls_verification_matrix.sql`](./packages/database/migrations/0002_rls_verification_matrix.sql) (multi-transaction `SET LOCAL ROLE app_runtime` + `DISCARD ALL`, append-only immutability including `resource_usage_metrics`, column-level `UPDATE` GRANT on `projects`, 8-field/10-column composite FK bindings, `chk_projects_main_ref_sha1`, `projects_core_api_main_ref_update`, and `verified_code_imports.recovered_by_reconciler`).
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
7. **Explicitly scoped runtime & platform telemetry honesty:** Non-Linux workstations (e.g., macOS without Docker Desktop) honestly report host fallback telemetry (`metricsSource: "process-rusage"` / `"wall-clock-only"`, `isDockerIsolated: false`) while Linux CI runners execute real `cgroup v2` / `sf_sandbox_supervisor.c` / Docker `node:22-alpine` isolation and live PostgreSQL 16 (`M5-PG`) verification.

