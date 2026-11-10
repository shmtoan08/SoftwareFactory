# Software Factory (v1.5)

Deterministic, lease-coordinated AI Software Factory Control Plane with 4-tier PostgreSQL Row-Level Security (RLS), write-ahead worker outbox, fail-closed Git pre-receive gating, 3D independent code review, 8-field cryptographically bound human approval, and atomic CAS merge recovery.

## Current Milestone Status

- **Milestone `M0` (Architecture & Specification Freeze):** Locked at `v1.5`
- **Milestone `M1` (`M1.1` → `M1.4` Core Vertical Slice & Adversarial Test Gate):** Completed (`18/18` acceptance tests passing)
- **Milestone `M2` (Worker Plane, Linux Subreaper Sandbox, Controlled Git Push Import & Adapter `P-010`):** Completed (`6/6` Gate tests passing; `24/24` total tests passing)

## Quick Start

Requires **Node.js >= 22.6.0** (verified on Node `v26.3.0` with native TypeScript test execution and zero external npm runtime dependencies).

```bash
npm install
npm test
```

## Monorepo Structure

```text
SoftwareFactory/
├── apps/
│   ├── agent-gateway/      # Worker-facing gateway enforcing scoped RLS transactions & staging push checks
│   ├── core-api/           # Orchestration service for tasks, leases, import validation, candidates, review & CAS merge
│   └── web/                # Approval console controller binding all 8 mandatory candidate/review fields
├── packages/
│   ├── adapter-sdk/        # AgentRuntimeAdapter, TaskContextAssembler, and ClaudeCodeCliAdapter (P-010)
│   ├── database/           # PostgreSQL 4-tier RLS SQL migrations & SoftwareFactoryControlPlaneStore
│   ├── shared-types/       # Canonical state transition matrix, event envelopes, ACK contracts & SHA-256 helpers
│   ├── task-contract/      # Path policy precedence, 6-step validateGitTreeImport & inspectRealGitCommitForImport
│   ├── test-harness/       # FakeAgentHarnessAdapter + M1 (18 tests) & M2 (6 tests) acceptance suites
│   └── wna/                # Worker Node Agent LocalOutboxBuffer (.jsonl) & LinuxCgroupV2SandboxBackend (Subreaper)
└── scripts/
    └── git-hooks/
        └── pre-receive     # Fail-closed Git pre-receive hook gatekeeper (2000ms timeout)
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

## Verification Coverage (`npm test`)

Running `npm test` executes [`m1-acceptance.test.ts`](./packages/test-harness/src/m1-acceptance.test.ts) and [`m2-acceptance.test.ts`](./packages/test-harness/src/m2-acceptance.test.ts):

1. **8-Scenario PostgreSQL RLS Isolation Matrix (`RLS-T1` → `RLS-T8`):** Default Deny, cross-tenant SELECT/INSERT/UPDATE/DELETE isolation, connection pool `SET LOCAL` / `DISCARD ALL` reset safety, Tier 3 append-only immutability, and 8-field composite foreign key binding.
2. **10 Adversarial & Recovery Scenarios (`Scenario 1` → `Scenario 10`):** Full vertical slice happy path, duplicate retry vs payload mismatch, out-of-order sequence gap replay, invalid state transition rejection, concurrent lease revoke race + `clock_timestamp()` expiry + `killAndVerifyClean`, orphaned Git push recovery, 6-step Git tree import validation, 3D independent reviewer enforcement, mid-approval CAS conflict invalidation (`NEEDS_REBASE`), and post-merge crash reconciliation + Approval TTL expiry.
3. **6 Milestone `M2` Gate Scenarios (`M2-Gate-1` → `M2-Gate-6`):** Double-fork orphan & sandbox escape defense (`sf-wna` subreaper `waitpid()` + `rmdir(cgroup)` + `/etc/sf-wna` mount deny), malicious Git push rejection at `pre-receive`, Fail-Closed `2000ms` timeout/outage protection, automatic `OrphanedPushReconciler` from `verified_code_imports`, real local Git repository tree inspection (`inspectRealGitCommitForImport`), and `AdapterContractTestSuite` for `FakeAgentHarnessAdapter` + `ClaudeCodeCliAdapter` (`P-010`).
