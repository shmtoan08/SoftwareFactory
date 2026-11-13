# Software Factory v1.5 — Milestone M6C Specification (`M6C-SPEC-01`)
## Parallel Execution, Serialized CAS Merge Queue, Multi-Runtime Adapters, Extended Imports, External Targets & Budget Auto-Pause (`AC-12c`)

**Document ID:** `M6C-SPEC-01`

**Version:** `1.5.0`

**Status:** Normative Implementation Specification for Milestone `M6C` (Phase 8 / Gate `G7` Release Readiness)

**Prerequisites:** `MVP-SPEC-01..05` (`M1`–`M5`), `M6A-SPEC-01` (`M6A`, `AC-10`, `AC-12b`), `M6B-SPEC-01` (`M6B`, Stages 5–9, `AC-11b`)

---

## 1. Scope & Phased Delivery

Milestone `M6C` completes Phase 8 of the Software Factory v1.5 roadmap across three sequential vertical slices:

1. **Slice `M6C-1` (Parallel Core, Serialized Merge Queue, Budget Auto-Pause `AC-12c`, OpenTelemetry & `038d19a` Review Hardening):**
   - Persisted task DAG dependencies (`task_dependencies`) materialized from Stage 7 (`depends_on_task_keys`), Stage 9 Change Requests, and direct task creation, enforced fail-closed in both PostgreSQL (`0009` recursive cycle guard + FK isolation) and scheduler/lease dispatch.
   - Sound glob-intersection analyzer (`doGlobPatternsIntersect` / `doTaskAllowedFilesIntersect`) in `@software-factory/task-contract` preventing concurrent dispatch of same-project tasks whose `allowed_files` overlap, while allowing disjoint parallel execution across worktrees and across multi-tenant projects.
   - Per-project FIFO **Serialized CAS Merge Queue (`merge_queue_entries`)** coordinating `AtomicCasMerge` with automatic candidate rebase (`rebuildMergeCandidateAfterCasConflict`) on `CAS_CONFLICT_NEEDS_REBASE`, while preserving the mandatory invariant that every rebased candidate (`C_cand'`) still undergoes **3-Tier Verification → 3D Independent Review → 8-Field Human Approval** prior to merging onto `refs/heads/main`.
   - **Project & Task Budget Enforcement + Instant `Auto-Pause` (`AC-12c`)** across tokens, micro-USD cost, and execution wall-time (`project_budget_policies`, `task_budget_policies`, append-only `budget_pause_events`), integrated into task dispatch, `AC-12b` Cost Guard preflight/postcall, and `AC-12a` resource telemetry, with `APPROVAL_ROLES`-gated resume (`POST /budget/resume`).
   - **OpenTelemetry Observability (`@software-factory/observability`):** Zero-dependency W3C `traceparent`/`tracestate` propagation, secret-redacted spans & metrics (`scheduler.*`, `merge_queue.*`, `budget.*`, `http.server.*`), in-memory test collector, and OTLP/HTTP JSON v1 exporter.
   - Resolution of all 8 Minor Notes from review commit `038d19a` (accurate `README.md` loopback/private HTTP rules, safe non-bare checkout check & atomic `trusted_acceptance_dir` reservation in Stage 5 bootstrapper, conditional `allow_rebased_tree_hash` in `rebuildMergeCandidateAfterCasConflict`, explicit documentation of `M6A-FU-01`/`M6A-FU-03`/`M6B-FIX-02`, test comment corrections, and concurrent bootstrap regression coverage).
2. **Slice `M6C-2` (Second Coding Agent Runtime Adapter & Extended Import Paths):**
   - Second `AgentRuntimeAdapter` implementation (`OpenAI Codex CLI` headless `codex exec`) passing `AdapterContractTestSuite`.
   - Three additional code import paths (`Git Bundle Upload`, `Unified Diff / Patch Upload`, and `Artifact API Submission`) normalized into isolated Git commits and routed unconditionally through the exact same fail-closed 6-step `TrustedImportValidator` (`validateGitTreeImport`).
3. **Slice `M6C-3` (External Targets Tier 2/3/4, Kernel-Isolated Verifier `gVisor`/microVM, `Lima`/`WSL2` Backends & Production Deployment Approval Gate):**
   - Concrete execution connectors/supervisors for Tier 2 (`user_managed_worker`), Tier 3 (`provider_managed_vm`), and Tier 4 (`remote_agent_session`) with strict trust-tier policy boundaries and fail-closed health/identity checks.
   - Kernel-isolated `Docker3TierVerifier` runtime (`--runtime=runsc` `gVisor` / Firecracker microVM abstractions) plus cross-platform worker VM backend adapters (`Lima` macOS / `WSL2` Windows) validated via `SandboxIsolationTestSuite`.
   - Production Deployment Gate blocking any automatic deployment execution without a verified, non-expired human approval signature bound to the exact released artifact/commit.

---

## 2. Architecture & Design Details (`M6C-1`)

### 2.1 Task DAG Dependencies & `allowed_files` Conflict Detection
1. **Relational Persistence (`task_dependencies`):**
   - Every dependency edge `(project_id, task_id, depends_on_task_id, dependency_kind)` uses composite foreign keys `(task_id, project_id)` and `(depends_on_task_id, project_id)` referencing `tasks(task_id, project_id)` so cross-project dependency references are impossible.
   - A `BEFORE INSERT` PostgreSQL trigger (`fn_prevent_task_dependency_cycle`) walks ancestors via `WITH RECURSIVE` and rejects cycles with SQLSTATE `23514`.
   - When `grantTaskLease` executes on any task, if any upstream `depends_on_task_id` is NOT in `MergedAndCompleted`, lease dispatch fails closed with `23514`.
2. **Sound Glob Language Intersection (`packages/task-contract`):**
   - Because `TaskContractSpec.allowed_files` uses POSIX globs (`**`, `*`, `?`), simple string equality misses overlaps such as `src/**/*.ts` vs `src/auth/*.ts` or `*.mjs` vs `**/*.mjs`.
   - `doGlobPatternsIntersect(globA, globB)` compiles normalized globs into segment/character NFAs matching `globToRegExp` semantics and searches their determinized product over literal characters and fresh wildcard representatives. Task-level comparison includes the forbidden/protected languages in the product state, preserving case-insensitive forbidden matching and case-sensitive protected matching. It can therefore find a longer permitted witness after a shorter witness is excluded. Path safety is tracked in the same search. A 50,000-state complexity limit throws and denies dispatch; it never reports a complex unknown intersection as disjoint.
   - `ParallelTaskScheduler` checks candidate ready tasks pairwise against BOTH currently in-flight project tasks (`Leased | ExecutingInTarget | BuildingMergeCandidate | VerifyingInDocker | UnderIndependentReview | AwaitingHumanApproval | AtomicCasMerge`) and other tasks selected in the same parallel dispatch batch, serializing any overlapping pair unless the conflict is resolved sequentially.

### 2.2 Per-Project Serialized CAS Merge Queue (`merge_queue_entries`)
1. Every approved task awaiting merge enters `merge_queue_entries` with monotonic `queue_position` per `project_id`, constrained by partial unique index `uq_mqe_active_task_per_project` on `(project_id, task_id) WHERE status IN ('QUEUED', 'PROCESSING')`.
2. Queue draining acquires a project-scoped merge serialization lock (`SELECT ... FROM projects WHERE project_id = $1 FOR UPDATE` in PG / `project-merge-queue:${projectId}` in memory), allowing Project A and Project B to drain concurrently without blocking each other while strictly serializing merges within a project.
3. For each dequeued entry:
   - Calls `executeAtomicCasMergeOrReconcile`.
   - On `MERGED_BY_CAS` / `RECONCILED_ALREADY_MERGED`: marks entry `MERGED` and records `merged_commit_hash`.
   - On `CAS_CONFLICT_NEEDS_REBASE`: when an active Git repo & `auto_rebase_on_conflict` are enabled, invokes `rebuildMergeCandidateAfterCasConflict` against the updated `refs/heads/main`:
     - Clean rebase produces a new `MergeCandidate` (`C_cand'`) with `allow_rebased_tree_hash = (agentCommitParentSha !== null ? newBaseMain !== agentCommitParentSha : newBaseMain !== task.base_main_commit_hash)` and transitions `queue_entry` to `REBASED_NEEDS_REVERIFY` (task enters `VerifyingInDocker`). The rebased candidate MUST still pass 3-Tier Verifier, 3D Independent Review, and fresh 8-Field Human Approval before re-entering the merge queue.
     - Conflicting rebase leaves task in `ReworkRequired` and marks queue entry `FAILED` with conflicted file diagnostics.

### 2.3 Project & Task Budget Enforcement & Auto-Pause (`AC-12c`)
1. **Entities (`0009`):**
   - `project_budget_policies` (`project_id PK`, caps for `max_project_tokens`, `max_project_cost_micro_usd`, `max_project_wall_time_ms`, per-task defaults `default_task_*`, `max_concurrent_tasks`, `status IN ('ACTIVE', 'AUTO_PAUSED')`, `pause_scope`, `paused_task_id`, `pause_reason`).
   - `task_budget_policies` (`(project_id, task_id) PK`, per-task overrides + per-task `AUTO_PAUSED` status).
   - `budget_pause_events` (Tier 3 strictly append-only audit ledger of `AUTO_PAUSED`, `BUDGET_UPDATED`, and `RESUMED` transitions).
2. **Real-Time Aggregation & Circuit Breaker:**
   - Spend is aggregated deterministically from append-only `model_call_ledgers` (`actual_total_tokens`, `actual_cost_micro_usd`) and append-only `resource_usage_metrics` (`wall_time_ms`).
   - Reaching or exceeding any active ceiling (`used >= limit`) immediately transitions the affected `project_budget_policies` or `task_budget_policies` row to `AUTO_PAUSED` (using an autonomous transaction fallback when triggered during an aborting/preflight path so `AUTO_PAUSED` persists across outer rollbacks, mirroring `M6A-FU-02`/`M6A-FU-03`), appends `budget_pause_events`, and emits an `outbox_events` (`budget.auto_paused`) record.
   - When `AUTO_PAUSED`, `grantTaskLease`, `scheduleReadyTasks`, and `preflightCheckCostSession` fail closed with `BudgetAutoPausedError` (`HTTP 402`).
3. **Authorized Resume:** Only `APPROVAL_ROLES` (`PROJECT_APPROVER`, `ORG_ADMIN`) may call `POST /api/v1/projects/:projectId/budget/resume` (or `/tasks/:taskId/budget/resume`), which requires updating the breached ceiling strictly above current observed spend (`newLimit > currentUsed`) before flipping status back to `ACTIVE`.

### 2.4 Security & Operational Clarifications (`038d19a` Notes #4, #5, #6)
- **`M6A-FU-03` (`55P03` Lock Fallback):** In `PostgresControlPlaneRepository.preflightCheckCostSession` / `finalizeModelCallLedger`, when an outer transaction already holds a row lock on the target `model_cost_sessions` row, the autonomous `FOR UPDATE NOWAIT` probe catches `SQLSTATE 55P03` and cleanly falls back to executing in the outer transaction rather than self-deadlocking.
- **`M6A-FU-01` (SHA Integrity Verification):** `change_requests.cr_sha256` immutability is protected by both PostgreSQL `fn_enforce_change_request_transitions()` (blocking updates to spec columns and hash) and deterministic read-time SHA-256 verification on `getChangeRequestById` / `listChangeRequests` / `decideChangeRequest` / `applyChangeRequestAndMaterializeTasks`.
- **`M6B-FIX-02` (Custom Assertion Execution Boundary):** Stage 5 custom `acceptance_specs[].assertion_lines` are restricted at registration time via strict AST/pattern checks (disallowing `process`, `require`, `import`, `eval`, control flow, or `;`) AND executed strictly inside the isolated Tier 1 `Docker3TierVerifier` sandbox against the immutable read-only `trusted_acceptance_dir`.


## 3. M6C-1 Local Acceptance & Operational Boundaries (2026-11-12)

Run `npm run test:m6c` after applying migrations `0001`, `0003`–`0009` (and the existing `0002` RLS verification matrix). With `PGHOST`/`DATABASE_URL` configured, all eight suites run; without it, the PostgreSQL suite explicitly skips.

| Suite | Evidence |
|---|---|
| Glob intersection | Overlapping wildcard languages, disjoint paths, forbidden/protected exclusions and alternate witnesses |
| Parallel dispatch | Concurrent scheduler requests, no overlapping tasks, upstream gate, project capacity and tenant isolation |
| Budget / resume | Durable preflight denial + append-only ledger, actual token spend, wall-time pause, approver-only explicit ceiling increase |
| Concurrent spend | Separate model cost sessions and task metrics reach one shared project ceiling without missed accounting |
| Real Git merge queue | FIFO claim/complete, crash after `update-ref`, idempotent retry, stale candidate invalidation, clean rebase and fresh approval before merge |
| HTTP / client | Signed RBAC, URL-bound project/actor identity, scheduler API and W3C parent/child context propagation |
| OTLP telemetry | Trace hierarchy, redaction, counter/histogram JSON export and exporter-failure isolation |
| PostgreSQL `0009` | Real concurrency, budgets and Git queue; FORCE RLS, append-only audit, concurrent cycle rejection, direct SQL dependency fencing and uncommitted-policy fallback |

The queue claim, CAS/reconciliation, optional candidate rebuild and terminal queue update share one tenant transaction under a project merge lock. A crash rolls the claim back to `QUEUED`; a retry reconciles Git before deciding whether to merge. A rebased candidate leaves the queue as `REBASED_NEEDS_REVERIFY`, never as approved code.

Budget pause blocks subsequent dispatch and model calls. In-flight calls are still accounted for. Autonomous aggregate-budget denial accounting checks committed parents and uses NOWAIT probes. Under contention/uncommitted policies or parents, M6C-FIX-04 registers awaited completion work, releases the outer transaction and connection, then persists the captured denial in a fresh tenant transaction on commit or rollback. A missing rolled-back policy is restored with the observed denial ceiling. A rolled-back cost session cannot own a ledger; the surviving project's budget audit is retained without fabricating that parent. A rolled-back project has no durable identity to pause. Completion failures propagate rather than being silently dropped. This is transaction-end retry, not a persistent job queue for process termination before callbacks run. Resume requires an approver and an explicit ceiling for the paused scope above current observed usage; policy updates alone never resume a paused scope.

M6C-FIX-01 applies capacity/file exclusion to public direct dispatch as well as scheduler dispatch. M6C-FIX-02 turns a glob state explosion into a per-task scheduler denial. M6C-FIX-03 rejects PostgreSQL merge-queue lock calls outside an explicit tenant transaction before invoking their callbacks. M6C-FIX-05 expands telemetry redaction across hyphenated keys, assigned tokens/cookies, JWT/Basic, URL credentials and private-key PEM blocks. Regression evidence is in [the review-fix report](./m6c-review-fixes-validation.md).

Local validation uses macOS, real Git, Node 26 and PostgreSQL 17. It does not establish Linux kernel/container isolation; the Linux CI PG16/17 matrix retains that responsibility. M6C-1 evidence alone does **not** complete the other slices or release gate `G7`.

## 4. M6C-2 Implementation & Acceptance Boundaries (2026-11-12)

- **Runtime:** `CodexCliAdapter` implements the existing WNA adapter contract. Operator configuration selects `claude-code-cli` or `codex-cli`; an explicit adapter overrides configuration. Codex requires an explicit model, scoped API credential and detached linked worktree at the task base. A permission profile extends `:workspace` and permits writes only to that worktree's Git metadata and shared objects; common refs/config stay read-only. The adapter uses JSONL terminal events and a private temporary home, disables user configuration/rules, and validates the actual one-parent Git commit and clean worktree. Adapter result parsing and WNA final cleanup remove runtime state, including on spawn failure. Credentials are redacted from execution results and excluded from inherited task environment; WNA owns Git push. Flags/profile behavior were checked against locally installed `codex-cli 0.167.2` and official non-interactive/permission documentation.
- **Transport:** Signed `POST /api/v1/projects/:projectId/tasks/:taskId/imports` accepts only lease identity and a strict `bundle`, `patch` or `artifact` submission. Clients cannot override project paths, Git refs, task base or contract. Payloads are bounded to 2 MiB decoded / 256 artifact operations and the existing 4 MiB HTTP body cap.
- **Normalization:** A private bare quarantine fetches only the server-pinned base. Bundle imports must name one branch and a commit with that base as sole parent. Patch imports apply to an isolated index. Artifacts are explicit write/delete operations, never archive extraction. Patch/artifact commits use deterministic metadata and source SHA-256. Hooks, fsmonitor, external diff/text conversion and non-file transport are disabled. Git commands have timeout/output bounds.
- **Common validation:** All transports use `inspectRealGitCommitForImport` and `validateGitTreeImport`. NUL-delimited raw/numstat output preserves rename sources, whitespace/control characters and exact path boundaries. The full tree is checked for unsafe/case-colliding paths; changed entries retain regular-mode, protected/forbidden path, binary, size, deletion and abnormal-change checks. Inherited baseline symlinks retain the verifier's existing structured failure behavior.
- **Fencing & receipts:** Migration `0010` adds append-only FORCE-RLS `code_import_submissions` with exact composite binding to `verified_code_imports` and one payload per lease. Normalization happens outside the final lock. Under the canonical lease/task lock, publication rechecks active lease pointer, epoch, expiry, task status, pinned base and contract. Exact payload retries return the receipt, including after lease termination; differing payloads return `409`.
- **Recovery:** Git ref publication is compensated only after the database confirms no committed receipt. A lost COMMIT response is reconciled against the receipt. If the database cannot establish the outcome, the isolated Verify ref is retained for retry/reconciliation. The existing expiry reconciler can recover real uploaded refs. No import writes `main` directly.
- **Traceability:** Candidate-bound lineage carries the immutable source receipt. Bundle/Patch/Artifact candidates pass the same verifier, independent review, eight-field human approval and serialized CAS merge path.

Run `npm run test:m6c2` after migrations through `0010`; see [the validation report](./m6c2-validation-report.md) for results. The tests use a CLI emulator, real Git/HTTP and PostgreSQL 17; a live Codex provider smoke test has not been performed. Opaque CLI calls are outside per-call managed-model ledger metering. Linux PG16/17 CI is configured but local macOS execution does not prove kernel isolation. External target connectors, kernel-isolated verification, Lima/WSL2 and production deployment approval remain M6C-3 scope; `G7` is pending.

## 5. Issue #8 Remaining Notes

The remaining-note implementation supersedes the old limitations above: all public CAS paths use FIFO queue serialization; migrations 0011/0012 verify original constraint definitions, enforce queue transitions and artifact hashes, and add a FORCE-RLS durable budget-denial intent journal. Replay is fenced by the owning PostgreSQL transaction ID, so active transactions are not replayed and process termination does not discard pending work. Bootstrap uses kernel flock ownership and invoked pending-ref cleanup. Acceptance assertion source is parsed, allowlisted and regenerated. The project owner selected blocking Codex production until reliable Cost Guard metering exists; only fixed-credential provider-free emulator tests are permitted. Native sandbox smoke runs as a separate mandatory macOS CI job. Full scope, evidence and boundaries: [remaining-note report](./m6c-review-notes-validation.md).

## 6. M6C-3 Implementation Started (2026-11-13)

The first implementation slice adds operator-controlled gVisor verifier policy, no-fallback Docker `runsc` execution for all tiers, image digest pinning and runtime evidence bound into report hashes and persisted verification records (migration 0013). Policy, failure and database tests are separate from the dedicated real-runtime Linux CI smoke. Standard policy is retained for existing factory-controlled flows; external target execution is not enabled by this change. Remaining connectors, automatic trust-tier routing, VM backends and signed production deployment gate have not been implemented. Validation status and remaining acceptance work: [M6C-3 report](./m6c3-validation-report.md).

## 7. M6C-3 Production Deployment Approval Foundation

A new fail-closed gate (migration 0014) binds authenticated approver consent to one accepted release/package, exact commit/artifact digest, configured target and bounded lifetime. It verifies a server HMAC signature, commits one durable claim before invoking an operator-registered executor, returns existing state on replay and holds unresolved targets after timeout/process death. No backend is enabled by default and requests cannot inject deploy commands or credentials. The signature records an authenticated project approver decision; user-held key/presence attestation is not implemented. Concrete cloud executors and an operator-authenticated reconciliation workflow remain pending; no production deployment or full G7 acceptance is claimed. Evidence and operating boundaries: [deployment report](./m6c3-deployment-validation.md).

## 8. M6C-3 Approved Deployment Reconciliation

Migration 0015 appends human-approved reconciliation decisions for unresolved deployments. Purpose-separated signed approvals bind the old immutable deployment snapshot and configured provider evidence; execution requires the issuing approver and unchanged evidence of a durable terminal fence. The workflow is read-only toward the provider and never deploys, retries or cancels. It appends audit and releases the hold atomically through a narrowly scoped, FORCE-RLS-subject owner trigger; runtime cannot update the hold column directly. Historical execution status and consumed approvals remain unchanged, late completion is rejected, and every fresh deployment needs a new valid approval. Real provider fencing/verifier adapters are still required. Evidence and remaining work: [reconciliation validation](./m6c3-reconciliation-validation.md). G7 remains pending.
