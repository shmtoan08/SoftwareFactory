# Software Factory (v1.5)

Deterministic, lease-coordinated AI Software Factory Control Plane with 4-tier PostgreSQL Row-Level Security (RLS), write-ahead worker outbox, fail-closed Git pre-receive gating, 3D independent code review, 8-field cryptographically bound human approval, rework cycle controls, and atomic CAS merge recovery.

## Current Milestone Status

- **Milestone `M0` (Architecture & Specification Freeze):** Locked at `v1.5`
- **Milestone `M1` (`M1.1` → `M1.4` Core Vertical Slice & Adversarial Test Gate):** Completed (`18/18` M1 tests + real PostgreSQL `0001`/`0002` RLS matrix passing)
- **Milestone `M2` (Worker Plane, Sandbox Isolation, Controlled Git Push Import & Adapter `P-010`):** Completed (`6/6` M2 gate tests + `19/19` review-hardening `FIX-01..FIX-27` regression tests passing)
- **Milestone `M3` (`M3.1` → `M3.4` Merge Candidate Builder `C_candidate` & 3-Tier Trusted Docker Verifier):** Completed (`10/10` M3 gate, `FAH-01A/B/C`, `P0-3` & review-hardening tests + real PostgreSQL `0001`/`0003`/`0002` migrations passing)
- **Milestone `M4` (3D Independent Reviewer, Approval TTL, Idempotent Atomic CAS Merge & Crash Recovery `P0-3`, `P1-7`):** Completed (`8/8` M4 gate tests + real PostgreSQL `0001`/`0003`/`0004`/`0002` migrations passing; **`61/61` total tests passing**)
- **Milestone `M5` (Live WNA Daemon, Real PostgreSQL Runtime Pool & Live Model Providers):** Planned next milestone

## Quick Start

Requires **Node.js >= 22.18.0** (verified on Node `v26.3.0` with native TypeScript execution).

```bash
npm install
npm run lint
npm run scan:secrets
npm run typecheck
npm test
```

To verify the real PostgreSQL 4-tier RLS SQL migrations, M3/M4 additive schema & constraints, and isolation test matrix (`RLS-T1..RLS-T8`) against a PostgreSQL 16+ instance:

```bash
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0001_mvp_core_schema_and_rls.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql
psql -v ON_ERROR_STOP=1 -f packages/database/migrations/0002_rls_verification_matrix.sql
```

## Monorepo Structure

```text
SoftwareFactory/
├── apps/
│   ├── agent-gateway/      # Worker gateway, live HTTP pre-receive server, HMAC lease push tokens & EphemeralReviewerCredentialService (`ROLE_REVIEWER_READONLY`)
│   ├── core-api/           # Orchestration service with signed HMAC AuthN, live RBAC, M3 candidate/verifier orchestration & M4 reviewer/CAS-merge/rebase recovery
│   └── web/                # Approval Center bundle helpers & 8-field cryptographically bound submission controller (`APPROVED` / `REJECTED` / `REQUEST_CHANGES`)
├── packages/
│   ├── adapter-sdk/        # AgentRuntimeAdapter, TaskContextAssembler, and ClaudeCodeCliAdapter (P-010)
│   ├── database/           # PostgreSQL 4-tier RLS SQL migrations (`0001`..`0004`) & SoftwareFactoryControlPlaneStore (3D review, TTL, merge_operations)
│   ├── reviewer/           # IndependentReviewerService (Context Firewall, read-only WORM sandbox, TypeScript AST Tier-3 test inspection, diff/scope analysis)
│   ├── shared-types/       # Canonical 11-state TaskStatus transition matrix, M4 review/approval/merge records & canonical JSON SHA-256 helpers
│   ├── task-contract/      # Path policy precedence, 6-step validateGitTreeImport & inspectRealGitCommitForImport (quarantine-aware)
│   ├── test-harness/       # FakeAgentHarnessAdapter + M1 (18 tests), M2/FIX-01..27 (25 tests), M3 (10 tests), & M4 (8 tests) acceptance suites
│   ├── verifier/           # Real Git `C_candidate` builder (`git merge-tree --write-tree`), immutable WORM `.tar` snapshots, & 3-tier hardened Docker Verifier
│   └── wna/                # Worker Node Agent LocalOutboxBuffer (.jsonl), native C Linux supervisor (`native/sf_sandbox_supervisor.c`), & SandboxBackend
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

Running `npm test` executes [`m1-acceptance.test.ts`](./packages/test-harness/src/m1-acceptance.test.ts), [`m2-acceptance.test.ts`](./packages/test-harness/src/m2-acceptance.test.ts), [`m3-acceptance.test.ts`](./packages/test-harness/src/m3-acceptance.test.ts), and [`m4-acceptance.test.ts`](./packages/test-harness/src/m4-acceptance.test.ts) (`61/61` tests):

1. **8-Scenario PostgreSQL RLS Isolation Matrix (`RLS-T1` → `RLS-T8`):** Verified both in the control-plane harness and directly against PostgreSQL via [`0001_mvp_core_schema_and_rls.sql`](./packages/database/migrations/0001_mvp_core_schema_and_rls.sql) + [`0003_m3_candidate_snapshot_and_verifier_tiers.sql`](./packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql) + [`0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql`](./packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql) + [`0002_rls_verification_matrix.sql`](./packages/database/migrations/0002_rls_verification_matrix.sql) (multi-transaction `SET LOCAL` + `DISCARD ALL`, Tier 3 append-only immutability, 8-field composite FK binding, M3 `chk_vr_pass_consistency`, and M4 `chk_ra_independent_credential`/`chk_ra_independent_agent_profile`/`review_sessions`/`chk_ar_ttl_window`/`uq_mo_idempotency` + `app_runtime` RLS/GRANT denials).
2. **10 Adversarial & Recovery Scenarios (`Scenario 1` → `Scenario 10`):** Full 11-state vertical slice happy path, duplicate retry vs payload mismatch, out-of-order sequence gap replay, invalid state transition rejection, concurrent lease revoke race + `clock_timestamp()` expiry + `killAndVerifyClean`, orphaned Git push recovery, 6-step Git tree import validation, 3D independent reviewer enforcement, mid-approval CAS conflict invalidation (`BuildingMergeCandidate`), and post-merge crash reconciliation + Approval TTL expiry.
3. **6 Milestone `M2` Gate Scenarios (`M2-Gate-1` → `M2-Gate-6`) & 19 Review Hardening Tests (`(a)` → `(s)`, `FIX-01..FIX-27`):**
   - **Real OS/Git/HTTP paths verified E2E:** Real `git push` -> `scripts/git-hooks/pre-receive` -> `curl` -> live `AgentGatewayHttpServer` (`POST /internal/v1/git/pre-receive-verify`) with per-lease HMAC Bearer tokens and quarantine `GIT_OBJECT_DIRECTORY` tree inspection; real async `Promise.race` + `AbortController` 2000ms fail-closed timeout; on Linux hosts, real native supervisor [`sf_sandbox_supervisor.c`](./packages/wna/native/sf_sandbox_supervisor.c) executing `PR_SET_CHILD_SUBREAPER` + double-fork detached orphan `waitpid(-1)` reaping (`(r)`), real Linux `mount`/`pid`/`ipc`/`uts` (plus `user` when unprivileged) namespaces + OS-level masked-path read denial + `PR_SET_NO_NEW_PRIVS` + capability drop when supported (`(s)`), and real `cgroup v2` cleanup when writable; signed `CoreApiTokenAuthenticator` + `project_memberships` RBAC enforcement; `REQUEST_CHANGES` + `rework_count`/`max_rework_cycles` escalation; collision-free `canonicalizeJson`.
4. **10 Milestone `M3` Gate & Review Hardening Scenarios (`M3-Gate-1` → `M3-Gate-10`, `FAH-01A/B/C` & `P0-3`):**
   - **Real Git candidate construction & WORM `.tar` snapshots:** `git merge-tree --write-tree --name-only -z` + `git commit-tree` two-parent `C_candidate` creation before verification, Git merge conflict routing (`ReworkRequired` without candidate creation), and `git archive --format=tar` immutable WORM snapshots (`0o444`, SHA-256 tamper detection, zero `.git`, 14-day GC vs CAS `MERGED_PERMANENT` promotion).
   - **3-Tier Trusted Verifier & anti-cheat invariants:** Tier 1 outside-repo trusted acceptance tests + `trusted_policy_sha256` binding (`FAH-01A`), Tier 2 pre-execution protected baseline SHA-256 verification (`TEST_TAMPERING_DETECTED`, `FAH-01B`), Tier 3 assertion/skip evidence extraction (`FAH-01C`), zero-hardlink cache copy + symlink/hardlink violation rejection, secret env stripping, `TEST_TIMEOUT` -> `ReworkRequired`, and `INFRA_ERROR` retry up to 2 times without incrementing `rework_count` (`P0-3`).
5. **8 Milestone `M4` Gate & Review-Hardening Scenarios (`M4-Gate-1` → `M4-Gate-8`):**
   - **3D Independent Reviewer (`ROLE_REVIEWER_READONLY`):** Enforces 5-axis identity independence (`principal`, `session`, `credential`, `agent_profile`, `(provider, model)`), fails closed on Ephemeral Git push token issuance for reviewers, enforces Context Firewall (blocking developer scratchpad/CoT/push-token leakage), mounts only verified WORM snapshot in read-only sandbox with `chmod 0o555` + process reaping, and performs TypeScript AST Tier-3 test quality inspection + automatic invalidation (`INVALIDATED_STALE_CANDIDATE`) on re-verification or superseding candidates.
   - **Approval Center TTL, Atomic CAS Merge & Phục hồi Lỗi (`P1-7`):** Verifies 8-field lock in Approval Console UI helpers, `ApprovalRequest` TTL enforcement (`409 ERR_APPROVAL_EXPIRED_OR_STALE`), live `refs/heads/main` stale-base detection, real Git `git update-ref refs/heads/main <C_new> <B_base>` crash reconciliation (`ERR_SIMULATED_POST_MERGE_CRASH` -> `RECONCILED_ALREADY_MERGED` across idempotent retries without double-merge), true CAS conflict -> `BuildingMergeCandidate` -> `rebuildMergeCandidateAfterCasConflict` without re-running coding agent, bounded `rework_count` -> `ManualIntervention`, and M3 review `#209183213` Minor #1/#2 telemetry (`WARN_SNAPSHOT_PROMOTION_FAILED` + `corruptManifestPaths`).
6. **Explicitly scoped simulations & runtime telemetry honesty:** Control-plane state in `npm test` uses `SoftwareFactoryControlPlaneStore` in-memory harness alongside real PostgreSQL SQL migrations; `IndependentReviewerService` exercises deterministic AST/diff/sandbox/context-firewall evaluators rather than live external LLM API calls; non-Docker sandbox/subprocess fallback runs honestly report `isDockerIsolated: false` (`execution_backend: "linux-supervisor"` / `"host-subprocess"`), `requireDocker: true` fails closed (`ERR_DOCKER_VERIFIER_UNAVAILABLE`) when the Docker daemon or image is unavailable, and real hardened Docker execution (`--read-only --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit=512 --memory=4g --cpus=2 --network=none`) runs whenever a Docker daemon and base image are present (e.g., on Linux CI).


