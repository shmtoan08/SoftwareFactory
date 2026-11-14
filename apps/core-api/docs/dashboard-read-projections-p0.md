# Dashboard read projections — P0 contract v2 proposal

Status: **PROPOSED; P0 review required before P1 code**. [Plan #22](https://github.com/shmtoan08/SoftwareFactory/issues/22), [owner decision #21](https://github.com/shmtoan08/SoftwareFactory/issues/21#issuecomment-6872474855). Source audit baseline: main `7e50586a82bb9302d0a919409121f75885175c4a`; date 2026-11-14 (Asia/Tokyo). P0 introduces documentation only, not endpoints, schema, indexes, permissions or Dashboard activation.

Delivery order is **P0 → P1 Project reader → P2 Budget snapshot → P3 Task projection**. The later owner plan v2 supersedes the earlier suggestion to start Budget first. Each implementation has a separate review gate. Dashboard may consume a projection only after that implementation is reviewed ĐẠT.

## 1. Capability re-audit and reuse decision

This re-audit follows [Core routes](../src/http-server.ts), [service/authentication](../src/index.ts), [PG repository/pool](../../../packages/database/src/postgres-pool.ts), [memory store](../../../packages/database/src/index.ts), [source record types](../../../packages/shared-types/src/index.ts), and migrations [0001](../../../packages/database/migrations/0001_mvp_core_schema_and_rls.sql), [0006](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql), [0008](../../../packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql), [0009](../../../packages/database/migrations/0009_m6c_parallel_scheduler_cas_queue_and_budgets.sql) and [0012](../../../packages/database/migrations/0012_durable_budget_denial_journal.sql).

| Existing capability | Actual semantics / gap | Contract decision |
|---|---|---|
| Project detail/list HTTP | Neither GET route exists. Projects table/store records exist; an A-role approval-center embeds a subset and runs Git diff | Add P1 minimal projection; do not reuse approval-center, rename a session or add an entity |
| GET `/api/v1/projects/:p/budget` | PG `getProjectBudgetSnapshot` calls `recoverBudgetDenials`, then SELECTs; reads can persist captured denials, pause policies, audit/outbox and intent completion. Memory counterpart does not establish PG read-only safety | Add independent P2 `/budget-snapshot` DAO. Existing handler/method behavior remains unchanged. No skipRecovery flag/rollback disguise |
| GET project tasks | Core listTasks/selectVisibleTasks is a genuine record read, but no session/filter/cursor/server page. Task has no session column | Keep existing endpoint unchanged. P3 uses a separate minimal session-scoped read model and an EXISTS membership query on task_plan_links, not the old unbounded response |
| GET session and profiles | Safe source readers for their existing fields; no task links/page or full project DTO | Reuse in Dashboard R0 when approved; no duplicate session/profile endpoints |
| GET M6B bundle/traceability/lineage/approval-center | Git-backed, aggregate or A-role behavior; not a bounded SQL-only projection | Do not reuse inside new DAOs or Dashboard allowlist |
| GET reconciliation-evidence | Calls injected provider verifier | Never poll from Dashboard or invoke in projection chain |
| Active instances/active assignments/physical execution aggregates, blob URLs, full audit feed/deployment approvals | No authoritative read contract in current HTTP API | Still hidden/unsupported. P0 does not authorize extra endpoints for these |

The projection need is distinct from the safe readers already present. There is no safe existing project/budget/session-paged task read to duplicate. Existing budget recovery is intentional and must not be disabled to make the new reader pass tests.

## 2. Authorization, transaction and DTO invariants

### Existing scope — do not invent a tenant/project directory

`CoreApiAuthContext` signs **projectId**, principalId, roles, sessionId, tokenId and lifetime; `verifyAuthContext(auth,targetProjectId,READ_ROLES)` requires exact signed project match. `assertMembershipRole` reads a matching `project_memberships` row and requires its role to occur in the signed roles and allowed READ roles. There is no wildcard project token, tenant-wide list credential or active-membership flag in the current schema.

READ roles remain AUDITOR / DEVELOPER / PROJECT_APPROVER / ORG_ADMIN. ORG_ADMIN is not a bypass of the signed project/RLS scope. Neither route parameters, cursors, query filters nor a client-supplied principal/tenant field create authorization. Verify the signature before trusting scope, validate IDs/queries, and verify membership before resource lookup. Membership lookup and projection reads share the new read-only RLS transaction.

**P0 decision D-01 (explicit approval requested):** with existing auth, GET `/api/v1/projects` lists only the signed and authorized project scope (normally one row). It is not an all-memberships/all-tenant project picker. A wider project directory needs a separately approved auth/RLS design; it cannot be silently implemented under this slice. Collection metadata must state `scope: {kind:"project-token", projectId}` so the frontend cannot mistake it for a global list.

Privacy contract: absent/unparseable auth → 401 as current transport conventions; valid-shaped auth failing signature/lifetime/role/membership or a route project differing from verified scope → 403, independent of whether that foreign project exists. Within an authorized project, missing project/session/task reference → 404. Session lookup includes both session ID and authorized project ID before task/link access; foreign-session and nonexistent-session IDs return the same404. No unscoped existence probes, cross-project redirects, admin exception or resource counts in denied responses.

### Dedicated SELECT-only read unit

P1 introduces a new dedicated read transaction path; the existing `withRlsTransaction` currently uses ordinary BEGIN and may reuse an active same-scope transaction. New projection code must not silently reuse a read-write transaction or after-transaction recovery callback registry.

Required SQL shape: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`; trusted `SET LOCAL ROLE app_runtime` and existing RLS session configuration; verify membership with SELECT; perform literal parameterized SELECT-only DAO statements; COMMIT; unconditional connection/session cleanup (DISCARD ALL as in the pool). This setup is not business mutation. Nested invocation from a write transaction is rejected; do not upgrade/downgrade its mode or wrap commands in ROLLBACK. No autonomous transaction, recovery hook, `FOR UPDATE`, advisory lock, write CTE, SELECT INTO, CALL or arbitrary/user-defined side-effecting function. Read-only mode alone does not prove this: audit every selected function/call path and use the layered tests.

All projection SELECTs name every field; no SELECT *, JSON row dump, command-handler reuse, provider/Git/model/fs execution or lazy initialization. Fixed built-in aggregation/EXISTS/time functions and reviewed RLS settings only. Schema/RLS/index catalog definitions remain unchanged. DAO implementation may require a new pool/repository method but no migration or permission expansion.

Every response has `schemaVersion:"dashboard-read-v1"` and server `fetchedAt` = UTC snapshot/read timestamp from that transaction. It is not row updatedAt or HTTP receipt time. Frontend `receivedAt` is a separate future field; existing Slice0 frontend-envelope fetchedAt terminology must be updated before consuming these responses. Multiple SELECTs in one response use one snapshot. Each next HTTP request gets a new snapshot; no snapshot token spans pages.

Money, tokens and millisecond budget totals are **decimal integer strings**, not floating point/unsafe JS numbers. Task attempt counters may be numbers only when validated safe integers. Source timestamps retain UTC microsecond precision for ordering/cursor anchors; do not round through JS Date milliseconds. UUID IDs use schema-valid canonical representation in new-reader fixtures/contracts; legacy non-UUID in-memory fixtures are not a reason to change existing routes or bypass validation.

Errors use `{error_code, requestId?}` with no raw SQL, filesystem paths, signed cursor body, auth token or other-tenant details. Proposed codes: 400 `ERR_READ_QUERY_INVALID` (bad IDs/limit/filters/malformed cursor); 401 `ERR_UNAUTHORIZED`; 403 `ERR_FORBIDDEN_RLS`; 404 `ERR_READ_RESOURCE_NOT_FOUND`; 409 `ERR_READ_CURSOR_CONTEXT` (well-formed signed cursor wrong scope/filter/limit or expired context); 500 `ERR_READ_PROJECTION_FAILED` (DB/query/numeric/source-integrity fault). Validate queries after auth verification so unauthenticated enumeration does not gain resource information. A cursor/SQL failure never becomes an empty successful page.

## 3. P-B — Project reader (P1)

Routes:

- GET `/api/v1/projects/:projectId`: project detail in the verified project context.
- GET `/api/v1/projects?limit=20&cursor=...`: bounded collection **within the current signed project context**, pending D-01 approval.

DTO allowlist, sourced directly from projects: `{projectId:project_id, slug, name, defaultBranch:default_branch, createdAt:created_at, updatedAt:updated_at}`. No repo_bare_path, approval secret/TTL configuration, memberships, session title, raw ProjectRecord or live Git access. `name` is the actual projects.name string.

Detail response: `{schemaVersion,fetchedAt,project:ProjectReadDto}`. List response: `{schemaVersion,fetchedAt,scope,items:ProjectReadDto[],page:{limit,hasMore,nextCursor}}`. Stable order `(projects.updated_at DESC, projects.project_id DESC)`, default 20/max 100, fetch limit+1 to determine hasMore, and nextCursor only when hasMore. No total count or offset. With current one-project scope, hasMore will normally be false; keep the contract honest rather than broadening rights to fill a list.

Limits accept a single canonical positive decimal integer parameter, 1–100; absent default 20; 0/negative/decimal/NaN/empty/duplicate/over 100 → 400, never clamp. Unknown query keys/filter fields → 400. No all/unlimited mode. A later broader-auth list is a new contract/scope decision, not an implication of default 20.

## 4. P-A — Budget snapshot (P2, independent business-risk gate)

Route: GET `/api/v1/projects/:projectId/budget-snapshot`. No query parameters in v1. Fixed-size **project** scalar snapshot, not the legacy unbounded task-policy/task-usage/event arrays. Task budget details/lists require another explicitly bounded contract.

Response:

```
{schemaVersion,fetchedAt,projectId,
 policy:{status:"ACTIVE"|"AUTO_PAUSED",updatedAt}|null,
 dimensions:{tokens:Dimension,costMicroUsd:Dimension,wallTimeMs:Dimension},
 estimatedModelUsageIncluded:boolean,
 recoveryState:"clear"|"pending"|"unknown",
 recoveryReason:"no-visible-pending-intent"|"visible-pending-intent"|"journal-not-modeled",
 recoveryScope:"visible-project-budget-denial-intents-at-snapshot",
 usageSemantics:"recorded-project-ledgers-and-resource-metrics"}
Dimension = {unit:"tokens"|"micro_usd"|"milliseconds",limitKind:"configured"|"unbounded"|"policy-absent",
             limit:decimalUnsignedString|null,
             consumed:decimalUnsignedString,
             remaining:decimalSignedString|null}
```

Source semantics (same recorded sources as existing budget enforcement, with an independently written SELECT DAO):

| Field | Definition |
|---|---|
| tokens.consumed | SUM(model_call_ledgers.actual_total_tokens) for verified project |
| costMicroUsd.consumed | SUM(model_call_ledgers.actual_cost_micro_usd) for verified project |
| wallTimeMs.consumed | SUM(resource_usage_metrics.wall_time_ms) for verified project; sum of recorded phase/attempt samples, not live elapsed/CPU wall-clock |
| limit | Corresponding max_project_tokens / max_project_cost_micro_usd / max_project_wall_time_ms from project_budget_policies |
| limitKind | Row absent →policy-absent; row present with NULL limit →unbounded; nonnull limit →configured |
| remaining | Configured limit minus consumed, retaining negative overrun exactly; otherwise null. Never clamp or infer zero for absent policy |
| estimatedModelUsageIncluded | EXISTS project model_call_ledgers where usage_estimated=true |
| policy.status / updatedAt | Literal persisted policy state/time, never recomputed/paused by a read |

Sums include all persisted ledger statuses, including nonzero actual usage recorded for failed/blocked calls; exclude estimated_cost_micro_usd/reservations as extra amounts. Do not add cost-session totals, external provider invoices, resource-cost estimates or realtime consumption. Empty authoritative sums are zero, not missing/null source errors. Decimal strings preserve SQL aggregate/bigint precision. Memory mode validates each stored numeric sample before exact integer accumulation; invalid/unsafe stored numbers fail 500 instead of rounding. No claim of complete or live external billing is made.

### recoveryState

The authoritative durable pending source currently present is `budget_denial_intents(project_id,status,outer_xid,...)`, schema0012. Model call BLOCKED_* results are historical completed call records, not a pending-denial queue.

PG executes this logical SELECT in the **same snapshot** as policy/usage, with RLS and an explicit verified project predicate:

```
SELECT EXISTS (
  SELECT 1 FROM budget_denial_intents
  WHERE project_id = :verified_project_id AND status = 'PENDING'
);
```

True →pending, including still-active outer transactions and replay-eligible captured intents. False →clear **only after successful authoritative query**. No pg_xact_status-based exclusion, lock, replay/apply/completion or audit. Completed intents do not make the state pending. Another project's pending intents do not affect the scoped result.

`clear` means no committed visible PENDING intent in that snapshot, not no in-flight/future work and not a release/finality guarantee. Pending/unknown numbers are observed provisional usage; never usable as authorization to dispatch, spend, resume or release a hold.

Existing memory store does not model the independent durable intent journal. Therefore its truthful v1 result is **unknown / journal-not-modeled**, not clear and not an invented empty authoritative queue. Do not initialize a fake journal just to pass parity tests. Tests cover PG clear/pending and memory unknown. A new authoritative memory journal would need a reviewed semantic change. In PG, missing schema/permissions/query failure is 500, not clear and not an unknown response masking an authorization or infrastructure failure.

No new side effects may occur on any success/error/timeout path. GET `/budget` still performs its existing recovery; the new path never calls it or its repository method (even for numbers). No task/event loops, N+1 usage queries or unbounded event arrays in this fixed-size response. Aggregate work is bounded by query timeout and existing indexes/data scale, not magically constant scan cost; failed/over-budget queries fail rather than scan client-side or return partial totals.

## 5. P-C — Session task projection (P3)

Route: GET `/api/v1/projects/:projectId/sessions/:sessionId/tasks?limit=25&status=Ready&cursor=...`. This route is deliberately distinct from existing pipeline-sessions bundle and project task collection. The session ID is the existing product_pipeline_sessions.pipeline_session_id, not an invented session entity.

Authenticate caller/project first, SELECT the session with both verified project ID and supplied session ID, then obtain tasks using an EXISTS task_plan_links predicate for the same project+session+task. Task.project_id is independently constrained. EXISTS prevents duplicate links from duplicating task rows; no session membership inferred from title/creation time or a broad frontend join. Null/missing assignee/lease is allowed and never invented. Inconsistent multiple distinct assignee IDs for one task/session is a 500 source-integrity error, not arbitrary first/last assignment.

Item allowlist proposal: `{taskId,projectId,sessionId,title,sourceStatus,currentAttemptNo,reworkCount,maxReworkCycles,activeLeaseEpoch,assigneeId,leaseOwnerId,leaseExpiresAt,createdAt,updatedAt}`. `sessionId` is the validated session association, not a new Task column. `sourceStatus` is exactly tasks.status. `assigneeId` is task_plan_links.assigned_profile_id (a profile ID, planned association), **not** principal ID or active assignment count. `leaseOwnerId`/`leaseExpiresAt` come only from task.active_lease_id joined to a same-project/same-task/same-epoch lease. Include the stored lease owner/expiry regardless of whether its deadline elapsed; they are historical/source fields, never an online indicator. If active_lease_id is null, both lease fields are null. A nonnull reference with a missing or mismatching scoped lease is a 500 source-integrity failure for the response, never null masking, a cross-project join or lease refresh. activeLeaseEpoch is an unsigned decimal string to preserve its BIGINT precision; attempt/rework counters are validated safe integers. No task_contract_json, worker credentials, profile_snapshot, public_context, Git paths or provider lookups.

List envelope: `{schemaVersion,fetchedAt,projectId,sessionId,filters:{sourceStatuses,stage:null},items,page:{limit,hasMore,nextCursor}}`. Default25/max100; same strict limit rules as P1. Server fetches at most limit+1 rows for page metadata. No fetch-all or offset paging. No full-table frontend filtering/join/pagination substitute.

Status filter: repeat `status` at most 11 times, each an exact source TaskStatus literal; case-sensitive/no whitespace trimming/CSV aliases, unknown or duplicate values → 400. Canonical filter is the sorted unique set (absence means all source statuses). All 11 literals: Ready, Leased, ExecutingInTarget, BuildingMergeCandidate, VerifyingInDocker, UnderIndependentReview, AwaitingHumanApproval, AtomicCasMerge, MergedAndCompleted, ReworkRequired, ManualIntervention. Filtering is applied in SQL before keyset/limit and on the unchanged source status.

**P0 decision D-02:** no authoritative stage field or per-task stage enum exists in TaskRecord/TaskPlanLink. Existing PipelineStageName is only stages1–4 and cannot truthfully filter Stage8 TaskRecords. Proposal: any `stage` query returns 400 as unsupported in v1; no stage field invented, and the required stage-filter feature remains pending a team-approved authoritative definition. Team must resolve/approve this limitation before P3 implementation/acceptance; this document does not pretend the whole P3 stage requirement is met.

### Cursor and consistency contract

Both collections use composite keyset order. For tasks, SQL `(t.updated_at,t.task_id) < (:cursor_updated_at,:cursor_id)` with `ORDER BY t.updated_at DESC,t.task_id DESC`; project list uses `(p.updated_at,p.project_id)`. “id” in the plan is the actual task_id/project_id key, not a new database column. Preserve microseconds, use UUID tuple comparison in PG, and implement the same deterministic ordering in memory. Never use timestamp-only cursor or DISTINCT+unordered limit.

Opaque URL-safe cursor proposal: base64url canonical payload plus HMAC-SHA256, version1, purpose `dashboard-read-cursor-v1`, separate purpose-derived key from operator-owned Core signing material. Payload binds resource kind, verified project/principal scope, validated session ID (task route), normalized filters, limit, last returned timestamp+ID and 15-minute expiry. Max serialized cursor 2048 bytes. The signing key/algorithm are server-owned, never supplied in request parameters. Signature constant-time verification; no raw payload/cursor logging. Revalidate current auth/membership/session on every page; a signed cursor never grants access.

Malformed/oversize/invalid-signature cursor (including one unverifiable after signing-key retirement) → 400. Valid signature but wrong project/session/principal/filter/limit or expired context → 409 with no data and a restart instruction; verify authorization independently before revealing context mismatch. Changing filters/limit restarts paging. nextCursor anchors the last returned item (not the extra probe row); absent when hasMore=false. Timestamp+UUID tie is total; never fabricate totalCount.

**Best-effort traversal of changing data, not snapshot across requests.** Updates moving rows above the cursor can make them disappear from later pages; rows moving below it can reappear. New rows ahead of the cursor are seen on refresh, not guaranteed later. Deletions are allowed. Do not promise exactly-once/all-record pagination or cache a cursor as a release snapshot. Within each response, all items/joined lease fields share one read-only snapshot. Refresh restarts from page1.

## 6. Scale, indexes and implementation gates

No schema/index/view change is authorized. Existing projects/tasks primary keys, tenant-scoped RLS and task_plan_links project/session indexes are available; no dedicated `(project,updated_at,id)` task order index has been introduced. Before P3 acceptance, inspect EXPLAIN and representative concurrent/large fixtures with statement timeout; output row bounds alone are not scan-cost guarantees. If query scale requires a new index or view, stop P3, open a separate owner decision and keep that panel unsupported. Do not silently ship a migration or claim production scale from tiny tests.

`limit+1` bounds projection output. Proposed new-reader bounds: one 5-second whole-operation deadline, at most 1-second pool acquisition, 2-second statement_timeout per SQL statement, 250 ms lock_timeout and 1 MiB serialized JSON response cap. Failed/aborted queries must be cancelled/disposed and their read transaction closed; no leaked connection or pending callback. These bounds apply only to the new projection path, not old endpoints. Test acquisition/query/serialization exhaustion and return a generic500 without partial data; do not truncate source field contents to fit silently. No partial successful page on timeout. Standard HTTP telemetry can remain; no new business audit/outbox/intents may be written by reading.

Review gates: approve P0 contract plus [read-only test matrix](./dashboard-read-only-test-matrix.md) and D-01/D-02 decisions; implement/verify/review P1; then independently implement/verify/review P2; then P3 only after stage/scale issues are resolved. Dashboard activation waits for the relevant implementation ĐẠT. API contracts are not implementation acceptance, and this work does not alter G7/native VM deferral or production Codex policy.
