# Dashboard read projections — P0 verification and gate matrix

Status: **PROPOSED, no P1–P3 implementation/test result claimed**. [Plan #22](https://github.com/shmtoan08/SoftwareFactory/issues/22). Companion [contract](./dashboard-read-projections-p0.md), baseline `7e50586`, 2026-11-14 (Asia/Tokyo). Tests below are required acceptance work for the future implementations; the current docs-only P0 does not count them as passing.

## Common fixtures and observations

Use two real projects, two principals and multiple roles, project-bound signed auth, sessions/tasks/leases in each scope, approved plan links, recorded ledgers/resource metrics, budget policies, completed and PENDING durable denial intents. Seed with a write-capable fixture connection **before** each before-snapshot. Use independent observer and projection connections with actual app_runtime/FORCE-RLS behavior; memory mode uses equivalent schema-valid identities and source records. Do not seed through a read endpoint, skip required PG tests, or use a rollback wrapper around legacy recovery code.

Sensitive-table content baseline includes `projects`, `project_memberships`, `tasks`, `task_leases`, `processed_worker_events`, `product_pipeline_sessions`, `model_cost_sessions`, `model_call_ledgers`, `resource_usage_metrics`, `project_budget_policies`, `task_budget_policies`, `budget_denial_intents`, `budget_pause_events`, `outbox_events`, `audit_logs`, `task_plan_links` and any other source table touched by the implementation. Compare deterministic full logical row content, ordered by actual primary/composite keys, with source timestamps/statuses/JSON/hashes included. Do not use only COUNT, only primary IDs or only a row count digest. Keep sensitive fixture contents out of public logs; report equality and safe summaries/hashes.

For quiescent fixtures, exact before/after contents match. For concurrency tests, capture the *known writer's* committed changes separately; never blame them on the reader or allow arbitrary reader deltas. Audit/outbox/intent-content deltas attributable to projection reads must be zero. Compare leases including expires_at, heartbeat, epoch, status and resource/accounting records; compare denial intent status/payload/outer_xid/completed_at and budget pause/policy fields.

Instrument side-effecting services/methods to fail immediately if invoked by a read: recoverBudgetDenials, applyBudgetDenialSql/budget write paths, legacy getProjectBudgetSnapshot, provider verifier, model executor, execution-target broker, reconciler, lease grant/renew/expiry actions, scheduler, Git/fs subprocess helpers, audit/outbox writes, and transaction-end callbacks. Instrumentation is extra evidence, not a replacement for actual SQL/memory state assertions.

## Layered acceptance (all slices)

| ID | Required check | Proof / failure condition |
|---|---|---|
| RO-01 | PG transaction mode and scope | Within actual DAO requests, SELECT current_setting('transaction_read_only')='on' and transaction_isolation='repeatable read'; verify effective app_runtime role/RLS settings and caller project/principal. No separate membership read in a write transaction |
| RO-02 | Physical read-only enforcement | Dedicated harness attempts an UPDATE in a separate test read unit and expects SQLSTATE 25006; that enforcement test aborts its own transaction. Actual projection never attempts writes or hides a command via rollback |
| RO-03 | SQL/call-chain allowlist | Capture all statements of successful and failed reads. Apart from reviewed BEGIN/SET/COMMIT/reset setup, only literal parameterized SELECTs and reviewed built-ins. No SELECT *, write CTE, SELECT INTO, row/advisory lock, CALL/side-effect function, old command/recovery path or callback |
| RO-04 | Full content unchanged | Before/after snapshots of all sensitive tables match on success, validation/denied/not-found, timeout, parse/serialization and handler failure paths. Record-level updated_at/status change with equal row count must fail the test |
| RO-05 | Zero audit/outbox/intents delta | Content and counts unchanged, including an existing PENDING intent that would replay if old GET budget were called. No completion timestamp/policy pause or audit/outbox row appears |
| RO-06 | Lease/recovery unchanged | Lease status/expiry/heartbeat/epoch and intents/policies remain byte/logically equal; do not renew or recover merely to make a UI snapshot appear current |
| RO-07 | Memory purity | Deep-freeze/hash relevant store maps and nested objects before read. Response mutation must not mutate storage; repeated reads at a fixed clock are equal apart from defined envelope time. No fake empty journal to produce recoveryState=clear |
| RO-08 | Authorization/DTO | Missing/malformed auth401; invalid signed scope/role/membership403 without foreign-resource existence hint; authorized missing resource404. Assert exact allowlisted response keys and absence of repo paths, raw contracts, credentials, private snapshots and foreign rows |
| RO-09 | Error and resource cleanup | Query/acquisition/whole-operation/serialization limits fail generically, never partial success/zero data. Connections, locks, timers and async context return to baseline, no afterEnd callback or cross-request role/scope leak |
| RO-10 | Consistent response snapshot | Concurrent writer changes related inputs between reader SELECTs; one response contains one consistent old/new snapshot, not a mixed state. Next HTTP read may see new committed data. Auth rechecked on every request |
| RO-11 | Schema unchanged | Compare catalog fingerprints/definitions before/after migrations+tests for tables, views, indexes, grants and policies; projection change has no migration, new index, grant bypass or RLS relaxation |
| RO-12 | Bounded inputs/outputs | Defaults/max limits exact; >max,<=0,decimal,empty,duplicate/unknown parameters400 with no list query. limit+1 output behavior, no fetch-all, response/query caps and cancelled/failed reads verified |

Operational HTTP telemetry and pool counters may change; business `audit_logs`, outbox, intents, domain records and source files may not. Assert the distinction rather than disabling observability or treating an unchanged row count as proof of no writes.

## P1 — Project reader gate

| Case | Expected result |
|---|---|
| Authentic signed project A context, A membership | GET A detail returns only approved ProjectReadDto fields using actual projects.name, not a session title |
| A token targets B (B exists) vs random valid project UUID (absent) | Same403 shape, no unscoped existence query, no data/count leakage |
| Auth body principal/role/project tampered or membership missing | Rejected; ORG_ADMIN still cannot bypass token project. Distinguish transport401 from existing signature/permission403 convention |
| Current project-token collection (D-01) | Scope explicitly states project-token; never enumerates other principal memberships. Stable order, default 20/max 100, hasMore/nextCursor semantics. No fictional global total |
| Valid cursor and cursor past page boundary | Stable keyset outcome under approved current scope; no offset. Scope/filter/principal/limit mismatch409, malformed/forged400 |
| DTO mutation and list/detail repeated reads | Memory/PG content unchanged; no safe-reader activation before implementation review |
| Real PG16/PG17 runs | All RO checks, cross-tenant assertions, schema unchanged and CI 5/5; no conditional PG skip in required jobs |

**P1 can start only after P0 contract/test matrix review and D-01 confirmation.** Its own ĐẠT is required before a project panel consumes it; P0 approval alone is not implementation acceptance.

## P2 — Budget gate (independent business-risk gate)

| Case | Expected result |
|---|---|
| Known persisted usage with all ledger statuses | Independent exact SELECT sum of actual tokens/cost plus recorded metric wall time, no extra estimated reservations/session totals/invoices. Integers serialized exactly |
| No policy / null per-dimension limit / configured limit | policy-absent vs unbounded vs configured explicit; remaining null for the first two, exact limit-consumed for configured; no zero fallback |
| Usage exceeds limit and >Number.MAX_SAFE_INTEGER total | Signed negative remaining retained, decimal strings exact; unsafe memory source sample fails500 instead of rounding |
| PG visible PENDING denial | recoveryState=pending, reason/scope exact; policy/intent/audit/outbox unchanged. Include replay-eligible old outer_xid and still-active outer transaction variants |
| PG completed intent / no pending intent | Successful same-snapshot EXISTS yields clear only for scoped visible journal; historical BLOCKED_* ledgers alone do not imply pending |
| Other project's pending intent | Hidden by RLS plus explicit project predicate, no influence on A's recoveryState or metadata |
| Memory without independent durable journal | recoveryState=unknown, journal-not-modeled; no fake journal initialization and no clear default |
| PG missing permission/schema/query failure | Generic500; no successful clear/unknown masking SQL or auth failure |
| Concurrent policy/usage/intent changes | REPEATABLE READ consistency within response; before snapshot can remain clear even if a writer commits pending later. New read sees the new state; no finality/spend/release authorization claimed |
| Failure path / old-reader trap | Legacy method/recovery spy throws if touched; full snapshots still equal. Separately prove the old GET budget continues to recover in its own existing regression fixture, not inside new-reader comparisons |

P2 acceptance requires RO-01..12 plus all budget cases on actual PG16/17 and truthful memory behavior, exact contract, no schema change and review ĐẠT. Only then may Dashboard use budget-snapshot; it must never swap back to legacy `/budget` on error or pending/unknown.

## P3 — Task projection gate

| Case | Expected result |
|---|---|
| Session belongs to A; tasks linked to that session | Authorized exact rows only. Link association is authoritative; no task-title/current-stage inference |
| Session belongs to B vs nonexistent UUID | Same404 inside authorized A scope before task read, no foreign rows/profile/lease data |
| Duplicate links / inconsistent assignees | One task via EXISTS; duplicate same assignee does not duplicate row. Distinct conflicting profile IDs500, never arbitrary first/last |
| Active lease pointer null / valid / missing / wrong task/project/epoch | Null fields only for null pointer; valid pointer returns exact owner/expiry; invalid nonnull association500. No join leakage or lease refresh |
| Exact TaskStatus filters, invalid case/CSV/duplicate/unknown | SQL sourceStatus filter; normalization and400 rules match contract, never display-status coercion |
| Stage filter | Block P3 until D-02 approved. Do not invent a stage enum/column or map Ready/Executing to a pipeline stage; current proposal rejects supplied stage400 |
| Multiple tasks share one updated_at | Composite updated_at DESC/task_id DESC returns stable tie order, no missing/duplicate rows in a quiescent fixture; microsecond precision preserved |
| Edited/wrong-session/wrong-project/wrong-principal/wrong-filter cursor | Signature failures400; verifiable context mismatch409 after independent auth/session validation. No cursor as permission |
| Concurrent update across cursor boundary | Explicit best-effort behavior; no cross-page snapshot/exactly-once guarantee. Refresh restarts; compare within-page snapshot consistency separately |
| Bounded query and larger/sparse session fixtures | Real EXPLAIN, limit+1, timeout/caps, no full-project client join or all mode. If current indexes cannot meet the agreed bound, stop and obtain separate index/schema decision |
| Memory/PG parity | Same membership/status/null/ordering/cursor semantics for equivalent representable source records; no mutation or silently invented stage/owner |

P3 requires RO-01..12, D-02 and actual scale/index decision, contract tests on PG16/17, CI 5/5 and implementation review ĐẠT. No index/view/migration is authorized by a green unit test.

## Delivery evidence and explicit gates

For P1/P2/P3, publish source SHA, contract revision, exact commands, executed counts/no skips for required native PG checks, safe content-snapshot equality summaries, side-effect spy results, catalog comparison, transaction settings and concurrency results. Keep fixture secrets/redacted raw rows out of issue comments. Existing console/API/legacy budget regression must remain green. Team owns checklist/closure and enabling projections; dev does not self-certify a gate.

P0 delivery consists of this matrix and the contract/re-audit proposal. Source/link/status coverage checks on P0 documents are not runtime SELECT-only evidence. At P0 completion, publish to main and obtain the required review; do not begin implementation until that approval exists.
