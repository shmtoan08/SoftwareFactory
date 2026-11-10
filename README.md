# Software Factory (v1.5)

Deterministic, lease-coordinated AI Software Factory Control Plane with 4-tier PostgreSQL Row-Level Security (RLS), write-ahead worker outbox, fail-closed Git pre-receive gating, 3D independent code review, 8-field cryptographically bound human approval, rework cycle controls, and atomic CAS merge recovery.

## Current Milestone Status

- **Milestone `M0` (Architecture & Specification Freeze):** Locked at `v1.5`
- **Milestone `M1` (`M1.1` → `M1.4` Core Vertical Slice & Adversarial Test Gate):** Completed (`18/18` M1 tests + real PostgreSQL `0001`/`0002` RLS matrix passing)
- **Milestone `M2` (Worker Plane, Sandbox Isolation, Controlled Git Push Import & Adapter `P-010`):** Completed (`6/6` M2 gate tests + `17/17` review-hardening `FIX-01..FIX-27` regression tests passing; **`41/41` total tests passing**)
- **Milestones `M3`–`M5` (Ephemeral Docker Verifier, Live 3D Model Reviewers, Live WNA Daemon & Real PostgreSQL Runtime Wiring):** Planned next milestones

## Quick Start

Requires **Node.js >= 22.18.0** (verified on Node `v26.3.0` with native TypeScript execution).

```bash
npm install
npm run lint
npm run scan:secrets
npm run typecheck
npm test
```

To verify the real PostgreSQL 4-tier RLS SQL migrations and isolation test matrix (`RLS-T1..RLS-T8`) against a PostgreSQL 16+ instance:

```bash
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0001_mvp_core_schema_and_rls.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0002_rls_verification_matrix.sql
```

## Monorepo Structure

```text
SoftwareFactory/
├── apps/
│   ├── agent-gateway/      # Worker gateway + live HTTP pre-receive server (`POST /internal/v1/git/pre-receive-verify`) + HMAC lease push tokens
│   ├── core-api/           # Orchestration service with signed HMAC AuthN + live `project_memberships` RBAC enforcement
│   └── web/                # Approval console controller binding all 8 mandatory candidate/review fields (`APPROVED` / `REJECTED` / `REQUEST_CHANGES`)
├── packages/
│   ├── adapter-sdk/        # AgentRuntimeAdapter, TaskContextAssembler, and ClaudeCodeCliAdapter (P-010)
│   ├── database/           # PostgreSQL 4-tier RLS SQL migrations (`0001`, `0002`) & SoftwareFactoryControlPlaneStore
│   ├── shared-types/       # Canonical 11-state TaskStatus transition matrix, event envelopes & collision-free canonical JSON SHA-256 helpers
│   ├── task-contract/      # Path policy precedence, 6-step validateGitTreeImport & inspectRealGitCommitForImport (quarantine-aware)
│   ├── test-harness/       # FakeAgentHarnessAdapter + M1 (18 tests) & M2/FIX-01..27 (23 tests) acceptance suites
│   └── wna/                # Worker Node Agent LocalOutboxBuffer (.jsonl) & SandboxBackend (real OS PGID cleanup + Linux cgroup v2 / simulated adapter)
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

Running `npm test` executes [`m1-acceptance.test.ts`](./packages/test-harness/src/m1-acceptance.test.ts) and [`m2-acceptance.test.ts`](./packages/test-harness/src/m2-acceptance.test.ts) (`41/41` tests):

1. **8-Scenario PostgreSQL RLS Isolation Matrix (`RLS-T1` → `RLS-T8`):** Verified both in the control-plane harness and directly against PostgreSQL via [`0001_mvp_core_schema_and_rls.sql`](./packages/database/migrations/0001_mvp_core_schema_and_rls.sql) + [`0002_rls_verification_matrix.sql`](./packages/database/migrations/0002_rls_verification_matrix.sql) (multi-transaction `SET LOCAL` + `DISCARD ALL`, Tier 3 append-only immutability, 8-field composite FK binding).
2. **10 Adversarial & Recovery Scenarios (`Scenario 1` → `Scenario 10`):** Full 11-state vertical slice happy path, duplicate retry vs payload mismatch, out-of-order sequence gap replay, invalid state transition rejection, concurrent lease revoke race + `clock_timestamp()` expiry + `killAndVerifyClean`, orphaned Git push recovery, 6-step Git tree import validation, 3D independent reviewer enforcement, mid-approval CAS conflict invalidation (`BuildingMergeCandidate`), and post-merge crash reconciliation + Approval TTL expiry.
3. **6 Milestone `M2` Gate Scenarios (`M2-Gate-1` → `M2-Gate-6`) & 17 Review Hardening Tests (`(a)` → `(q)`, `FIX-01..FIX-27`):**
   - **Real OS/Git/HTTP paths verified E2E:** Real `git push` -> `scripts/git-hooks/pre-receive` -> `curl` -> live `AgentGatewayHttpServer` (`POST /internal/v1/git/pre-receive-verify`) with per-lease HMAC Bearer tokens and quarantine `GIT_OBJECT_DIRECTORY` tree inspection; real async `Promise.race` + `AbortController` 2000ms fail-closed timeout; real detached subprocess PGID `SIGKILL` + fail-closed non-Linux `cgroup v2` probe; signed `CoreApiTokenAuthenticator` + `project_memberships` RBAC enforcement; `REQUEST_CHANGES` + `rework_count`/`max_rework_cycles` escalation; collision-free `canonicalizeJson`.
   - **Explicitly scoped simulations:** Control-plane state in `npm test` uses `SoftwareFactoryControlPlaneStore` in-memory harness alongside real PostgreSQL SQL migrations; Linux `cgroup.freeze`/`cgroup.kill` operations default to `SimulatedCgroupV2SandboxBackend` (`isSimulated: true`) on non-Linux dev hosts unless running on Linux `cgroup v2` with `requireKernelCgroup: true`.
