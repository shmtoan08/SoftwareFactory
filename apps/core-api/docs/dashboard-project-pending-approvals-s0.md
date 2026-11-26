# Project pending approvals reader — S0 contract

Status — proposed contract for Kit review. Decision source is [Issue #38](https://github.com/shmtoan08/SoftwareFactory/issues/38) (Claude, chat `40b01e8f`). Schema and writer baseline is `f38ca784ad32f6672d856788899942a280eeac18`.

## Route and authorization

`GET /api/v1/projects/:projectId/pending-approvals` accepts a canonical lowercase project UUID and returns one list across its sessions. Query keys are `limit` (canonical decimal 1–100, default 20) and opaque `cursor`, each at most once. D-02 rejects `stage` with 400. V1 also rejects `kind`, every other filter, unknown parameters, and duplicate keys with 400.

D-01 requires a verified signed project token. `READ_ROLES` is exactly `AUDITOR`, `DEVELOPER`, `PROJECT_APPROVER`, and `ORG_ADMIN`. Verify transport, signature, lifetime, signed role, and equality of the token project with the route project before lookup. Reject a different project with the same 403 regardless of its existence. In the read transaction, verify current project membership matches an allowed signed role before resolving project visibility or reporting cursor context. Recheck authorization on every page.

Use the P0 read unit with `REPEATABLE READ READ ONLY`, `SET LOCAL ROLE app_runtime`, transaction-local project/principal settings and RLS. Every branch has an explicit parameterized project predicate alongside RLS. Use fixed SELECT projections with unconditional transaction cleanup and P0 budgets (1 s acquisition, 2 s statement, 250 ms lock, 5 s total). [Read roles](../src/index.ts#L189-L194) · [Membership role check](../../../packages/database/src/project-read-projection.ts#L12-L14) · [Timeline read precedent](dashboard-timeline-event-reader-s0.md)

## Sources and exact DTO

Success has exactly `{schemaVersion:"pending-approvals-v1", fetchedAt, scope:{kind:"project-token",projectId}, items, page:{limit,hasMore,nextCursor}}`. `fetchedAt` is the server's DB snapshot time. Each item is a flat object containing `kind` plus exactly the listed fields. IDs are source UUIDs, timestamps are finite UTC strings preserving six fractional digits, and `hash` is the stored lowercase 64-digit SHA-256. A corrupt projected value fails the whole page. Identity is kind plus the corresponding source ID.

| Item kind | Source and eligibility | Exact fields in addition to `kind` |
| --- | --- | --- |
| `CHANGE_REQUEST` | `change_requests.status = 'PENDING_APPROVAL'` | `cr_id`, `pipeline_session_id`, `baseline_id`, `cr_key`, `hash` (from `cr_sha256`), `title`, `status` (literal `PENDING_APPROVAL`), `created_at` |
| `MERGE_APPROVAL` | `approval_requests.status = 'PENDING'` and `expires_at > DB now()` | `approval_request_id`, `task_id`, `merge_candidate_id`, `status` (literal `PENDING`), `created_at`, `expires_at` |

The allowlist excludes rationale, JSONB, principals, review artifacts, task details, and all other fields. The merge branch reads its task ID directly, without a task join. Stage gates are excluded because each gate row is a recorded decision and there is no source of gate requirements. A missing decision cannot produce a pending gate. `tasks.AwaitingHumanApproval` is excluded as derived workflow state duplicating the merge-approval source. Emit pending items only for eligible stored records. An authorized empty result means no eligible records were returned at this snapshot. The UI must avoid presenting that result as “no work exists.” [CR schema](../../../packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql#L168-L227) · [Merge approval schema](../../../packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql#L107-L156) · [Gate decision schema](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L183-L200)

## Approval request TTL and cursor TTL

Capture PostgreSQL `now()` once per request within the read transaction. Use this value for `fetchedAt` and every merge-approval TTL comparison while filling the page. Filter in the reader application layer. Omit a stored `PENDING` request when `expires_at <= now()`, including exact equality. The writer already rejects expired approvals with 409. An expired request can remain `PENDING` in storage because expiration is handled lazily by approval or merge reconciliation paths and there is no expiry sweeper. The list hides expired rows without mutating their status.

The cursor's independent 15-minute lifetime starts when the cursor is issued. It neither extends the approval request's TTL nor freezes eligibility on a later page. Each page samples DB time again. [Memory expiry paths](../../../packages/database/src/index.ts#L3039-L3055) · [Memory merge reconciliation](../../../packages/database/src/index.ts#L3374-L3389) · [PostgreSQL approval expiry](../../../packages/database/src/postgres-pool.ts#L5054-L5070) · [HTTP conflict mapping](../src/http-server.ts#L388-L395)

## Ordering and continuation

Order both sources together by `created_at DESC, kind_rank ASC, id DESC`. `CHANGE_REQUEST` has rank 0 and ID `cr_id`. `MERGE_APPROVAL` has rank 1 and ID `approval_request_id`. Compare timestamps at DB microsecond precision and IDs in PostgreSQL UUID order. Both source timestamps are `TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()` and each ID is the source PK. Rank distinguishes sources even when timestamp and UUID match. The PostgreSQL insert paths use the timestamp defaults. [Approval insert](../../../packages/database/src/postgres-pool.ts#L4839-L4849) · [CR insert](../../../packages/database/src/postgres-pool.ts#L7394-L7404)

Use the last returned eligible item as the cursor boundary `(ts_b, rank_b, id_b)`. An older timestamp comes after the boundary for either rank. At the same timestamp, a larger rank comes after the boundary for any ID. At equal timestamp and rank, only smaller IDs come after it. A smaller rank at the boundary timestamp comes before it. For a fixed dataset and fixed eligibility this yields a gap-free, duplicate-free walk. Every request sees its own snapshot. Updates, new records, and TTL expiry can change the lists between requests.

Apply the TTL rule before looking ahead. Fetch ordered source candidates in chunks of at most `limit + 1`. If a merge-approval chunk contains expired candidates, advance the reader's internal source position and continue within the read budget until it has sufficient eligible lookahead or proves exhaustion. Internal positions never become client cursors. `hasMore` is true exactly when an eligible lookahead item exists. Return a cursor only in that case. Budget exhaustion yields the projection error. An expired-only chunk alone does not prove exhaustion.

The opaque versioned cursor uses HMAC-SHA256 with independent purpose `pending-approvals`, constant-time signature comparison, a 15-minute TTL and a maximum of 2,048 encoded bytes. Sign the full boundary and bind it to project, principal, and effective limit. Timeline and other reader cursors are rejected. Invalid encoding, size, purpose or signature is a 400. A valid cursor with expired lifetime or mismatched context is a 409. Neither case restarts pagination.

## Errors and response cap

Measure the final serialized UTF-8 success body before sending headers. Exactly 1 MiB is allowed. Above 1,048,576 bytes fail with 500 and emit no success bytes. Use the Timeline S1-b generic error envelope `{error_code}`, with optional request ID and without resource details. Return a successful empty page for an authorized visible project with no eligible items.

| Condition | HTTP and code |
| --- | --- |
| Missing or malformed authentication transport | 401 `ERR_UNAUTHORIZED` |
| Unverified or expired claims, role/membership denied, missing project, or signed project mismatch | 403 `ERR_FORBIDDEN_RLS` |
| Invalid route UUID, invalid limit, unsupported or duplicate query key, or invalid cursor format/size/purpose/signature | 400 `ERR_READ_QUERY_INVALID` |
| Valid cursor expired or bound to a different project, principal, or effective limit | 409 `ERR_READ_CURSOR_CONTEXT` |
| Read, timeout, data validation, or response cap failure | 500 `ERR_READ_PROJECTION_FAILED` |

A same-project token for a nonexistent project fails the membership check and receives the same 403 as a token without membership in an existing project. This route has no child resource, so there is no resource-visibility 404. [Issue #38 decision](https://github.com/shmtoan08/SoftwareFactory/issues/38#issuecomment-7184225121)

## Response examples

An interleaved list. The first CR precedes the merge approval at equal `created_at`.

```json
{
  "schemaVersion": "pending-approvals-v1",
  "fetchedAt": "2026-11-26T10:00:00.000000Z",
  "scope": {"kind": "project-token", "projectId": "10000000-0000-0000-0000-000000000001"},
  "items": [
    {"kind": "CHANGE_REQUEST", "cr_id": "40000000-0000-0000-0000-000000000002", "pipeline_session_id": "20000000-0000-0000-0000-000000000001", "baseline_id": "30000000-0000-0000-0000-000000000001", "cr_key": "CR-2", "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "title": "Update requirements", "status": "PENDING_APPROVAL", "created_at": "2026-11-26T09:00:00.000000Z"},
    {"kind": "MERGE_APPROVAL", "approval_request_id": "50000000-0000-0000-0000-000000000001", "task_id": "60000000-0000-0000-0000-000000000001", "merge_candidate_id": "70000000-0000-0000-0000-000000000001", "status": "PENDING", "created_at": "2026-11-26T09:00:00.000000Z", "expires_at": "2026-11-26T11:00:00.000000Z"},
    {"kind": "CHANGE_REQUEST", "cr_id": "40000000-0000-0000-0000-000000000001", "pipeline_session_id": "20000000-0000-0000-0000-000000000001", "baseline_id": "30000000-0000-0000-0000-000000000001", "cr_key": "CR-1", "hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "title": "Clarify requirements", "status": "PENDING_APPROVAL", "created_at": "2026-11-26T08:00:00.000000Z"}
  ],
  "page": {"limit": 20, "hasMore": false, "nextCursor": null}
}
```

A visible project with no pending records.

```json
{
  "schemaVersion": "pending-approvals-v1",
  "fetchedAt": "2026-11-26T10:00:00.000000Z",
  "scope": {"kind": "project-token", "projectId": "10000000-0000-0000-0000-000000000002"},
  "items": [],
  "page": {"limit": 20, "hasMore": false, "nextCursor": null}
}
```

A separate project has one stored merge request with status `PENDING` and `expires_at = 2026-11-26T10:00:00.000000Z`. The snapshot time equals its expiry, so the response omits it while the stored row stays `PENDING`.

```json
{
  "schemaVersion": "pending-approvals-v1",
  "fetchedAt": "2026-11-26T10:00:00.000000Z",
  "scope": {"kind": "project-token", "projectId": "10000000-0000-0000-0000-000000000003"},
  "items": [],
  "page": {"limit": 20, "hasMore": false, "nextCursor": null}
}
```

## Verification for later steps

S1 verifies the two project-ordered partial indexes from the evidence probe, scoped reads with and without RLS in tests, timestamp ties, and application-layer TTL behavior. The raw PENDING scan evidence applies to Q2a. The SQL TTL variant Q2b did not benefit in the fixture and supplies no work-bound guarantee for filtering expired runs. If real data shows tens of thousands of stale PENDING rows, pause and report before advancing. [EXPLAIN evidence](project-pending-probe/README.md)

S2 verifies the error matrix, role and project isolation, malformed and cross-purpose cursors, expired and mismatched cursor context, interleaved keyset pages, forbidden filters, exact DTO fields, and the byte cap. If the merged cursor cannot be implemented as specified, pause for a design decision. The existing session reader and Slice B are regression targets.
