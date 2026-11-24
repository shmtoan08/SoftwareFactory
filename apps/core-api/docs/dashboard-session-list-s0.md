# Dashboard Session list reader — S0 contract

**Status:** Proposed for Kit review. S0 is documentation only. Source baseline `abdd50c54460d888563d12e8adf38bdf3e65886c`. The [Issue #24 decision](https://github.com/shmtoan08/SoftwareFactory/issues/24#issuecomment-7123294786) defines the scope. The [P0 contract](./dashboard-read-projections-p0.md) and [P0 verification matrix](./dashboard-read-only-test-matrix.md) supply the read-only and privacy conventions.

## Route and authorization

`GET /api/v1/projects/:projectId/sessions` accepts one canonical UUID project ID and the optional query keys `limit` and `cursor`, at most once each. The default limit is 20 and the maximum is 100. An explicit limit must be a canonical positive decimal integer from 1 to 100. All other query keys return 400, including `stage` under D-02. D-01 restricts every request to one signed project.

Verify the existing Core auth signature and lifetime before trusting the signed principal, project or roles. Check exact signed project scope and the allowed READ roles (AUDITOR, DEVELOPER, PROJECT_APPROVER, ORG_ADMIN). Recheck live membership and signed-role match before project lookup and cursor-context disclosure. Membership, project existence and session rows are read within the same transaction snapshot. Apply these checks to every page. ORG_ADMIN follows the same scope rule.

| Condition | HTTP | Response and privacy |
|---|---|---|
| Missing or malformed transport auth | 401 | `ERR_UNAUTHORIZED` |
| Parseable auth fails signature, lifetime or allowed-role verification | 403 | `ERR_FORBIDDEN_RLS` |
| Valid token targets another project, including with ORG_ADMIN | 403 | Same response for existing and absent foreign project IDs. Perform no foreign existence lookup |
| Membership absent or role mismatched | 403 | Same forbidden envelope. No project/session data or counts |
| Malformed project ID or unsupported, duplicate or invalid query key/value | 400 | `ERR_READ_QUERY_INVALID`. Includes empty, zero, negative, fractional and over-100 limits |
| Authorized project absent after access checks | 404 | `ERR_READ_RESOURCE_NOT_FOUND` |
| Malformed, oversized or unverifiable cursor, including bad signature or another reader's cursor | 400 | `ERR_READ_QUERY_INVALID` |
| Authentic session cursor expired or bound to a different project, principal or limit | 409 | `ERR_READ_CURSOR_CONTEXT` after authorization. Restart without a cursor |
| Authorized existing project has no sessions, or the cursor reaches the end | 200 | `items: []`, `hasMore: false`, `nextCursor: null` |
| Repository, timeout, integrity, size or serialization failure | 500 | `ERR_READ_PROJECTION_FAILED`. No partial page |

Errors use the generic P0 envelope `{error_code, requestId?}`. Keep raw SQL, cursor bodies, tokens and resource lookup details out of responses.

## Response and DTO allowlist

The exact success envelope is `{schemaVersion, fetchedAt, projectId, items, page}`, with `schemaVersion: "dashboard-read-v1"`, the verified `projectId`, and `page: {limit, hasMore, nextCursor}`. `fetchedAt` comes from the SELECT establishing the server transaction snapshot. A Dashboard client can record its own `receivedAt` separately.

| Item field | Type and meaning | Schema and reader source at baseline |
|---|---|---|
| `pipelineSessionId` | Canonical UUID, session identity | `pipeline_session_id` [DDL L33](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L33), [row mapper L2015](../../../packages/database/src/postgres-pool.ts#L2015) |
| `projectId` | Canonical UUID, equals the authorized project | `project_id` [DDL L34](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L34), [row mapper L2016](../../../packages/database/src/postgres-pool.ts#L2016) |
| `title` | Stored session title, display text | `title` [DDL L36](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L36), [row mapper L2018](../../../packages/database/src/postgres-pool.ts#L2018) |
| `createdAt` | Stored creation time in UTC with six fractional digits | `created_at` [DDL L49](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L49), [row mapper L2024](../../../packages/database/src/postgres-pool.ts#L2024) |
| `updatedAt` | Stored update time in UTC with six fractional digits | `updated_at` [DDL L50](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L50), [row mapper L2025](../../../packages/database/src/postgres-pool.ts#L2025) |

The five item keys are exhaustive. Exclude pipeline or session status, summaries, current stage and stage history, task counts, `totalCount`, raw idea text, creator principal IDs, cost session IDs, baseline IDs, approval/artifact data, and raw records. `updatedAt` is display metadata and does not participate in ordering. The reader supplies session candidates. It provides no evidence for ACTIVE selection or Pipeline Progress.

## Keyset and schema gate

**S0 source gate passes.** The [table definition](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L32-L54) defines `created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()` and a nonnull, globally unique `pipeline_session_id UUID PRIMARY KEY`. Timestamp ties resolve by UUID, so the tuple is a strict total order. The [insert](../../../packages/database/src/postgres-pool.ts#L6179-L6201) takes the schema's timestamp default. The [runtime column grants](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L578-L580) exclude updates to both key columns, and the [cost-link](../../../packages/database/src/postgres-pool.ts#L6224-L6236), [stage advance](../../../packages/database/src/postgres-pool.ts#L6493-L6498) and [freeze](../../../packages/database/src/postgres-pool.ts#L6709-L6716) writes leave them intact. This stability claim covers supported runtime writes. It does not assert that an administrative rewrite is impossible.

Use an explicit verified `project_id = $projectId` predicate under RLS. Order by `created_at DESC, pipeline_session_id DESC`. With an anchor, add a strict tuple comparison `(created_at, pipeline_session_id) < (:createdAt, :pipelineSessionId)` using native TIMESTAMPTZ and UUID comparison with typed parameters. Preserve microseconds without a JavaScript Date round trip. Fetch at most `limit + 1` rows, emit at most `limit`, and anchor the opaque next cursor to the last emitted row when there is a probe row. Return `null` otherwise. Memory uses the same ordering and exclusive boundary. Requests have independent snapshots. Concurrent inserts ahead of an anchor are visible on a fresh traversal, and pagination does not hold a cross-request snapshot.

Use canonical base64url encoding and HMAC-SHA256 with a dedicated purpose-derived key `dashboard-session-list-cursor-v1` from existing operator-owned signing material. Sign a versioned payload binding resource kind, verified project, principal, effective limit, the complete anchor and a 15-minute expiry. Follow the P0 cap of 2048 serialized bytes and constant-time signature verification. Reject P1 and P3 tokens here and session-list tokens at P1/P3 through purpose isolation. After authorization, distinguish a valid session cursor with mismatched context or expiry (409) from invalid encoding, shape or signature (400). A cursor grants no access.

No schema change is required for keyset correctness. The [existing index](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L56-L57) is `(project_id, status, created_at)` and does not directly match the full tuple order for an unfiltered project. Measure the actual RLS query plan on PostgreSQL with representative project sizes and existing indexes. If the agreed bounds cannot be met without schema/index changes, stop and return the evidence for a separate decision.

## Reader prerequisite and read-only boundary

The current internal reader supplies all five source fields. Its [service wrapper](../../../packages/product-pipeline/src/pipeline-service.ts#L390-L401) uses the legacy RLS transaction. The [PostgreSQL list](../../../packages/database/src/postgres-pool.ts#L6217-L6222) uses unbounded `SELECT *`, RLS-based scope and ascending timestamp-only order. The [memory list](../../../packages/database/src/index.ts#L4234-L4246) scans and returns all scoped session records. Neither implements the required bounded project keyset.

**Separate prerequisite before S1.** Implement and review a dedicated bounded session source projection for PostgreSQL and memory, independently of S1's HTTP wiring. Preserve legacy readers and P1–P3. Review the DTO columns, explicit project predicate, typed cursor boundary, exact timestamp handling and query plan in the prerequisite. The existing [read-only pool helper](../../../packages/database/src/postgres-pool.ts#L1471) is the starting point for transaction reuse.

Use an independent `REPEATABLE READ READ ONLY` transaction with `SET LOCAL ROLE app_runtime` and existing RLS context. Allow only literal parameterized SELECTs for membership, project and the bounded projection with explicit named columns. Apply P0 resource bounds (2 s statement, 250 ms lock, 1 s acquisition, 5 s overall and 1 MiB serialized response) and unconditional pool/session cleanup on success and failure. Exclude read-write transaction reuse, locks in queries, callbacks, lease actions, scheduler, recovery, audit/outbox writes, and Git/provider execution.

## Verification plan

Apply all [P0 checks RO-01–RO-12](./dashboard-read-only-test-matrix.md#layered-acceptance-all-slices) to the new projection and HTTP path.

| Layer | Required acceptance evidence |
|---|---|
| Source and memory | Assert exact item and envelope keys, scope and source values. Use schema-valid fixtures across two projects, timestamp ties and adjacent microseconds. Compare all pages against the sorted fixture and verify source objects remain unchanged if DTOs are mutated |
| HTTP and cursor | Exercise every error/privacy row, four READ roles and membership changes between pages. Cover first/default/max pages, overflow, empty project, exhausted page, duplicate keys, stage/unknown query, foreign rows, forged or oversized cursor, authentic expiry/context mismatch, and P1/P3 cursor rejection in both directions |
| PostgreSQL enforcement | Run on PostgreSQL 16 and 17 under actual app_runtime/FORCE RLS. Capture transaction flags, role, project and SQL allowlist. In a separate test unit prove UPDATE fails with 25006. Run real tie/microsecond traversal and concurrent session metadata edits, inserts and membership revocation. Inspect EXPLAIN with existing indexes |
| Side effects and cleanup | Compare deterministic full source and sensitive table contents, including leases, replay-eligible intents, policies, audit and outbox. Compare catalog, grants and policies. Trap legacy/side-effect callbacks. Inject acquire, lock, statement, deadline and serialization failures, then verify generic errors, connection cleanup and successful reuse without stale scope |
| Regression and gates | Existing console, legacy reader and P1–P3 regression tests pass. Required CI 5/5, including both PostgreSQL jobs with no required test skips. Kit reviews S0, the separate reader prerequisite, then S1 before S2 updates the Data Mapping Spec |

S0 validates the source definition and runtime write paths by inspection. Query performance and runtime read-only verification remain future acceptance evidence.
