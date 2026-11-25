# Dashboard bounded cost-session reader — S0 contract

**Status:** Proposed for Kit review. S0 is documentation only. Source baseline `21309ad4819e368e1a3586713f3e66393d64fd6a`. [Issue #25](https://github.com/shmtoan08/SoftwareFactory/issues/25) · [P0 read-only contract](./dashboard-read-projections-p0.md) · [Session reader precedent](./dashboard-session-list-s0.md)

## Route and authoritative association

`GET /api/v1/projects/:projectId/pipeline-sessions/:pipelineSessionId/cost-session-snapshot` accepts canonical UUIDs and no query parameters.

Choose the pipeline-session route because the Dashboard already has that ID from the bounded session list. The server resolves the nullable `product_pipeline_sessions.cost_session_id` in the same snapshot as the cost record. A route keyed by cost-session ID would require another source for that ID, and the existing bundle would bring back the unbounded ledger read this slice removes.

Resolve the exact forward link by joining `model_cost_sessions.cost_session_id` to `product_pipeline_sessions.cost_session_id` and matching the verified project on both sides. The forward link is nullable and protected by a composite FK. The cost record's own `pipeline_session_id` is another nullable FK and is returned verbatim. A shared or differently attributed cost record can be linked to the selected session. The Dashboard may attribute usage to the selected session only when the cost record's own `pipeline_session_id` equals the selected ID. [Forward link](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L32-L54) · [Reverse FK](../../../packages/database/migrations/0007_m6a_review_fixes.sql#L38-L52)

## Authorization and privacy

Use existing transport auth and verify signature, lifetime, project, principal and READ role before resource lookup. READ roles are AUDITOR, DEVELOPER, PROJECT_APPROVER and ORG_ADMIN. Under D-01, every request targets the one project in the signed token. ORG_ADMIN follows that same restriction. Recheck live project membership and signed-role match before reading the project or session. Membership, project, session and cost lookup share one read-only snapshot.

| Condition | HTTP | Result |
|---|---:|---|
| Missing or malformed transport auth | 401 | `ERR_UNAUTHORIZED` |
| Parseable auth fails signature, lifetime or READ role, or current membership is absent or mismatched | 403 | `ERR_FORBIDDEN_RLS` |
| Verified token targets a different project | 403 | Same response whether the foreign project exists or is absent. No foreign resource lookup |
| Invalid path UUID or any query parameter with valid auth and matching project scope | 400 | `ERR_READ_QUERY_INVALID` |
| Authorized lookup finds no project or no session in that project | 404 | `ERR_READ_RESOURCE_NOT_FOUND`. A foreign session ID and an absent session ID are indistinguishable |
| Authorized session row has `cost_session_id IS NULL` | 200 | `costSession: null` |
| Authorized session has a nonnull cost link that the scoped lookup cannot resolve | 404 | Same generic not-found as an absent resource. A foreign cost row and a missing cost row are indistinguishable. The current composite FK rules out both as ordinary committed states |
| Source numeric or status validation fails, transaction/query times out, or response exceeds its cap | 500 | `ERR_READ_PROJECTION_FAILED` |

Errors use `{error_code, requestId?}` without SQL, signed claims, row values or foreign IDs. The route accepts no independent cost-session ID, so callers cannot use a cost ID to query another project's records.

## Exact response

The success envelope is `{schemaVersion: "dashboard-read-v1", fetchedAt, projectId, pipelineSessionId, costSession}`. The two outer IDs are the verified project and authorized selected pipeline session. `fetchedAt` comes from the SELECT establishing the server transaction snapshot. The client records its own `receivedAt` separately.

When the link exists, `costSession` contains exactly these keys and no arrays. All fields below come from `model_cost_sessions`. [Schema](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L8-L28) · [CostSessionRecord](../../../packages/shared-types/src/index.ts#L721-L735)

| Key | JSON type and source meaning |
|---|---|
| `cost_session_id` | Canonical UUID of the linked cost record |
| `pipeline_session_id` | Nullable canonical UUID, the cost record's own pipeline attribution |
| `session_cost_budget_micro_usd` | Nonnegative safe integer, configured cost budget in integer micro-USD |
| `cost_used_micro_usd` | Nonnegative safe integer, stored cost usage in integer micro-USD |
| `tokens_used_total` | Nonnegative safe integer, stored token usage |
| `session_token_budget` | Positive safe integer, configured token budget |
| `status` | Literal `ACTIVE`, `EXHAUSTED` or `CLOSED` from the cost record |

This slice uses JSON safe integers per the existing `CostSessionRecord` and Issue #25's `toSafeInt` rule. Validate nonnull numeric inputs before conversion. Preserve exact PostgreSQL BIGINT text up to the mapper and run each numeric field through the existing `toSafeInt` guard before serialization. Memory values must satisfy the same safe-integer and domain bounds. Values outside range, malformed numbers and invalid statuses fail generically with 500. The legacy mapper and endpoints retain their current behavior. [Projection mapper](../../../packages/database/src/cost-session-read-projection.ts#L54-L74) · [Shared toSafeInt guard](../../../packages/database/src/cost-session-read-projection.ts#L20-L43) · [Legacy mapper](../../../packages/database/src/postgres-pool.ts#L1933-L1955)

Omit an estimated flag. The cost record supplies no such column. The observed `usage_estimated` belongs to individual ledger rows. Provider and model fields also belong to those rows and are outside this projection. Exclude task IDs, per-request caps, raw rows, any ledger-derived aggregate, and remaining/percent calculations. Return stored recorded usage without a provider-billing claim. [Ledger fields](../../../packages/shared-types/src/index.ts#L744-L765)

Maximum successful cardinality is one record or explicit null. Cap serialized UTF-8 JSON at **1 MiB** as in P0–P3. Oversize responses fail before any partial response is sent.

## Read-only implementation constraints for S1

Reuse the existing dedicated read unit: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, `SET LOCAL ROLE app_runtime`, existing RLS project/principal settings, unconditional transaction and connection cleanup. Apply the P0 bounds of one second for pool acquisition, two seconds per statement, 250 ms for locks and five seconds for the whole operation.

After membership and project checks, use a fixed literal parameterized SELECT for the requested pipeline session and its linked cost record. Use explicit project and session predicates, the primary keys and the same-project join. Select only the session's link key and the seven projected cost columns. A left join distinguishes an authorized session with a null link from a missing session and from an unresolved nonnull link. The PKs bound the join to one row. Read only the existing membership, project, pipeline-session and cost-session relations. The query does not touch `model_call_ledgers`, including for EXISTS, counts, inference or joins.

Exclude legacy bundle/get-with-ledgers readers, `SELECT *`, write CTEs, row/advisory locks, provider calls, recovery, audit/outbox writes, autonomous transactions and commit-time callbacks. Preserve existing routes, schema, grants and RLS policies.

## S1 verification plan

Apply [P0 RO-01–RO-12](./dashboard-read-only-test-matrix.md#layered-acceptance-all-slices) in memory where applicable and on PostgreSQL 16 and 17.

- **Contract and bounds.** Assert exact envelope and record keys. Exercise explicit null link, matching attribution, null attribution and different same-project attribution. Seed a large ledger set through fixture writes with the cost record held constant. Compare successful serialized bodies with a fixed snapshot timestamp, or compare exact byte sizes with the same timestamp width. Both before and after must return the same seven fields and values. Capture all SQL and fail if any read touches the ledger relation or calls a legacy reader. Check the size and timeout error paths.
- **Auth and scope.** Exercise every privacy row, all four READ roles, expired/forged credentials, revoked membership, and existing versus absent foreign project/session IDs. Verify equal generic outcomes for unresolved foreign/absent links with fault injection, leaving FK enforcement enabled. Capture effective app_runtime role and repeatable-read/read-only flags. Recheck membership every request. A separate write probe inside the read-only unit must fail with SQLSTATE 25006.
- **Precision.** Assert exact round trips at zero where permitted and at `Number.MAX_SAFE_INTEGER`. Exercise the next integer in PG BIGINT for each numeric field and expect generic 500 without a partial DTO. Cover malformed or unsafe fixture numbers in memory and invalid status. Verify that absence cannot become zero.
- **Regression and purity.** Verify both legacy paths still return their original shapes and ledger sets. The direct cost-session endpoint returns `{session, ledgers}` scoped by cost-session ID. The pipeline bundle returns `costSession` and `modelCallLedgers` scoped by pipeline-session ID. Assert no content or catalog changes attributable to reads, and test unconditional connection cleanup on errors. Required CI is 5/5. [Direct service](../../../packages/product-pipeline/src/pipeline-service.ts#L313-L332) · [Bundle repository](../../../packages/database/src/postgres-pool.ts#L6787-L6814) · [Legacy ledger query](../../../packages/database/src/postgres-pool.ts#L5675-L5695)

S1 begins after Kit reviews S0. Dashboard 2-2b remains gated on S1 review.
