# M6C-1 — Implementation & Local Validation

Date: 2026-11-12 (Asia/Tokyo). Base commit: `038d19a`; changes are in the working tree.

## Delivered

- PostgreSQL and in-memory task DAG persistence, including Stage 7 / Change Request materialization and direct task creation. Composite foreign keys isolate projects; serialized graph edits reject concurrent cycles; lease dispatch rejects incomplete upstream dependencies.
- Parallel dispatch with project capacity and allowed-file intersection checks under a project dispatch lock. The glob analyzer tracks allowed and excluded languages together, so a blocked short witness cannot hide a valid longer intersection. Excessive search complexity fails closed.
- Per-project FIFO CAS queue with an atomic claim/merge/reconcile/rebuild/complete transaction. Post-Git crash retries reconcile successfully; rebased candidates require fresh verification, review and human approval.
- Project/task token, cost and wall-time budgets, durable pause/audit on committed-parent preflight denial, actual-spend accounting, and approver-only resume with an explicit ceiling above observed usage. Concurrent cost-session and wall-time ingestion respect aggregate project usage.
- Signed HTTP controls for dependencies, scheduling, merge queue, budget policy/snapshot and resume; typed client methods for core controls.
- HTTP trace propagation, redacted spans and counter/histogram OTLP JSON export with transport-failure isolation; optional runtime wiring through `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Migration `0009`, CI clean-install/upgrade wiring, concurrent Stage 5 bootstrap regression, and inclusion of new untracked source files in lint/secret scanning.

## Validation

| Check | Result |
|---|---|
| Full regression with PostgreSQL configured (`npm test`) | 102 passed, 0 failed, 0 skipped; 11 suites |
| M6C acceptance after final glob correction (`npm run test:m6c`) | 8 passed, 0 failed, 0 skipped |
| Strict lint / TypeScript | Passed |
| Secret scan, including new files | Passed; 0 findings |
| `git diff --check` | Passed |
| PostgreSQL migrations `0001`, `0003`–`0009` | Clean install passed |
| Reapply `0009` twice | Passed |
| Existing upgrade regressions | Passed, including M6B paths through `0009` |

Environment: macOS, Node `v26.3.0`, PostgreSQL `17.10`, real Git repositories and local HTTP servers. The final M6C rerun includes concurrent scheduler requests, cross-project isolation, projected/actual/concurrent spend, blocked-ledger durability, raw SQL dependency guards, concurrent DAG cycles, uncommitted-policy fallback, real Git crash/rebase recovery and HTTP/OTLP checks.

The full regression completed before the final glob correction; the directly affected M6C suite was rerun afterwards. The Linux CI matrix is configured for PostgreSQL 16 and 17; it was not executed locally during this session. macOS fallback execution is not evidence of Linux cgroup/container isolation.

## Remaining Scope & Limits

At the time of this M6C-1 validation, `M6C-2` and `M6C-3` remained pending. Subsequent M6C-2 work is recorded separately in [the M6C-2 report](./m6c2-validation-report.md). This report does not declare milestone M6C or release gate G7 complete.

At this initial validation, budget denial accounting under conflicting locks/uncommitted parents fell back to the outer transaction, and the legacy direct dispatch route did not enforce file exclusion/capacity. These limitations are superseded by M6C-FIX-01/04; current behavior and evidence are recorded in [the review-fix report](./m6c-review-fixes-validation.md).

Parallel execution should enter through `/scheduler/dispatch`; direct dispatch now enforces the same capacity/file exclusion guards. The merge queue is exposed explicitly through `/merge-queue` and `/merge-queue/drain`; existing direct CAS remains available.
