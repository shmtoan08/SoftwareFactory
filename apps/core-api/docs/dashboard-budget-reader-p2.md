# Dashboard P2 — independent Budget snapshot implementation

Date: 2026-11-16 (Asia/Tokyo). Tracker: [issue22](https://github.com/shmtoan08/SoftwareFactory/issues/22). Status: **IMPLEMENTED FOR SEPARATE TEAM REVIEW**; P0/P1 were accepted by owner/team, but P2 is not self-accepted and Dashboard/P3 are not enabled by this commit.

`GET /api/v1/projects/:projectId/budget-snapshot` implements the [approved P0 contract](./dashboard-read-projections-p0.md). V1 accepts no query parameters. Existing `/budget` and its recovery path are unchanged. No migrations/indexes/views/grants/RLS, shared-types/adapter-sdk/task-contract signatures or frontend behavior changed.

## Call chain and semantics

HTTP authenticates signed context; Core's BudgetReadProjectionService verifies the same existing read roles and signed project binding before invoking readBudgetProjection. The repository independently checks live membership and project existence inside one **REPEATABLE READ READ ONLY** snapshot under app_runtime/current project/principal/core_api_service. It uses the existing independently scoped read-transaction helper, not a write transaction, rollback wrapper, legacy budget getter or recovery skip flag.

Fixed query count: membership, project existence, minimal policy columns, scalar aggregates/EXISTS. Every query is SELECT-only with explicit verified project predicate and existing RLS. There is no SELECT-star, client-driven tenant, task/event list, N+1 loop, recovery/status query or callback. Statement 2 s, lock 250 ms, acquire 1 s and whole-operation 5 s bounds come from the existing reader transaction helper; serialized response is capped 1 MiB, and failures never return partial data.

Budget usage sums **all persisted model ledger statuses**, including nonzero failed/blocked usage: actual_total_tokens, actual_cost_micro_usd; resource wall_time_ms is recorded phase/attempt time, not live elapsed time. Estimated reservations and cost-session totals are not added. Nullable/absent policy distinctions are explicit. Configured remaining is exact limit-consumed and can be negative; no clamping. PG casts sums/BIGINT limits to text; memory validates each numeric sample as a safe nonnegative integer before BigInt accumulation. Invalid source/precision/timestamp/scope fields fail with a generic 500, not rounded values or invented zero/clear.

Recovery is a same-snapshot EXISTS on budget_denial_intents(project_id,status=PENDING). It includes committed intents whose outer transaction is still active and older replay-eligible intents; completed/other-project intents and historical BLOCKED ledgers do not create a pending result. PG query/schema/permission failure is 500. Memory has no authoritative independent intent journal, so reports **unknown/journal-not-modeled**, never fake clear. Pending/unknown snapshots remain provisional observations, not authority to spend/resume/release.

## Verification mapping

New harness: packages/test-harness/src/dashboard-budget-reader.test.ts (**11 tests**, memory 4 + PG 7). The existing P1 harness shares only the content/catalog observation helpers through dashboard-read-test-support.ts; its assertions and reader behavior remain intact. Default npm test and test:dashboard:budget include the P2 harness; required PG16/17 CI supplies PostgreSQL so the PG tests cannot be credited from a local skip.

| Matrix coverage | Evidence |
|---|---|
| RO-01/02 transaction/scope/enforcement | Instrument each actual budget DAO query and assert read_only=on/isolation=repeatable read; existing P1 shared-helper tests continue checking physical UPDATE denial and nested/autonomous/callback guards |
| RO-03/04/05 read-only source/state | Full deterministic logical content of all project-scoped tables before/after, including policy/usage/intent/audit/outbox/lease data and exact schema/catalog comparison; trap legacy getter/recovery and authorization command paths |
| Auth/DTO/bounds | All four authorized roles; signed cross-project/nonmember/stale-role/header failures; no query parameters; fixed DTO allowlist and empty source/policy-absent behavior |
| Precision/status/source semantics | All five ledger statuses, estimated usage flag, no reservation/session double count, PG above-safe-integer consumed/limit and negative remaining; memory unsafe/corrupt samples fail 500 |
| Recovery states | PG clear/pending, completed/other-project and still-active-outer intents; memory unknown; authoritative failures do not fall back to unknown/clear |
| Snapshot consistency | Independent committed writer changes policy, metric and pending intent between SELECTs; first result remains on original snapshot, next request sees the complete new state |
| Error/resource cleanup | Real pg_sleep exceeds statement timeout -> generic 500, connection/queue released, subsequent clean read succeeds and content equality holds; expired deadline/nested/invalid DTO cases |
| Legacy compatibility | New reader leaves pending intent and content unchanged; legacy Core budget read still applies recovery and AUTO_PAUSED/completes intent, demonstrating the old path retains its intended side effects |

Local validation uses a private PostgreSQL17 cluster on port 55441 and a dedicated sf_m6c3_a_budget_p2 database, without touching shared/production DBs. Run combined P1+P2 tests with `node --test --test-concurrency=1 packages/test-harness/src/dashboard-project-reader.test.ts packages/test-harness/src/dashboard-budget-reader.test.ts`, matching the default suite: P1 deliberately takes a table-wide exclusive lock for its lock-timeout test, so running both files concurrently against one database can block unrelated fixtures. Final targeted validation passed 20/20 tests (4 suites, no skips); the full local regression passed 361/361 (53 suites, no skips). Typecheck, lint and secret scan passed. exact-source PG16/17 CI results are linked in issue22 after completion. No model/provider/VM/deployment calls are needed for this projection.

Aggregates have bounded time, not constant scan cost. Existing indexes/data scale and timeouts constrain reads; this slice adds no index and makes no universal production-scale claim. P3 task pagination still requires its own review and EXPLAIN/scale decision if necessary.

Next gate: team reviews P2 implementation, source/CI and this RO mapping. Budget UI can consume it only after P2 ĐẠT; P3 follows the issue's separate gate. This does not accept G7 or change production Codex metering policy.
