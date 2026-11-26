# Dashboard timeline event reader S0

Status **Proposed for Kit review**. Baseline `a86435904da35a779748cd9e8a413bdbb5f3c6a0`. [Issue #32](https://github.com/shmtoan08/SoftwareFactory/issues/32) · [Approved D-01/D-02 and P0](dashboard-read-projections-p0.md) · [Read-only test matrix](dashboard-read-only-test-matrix.md)

The proposed scope is one selected pipeline session within one signed project. The supported rows are discrete milestones with persisted timestamps and stable source keys. The feed is partial and its order means recorded-time order, with no guarantee of causality or commit order. S1 requires Kit's review and a separate decision from Claude.

## Source audit

“Use” is limited to the named milestones in the response allowlist. Line references are to the baseline above. Timestamps listed as optional yield a milestone only when present under the source constraints.

| Source and recorded keys | Verdict and evidence |
| --- | --- |
| `product_pipeline_sessions` — `pipeline_session_id` UUID PK, `project_id`, `created_at` nonnull, mutable `current_stage`, `status`, `updated_at` | **Use** creation only. **Needs change** for general stage/status transitions. The insert records creation. Stage advance, freeze, and even a cost-reference update can write `updated_at`. Earlier states cannot be reconstructed from that row. [DDL](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L32-L54) · [Create](../../../packages/database/src/postgres-pool.ts#L6210-L6245) · [Cost link](../../../packages/database/src/postgres-pool.ts#L6261-L6282) · [Advance](../../../packages/database/src/postgres-pool.ts#L6529-L6542) |
| `stage_artifacts` — `artifact_id` UUID PK, `project_id`, `pipeline_session_id`, `created_at` nonnull | **Use** recorded artifact creation. INSERT writes a distinct version record. Runtime grants are SELECT/INSERT only. Artifact content is outside the feed. [DDL and indexes](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L137-L180) · [Insert](../../../packages/database/src/postgres-pool.ts#L6498-L6530) · [Grants](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L554-L576) |
| `stage_approval_gates` — `gate_id` UUID PK, `project_id`, `pipeline_session_id`, `decided_at` nonnull | **Use** recorded decisions. Each insert stores a decision and exact target artifact ID/SHA-256. No pending gate is inferred. [DDL](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L183-L215) · [Core API](../../../apps/core-api/src/index.ts#L2783-L2805) · [Insert](../../../packages/database/src/postgres-pool.ts#L6596-L6622) |
| `baseline_spec_freezes` — `baseline_id` UUID PK, `project_id`, `pipeline_session_id`, `frozen_at` nonnull | **Use** baseline freeze. The immutable insert and the pipeline's `FROZEN` update share a transaction. Emit one milestone for the freeze. [DDL](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L217-L270) · [Write](../../../packages/database/src/postgres-pool.ts#L6713-L6768) |
| `change_requests` — `cr_id` UUID PK, `project_id`, `pipeline_session_id`, `created_at` nonnull, nullable `decided_at` and `applied_at` | **Use** submitted, decided and applied as distinct milestone types. The decision write locks the row and requires pending, and apply requires approved and preserves `decided_at`. Scope is bound to the baseline. Generic `updated_at` is excluded. The decision timestamp records when the decision happened, independently of current status. Timestamp columns are writable by the service role, so stability is based on the verified write paths, not a DB immutability constraint. S1 must verify memory parity and all live write paths before use. [DDL and checks](../../../packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql#L168-L231) · [Submit](../../../packages/database/src/postgres-pool.ts#L7356-L7396) · [Decide](../../../packages/database/src/postgres-pool.ts#L7435-L7491) · [Apply](../../../packages/database/src/postgres-pool.ts#L7530-L7623) · [Core API](../../../apps/core-api/src/index.ts#L2940-L2999) |
| `task_leases` — `lease_id` UUID PK, `task_id`, `project_id`, `leased_at` nonnull, nullable `revoked_at`/`completed_at`, mutable `expires_at` and `last_heartbeat_at` | **Exclude** from this session feed. It has stable row identity and some recorded milestones, with task/project association only. Expiry deadline changes on heartbeat and EXPIRED writes can set only status. A trustworthy expiration milestone **needs change** if ever required. Task-to-session attribution needs separate review even for grant/revoke. [DDL](../../../packages/database/migrations/0001_mvp_core_schema_and_rls.sql#L101-L127) · [Grant write](../../../packages/database/src/postgres-pool.ts#L3001-L3038) · [Worker updates](../../../packages/database/src/postgres-pool.ts#L3296-L3376) · [Revoke](../../../packages/database/src/postgres-pool.ts#L3490-L3520) · [Expire](../../../packages/database/src/postgres-pool.ts#L3997-L4027) · [Task-plan links](../../../packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql#L233-L277) |
| `approval_decisions` — `approval_id` UUID PK, `approved_at` nonnull, task/candidate binding | **Exclude** merge/task decisions. This is a different approval workflow, with no direct pipeline-session binding. Expiry and consumption fields are not gate decisions. [DDL](../../../packages/database/migrations/0001_mvp_core_schema_and_rls.sql#L252-L280) · [Insert](../../../packages/database/src/postgres-pool.ts#L5052-L5085) |
| `processed_worker_events` — `event_id` UUID PK, `processed_at` nonnull, unique `(lease_id, sequence_no)` | **Exclude** worker events. The DB keys order processing, and sequence is lease-local. These are optional future R1 task/lease sources, with payload and visibility outside this contract. [DDL](../../../packages/database/migrations/0001_mvp_core_schema_and_rls.sql#L129-L147) · [Insert](../../../packages/database/src/postgres-pool.ts#L3295-L3319) |
| `outbox_events` — `outbox_id` UUID PK, `created_at` nonnull, `aggregate_type`, `aggregate_id`, `event_type`, nullable `published_at` | **Exclude** outbox. The writers emit freeze, change-request and lease notifications, with heterogeneous aggregate scope. The supported domain milestones already have authoritative row sources. Publication time concerns delivery, and the table has a broad runtime UPDATE grant. Do not expose payloads or use outbox rows as a completeness guarantee. [DDL, policies and grants](../../../packages/database/migrations/0001_mvp_core_schema_and_rls.sql#L481-L531) · [DDL keys](../../../packages/database/migrations/0001_mvp_core_schema_and_rls.sql#L292-L301) · [Writer](../../../packages/database/src/postgres-pool.ts#L2597-L2611) |
| `audit_logs` — `audit_id` UUID PK, `created_at` nonnull, project/action/target | **Exclude**. The schema and grants provide keys but the audited repo paths establish no production writer or session coverage for these workflows. The content or coverage of any external deployment writers is unknown. [DDL](../../../packages/database/migrations/0001_mvp_core_schema_and_rls.sql#L303-L313) · [Policy](../../../packages/database/migrations/0001_mvp_core_schema_and_rls.sql#L509-L530) |
| `budget_pause_events` — `event_id` UUID PK, `created_at` nonnull, project and optional task | **Exclude** project/task budget policy events, which lack direct session scope. [DDL](../../../packages/database/migrations/0009_m6c_parallel_scheduler_cas_queue_and_budgets.sql#L238-L265) · [Writer](../../../packages/database/src/postgres-pool.ts#L8000-L8030) |
| Telemetry lifecycle and dispatch events — `telemetry.lifecycle_events`, `telemetry.dispatch_events`; `observed_at` and `recorded_at` nonnull respectively, with project/stream identity and unique sequence | **Exclude** Issue #23 telemetry. Stream keys and recorded times describe execution lifecycle or dispatch, with separate authority and visibility. [Lifecycle DDL](../../../packages/database/migrations/0019_t1_lifecycle_storage.sql#L39-L65) · [Dispatch DDL](../../../packages/database/migrations/0028_t1_dispatch_storage.sql#L56-L78) |
| `release_acceptance_packages` — `release_id` UUID PK and `accepted_at` nonnull with direct session binding | **Exclude** release lifecycle from this allowlist. It has orderable evidence, but approval of release scope and payloads is separate. [DDL](../../../packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql#L281-L310) · [Writer](../../../packages/database/src/postgres-pool.ts#L7782-L7824) |
| `production_deployment_approvals` and `production_reconciliation_approvals` — `approval_id` and `reconciliation_approval_id` UUID PKs, `issued_at` nonnull | **Exclude** deployment and reconciliation approval workflows. Their timestamps and IDs are orderable, but the latter's scope is via deployment linkage and both carry sensitive authorization bindings. [Deployment DDL](../../../packages/database/migrations/0014_m6c3_production_deployment_gate.sql#L3-L19) · [Reconciliation DDL](../../../packages/database/migrations/0015_m6c3_deployment_reconciliation.sql#L4-L19) · [Writers](../../../packages/database/src/postgres-pool.ts#L7677-L7717) |

Cost usage counter snapshots and other workflow resources are outside the allowlist. This contract does not convert generic last-update times or present state into events.

## Proposed HTTP contract

`GET /api/v1/projects/:projectId/pipeline-sessions/:pipelineSessionId/timeline` accepts canonical lowercase UUIDs. The only query keys are `limit` (canonical decimal 1–100; default 20) and `cursor`, each at most once. Any filter, including `stage` under D-02, is unsupported. There is no project-wide or multi-session route in this proposal.

Success is exactly `{schemaVersion:"timeline-v1", fetchedAt, scope:{kind:"project-token",projectId,pipelineSessionId}, items, page:{limit,hasMore,nextCursor}}`. `fetchedAt` is server snapshot time for that page. The items are exactly `{type, recordedAt, resourceId, details}`. `resourceId` is the source UUID. Identity within scope is `(type, resourceId)` and represents a resource milestone, not a synthetic event ID.

| Type (fixed rank) | Timestamp and ID | Exact details keys |
| --- | --- | --- |
| `session.created` (1) | `created_at`, `pipeline_session_id` | Empty object |
| `artifact.recorded` (2) | `created_at`, `artifact_id` | `artifactSha256` from `artifact_sha256` |
| `gate.decided` (3) | `decided_at`, `gate_id` | `decision` (stored APPROVED/REJECTED/REQUEST_CHANGES), `targetArtifactId` and `targetArtifactSha256` from the gate FK fields |
| `baseline.frozen` (4) | `frozen_at`, `baseline_id` | Empty object |
| `change-request.submitted` (5) | `created_at`, `cr_id` | Empty object |
| `change-request.decided` (6) | Present `decided_at`, `cr_id` | Empty object |
| `change-request.applied` (7) | Present `applied_at`, `cr_id` | Empty object |

S1-a deferred applied until the memory timestamp was aligned with PostgreSQL and an ordered scan met the work bound. Both prerequisites are complete. The applied branch uses a literal `applied_at IS NOT NULL` with the two-stage boundary below and the partial index from 0033. [Issue #33](https://github.com/shmtoan08/SoftwareFactory/issues/33) · [Issue #36](https://github.com/shmtoan08/SoftwareFactory/issues/36)

Return finite UTC timestamps at six fractional digits and preserve database microseconds through the cursor. Validate all projected values and reject invalid source data. Payloads do not include actor identifiers, free text, rationale, raw content/JSON, workspaces, tokens, provider metadata, task IDs, or ledger data.

Use descending tuple `(recorded_at, type_rank, resource_id)` using PostgreSQL timestamptz, integer, and native UUID order. Rank separates distinct milestones with the same row ID and timestamp. Within rank, the source PK resolves ties. Use the last returned item as the global boundary `(ts_b, rank_b, id_b)`. Each branch constrains project and session and orders by its timestamp and UUID descending. For a branch below the boundary rank use `ts <= ts_b`, and for a branch above it use `ts < ts_b`. At equal rank issue two separately bounded SELECTs in order, first `ts = ts_b AND id < id_b`, then `ts < ts_b`. Each SELECT uses `limit + 1`. The two phases are disjoint and at most 202 rows enter a branch merge at the maximum limit. Merge the branch results in the original global order and apply `limit + 1` lookahead. Row comparison in SQL is excluded from the boundary predicate. Return a nonnull cursor only when another row was seen. This yields gap-free, duplicate-free traversal of a fixed dataset. Each request sees a fresh snapshot, so commits between requests may add rows behind the boundary or leave newer rows for a fresh first page. There is no cross-request snapshot guarantee or total count.

Use a versioned HMAC-SHA256 cursor with an independent timeline-purpose signing context, a 15-minute expiry, and bindings to project, session, principal and effective limit. Include the exact boundary tuple. Reject oversized cursor strings (over 2,048 ASCII characters) and invalid transport or signatures. Reject cross-reader tokens, and use constant-time signature comparison. Check current membership on every page. Never emit a partial success body when its serialized UTF-8 JSON exceeds 1 MiB.

| Result | HTTP / code |
| --- | --- |
| Missing/malformed auth transport | 401 `ERR_UNAUTHORIZED` |
| Bad verified claims, expired auth, denied role/membership or foreign project path | 403 `ERR_FORBIDDEN_RLS` |
| Invalid IDs, unsupported/duplicate query keys, invalid limit or malformed/oversized/unverifiable cursor | 400 `ERR_READ_QUERY_INVALID` |
| Valid timeline cursor expired or bound to another context | 409 `ERR_READ_CURSOR_CONTEXT` |
| Authorized scope without visible project or session | 404 `ERR_READ_RESOURCE_NOT_FOUND`; a foreign session ID and an absent ID are indistinguishable |
| Valid page with no remaining rows | 200 with empty `items`, `hasMore:false`, `nextCursor:null` |
| Read/timeout/validation failure or oversize body | 500 `ERR_READ_PROJECTION_FAILED` |

Errors expose only the generic code and optional request ID. Verify transport, signature, signed project and role before lookup. Reject a mismatched project without probing its existence. Check current membership before project/session visibility or cursor context can disclose resource information.

## Read path, schema and S1 evidence

Use the existing P0 read unit with `REPEATABLE READ READ ONLY`, `SET LOCAL ROLE app_runtime`, project/principal RLS settings, and unconditional cleanup. Require AUDITOR, DEVELOPER, PROJECT_APPROVER, or ORG_ADMIN and verify the signed role matches live project membership in the same transaction. Use fixed parameterized SELECTs with explicit project and session predicates in **every** branch. Do not broaden grants, bypass RLS, or call legacy recovery/relay paths. P0 budgets apply (1 second pool acquisition, 2 seconds per statement, 250 ms lock timeout and 5 seconds total). [Reader precedent](../../../packages/database/src/postgres-pool.ts#L2512-L2539) · [Pipeline table RLS/grants](../../../packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql#L488-L576) · [CR RLS/grants](../../../packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql#L493-L594)

The proposed allowlist has the necessary columns, keys and SELECT policies. It needs no schema or RLS migration for correctness. The existing indexes include stage or creation-oriented keys and do not establish bounded work at scale for every branch. S1 must use per-branch keyset and `limit + 1` before the bounded merge, then prove plans and latency with real `EXPLAIN (ANALYZE, BUFFERS)` under app_runtime RLS on PG16/17. See the scale probe below for the observed index gap. If needed, pause for separate approval and coordinate numbering with telemetry E1 (Issue #23 through 0030 at this baseline), checking current main before reserving a number.

S1 verification applies RO-01–RO-12 to memory where applicable and real PG16/17. Test all four signed roles, changed/revoked membership, forged/expired tokens, foreign existing and missing projects/sessions with identical denials, same-project wrong-session exclusion, unset RLS settings, and a removed SQL project predicate with RLS still blocking foreign rows. Test direct transaction flags and role, literal SELECT allowlist, negative write probes, cleanup under timeout, and unchanged data/catalog. Include one fixture per milestone, rejected gate/CR, pending CR without decision/application rows, applied CR preserving the original decision and emitting submitted, decided and applied milestones on both backends, timestamp ties across and within types, microsecond boundaries, duplicate-free walk on static fixtures, inter-page insert behavior, null and invalid timestamps, malformed/cross-purpose/context/expired cursors, unsupported stage and other query keys, exact DTO allowlist, byte cap, and legacy-reader regression.

**Disposition:** sufficient persisted evidence exists for the narrow contract. Full stage/lease transition coverage remains unsupported. A future stronger contract could add append-only transition rows emitted in the same transaction as the state change, carrying project, authoritative session or task binding, unique ID, persisted timestamp and an allowlisted transition kind. Historical completeness, deployment-only writers, operational scale and the feasibility of lease-to-session binding are unknown. No S1, migration or capture changes are authorized by this document.

## S1-a retry scale probe and stop

Tested PostgreSQL 16.16 and 17.12 with existing migrations 0001 and 0003–0008. Each disposable database held one project, one session, one baseline freeze, 30,004 artifacts, 30,001 gates and 100,000 decided change requests. Fixture writes were direct SQL with schema constraints and triggers enabled. Ran ANALYZE before measuring. Both probe sessions reported `current_user=app_runtime`, `row_security=on` and a read-only repeatable-read transaction. Project/principal settings were scoped to the fixture and statement/lock timeouts were 2 s/250 ms.

Each branch was a separate prepared SELECT with explicit project and session UUID predicates, a nonnull timestamp predicate, the strict tuple boundary, descending timestamp/UUID order and LIMIT 101 (limit 100 plus lookahead). Used an internal infinity boundary for this first-page plan probe. The public cursor continues to require a finite timestamp. The artifact and gate branches selected their proposed detail columns. No table changes were made for the probe beyond inserting fixture data.

| Branch | Actual scan / sort (both versions) | Rows read → returned | Runtime shared hits (16 / 17) | Execution ms (16 / 17) |
| --- | --- | ---: | ---: | ---: |
| session.created | Sequential scan of one-row fixture / quicksort | 1 → 1 | 26 / 26 | 0.939 / 1.416 |
| artifact.recorded | Sequential scan / top-N heapsort | 30,004 → 101 | 1,204 / 1,204 | 27.855 / 39.544 |
| gate.decided | Sequential scan / top-N heapsort | 30,001 → 101 | 790 / 790 | 19.995 / 29.122 |
| baseline.frozen | Sequential scan of one-row fixture / quicksort | 1 → 1 | 1 / 1 | 0.055 / 0.090 |
| change-request.submitted | Index scan `idx_cr_project_session` / incremental sort | 102 → 101 | 11 / 11 | 0.170 / 0.234 |
| change-request.decided | Sequential scan / top-N heapsort | 100,000 → 101 | 3,572 / 3,572 | 44.423 / 69.558 |

**Stop.** The artifact, gate and change-request decision plans scan every candidate before returning the page. Top-N sorting bounds sort memory and returned rows. Read work still grows with session history. The observed times are under the statement timeout on this fixture, but the measured plans do not establish the required work bound. The existing artifact/gate indexes are stage-oriented, and the CR index orders by creation time instead of decision time. These branches require an index decision before implementation. The submitted branch result is for distinct timestamps and does not establish a bound for large groups of ties. Finite-cursor plans and multi-project scale remain unverified.

The CR source audit found three repository write sites per backend. Create sets the creation time and leaves decision/application timestamps unset, decide requires pending and sets the decision time, and apply preserves creation and decision times. PostgreSQL enforces retention of the creation and decision timestamps through the transition trigger. The memory clock/PG application timestamp difference remains deferred above. This static audit is separate from the required executable parity proof, which was not reached after the scale stop. No DAO, cursor, route, schema or index is included in this retry. [Memory create](../../../packages/database/src/index.ts#L5500-L5524) · [Memory decide](../../../packages/database/src/index.ts#L5607-L5623) · [Memory apply](../../../packages/database/src/index.ts#L5772-L5779) · [PostgreSQL trigger](../../../packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql#L364-L422)

## Issue #34 index probe and stop

Replayed all schema migrations through 0030 from empty PostgreSQL 16.16 and 17.12 databases, excluding 0002 (the separate RLS verification script). Tested the following candidate definitions in disposable databases only. CI invokes migration files with `psql -v ON_ERROR_STOP=1 -f`; migration 0030 uses explicit `BEGIN`/`COMMIT`. The candidate used the same transaction framing and ordinary `CREATE INDEX IF NOT EXISTS`. Both versions accepted a second execution and listed all three definitions in `pg_indexes`.

### Candidate DDL retained from the original probe

```sql
BEGIN;
CREATE INDEX IF NOT EXISTS idx_stage_artifacts_timeline
  ON stage_artifacts USING btree (project_id, pipeline_session_id, created_at DESC, artifact_id DESC);
CREATE INDEX IF NOT EXISTS idx_stage_approval_gates_timeline
  ON stage_approval_gates USING btree (project_id, pipeline_session_id, decided_at DESC, gate_id DESC);
CREATE INDEX IF NOT EXISTS idx_change_requests_decided_timeline
  ON change_requests USING btree (project_id, pipeline_session_id, decided_at DESC, cr_id DESC)
  WHERE decided_at IS NOT NULL;
COMMIT;
```

Reused the prior 30,004 artifact / 30,001 gate / 100,000 decided CR fixture sizes and branch queries. Fixture artifact hashes were computed from their JSON to satisfy the canonical hash trigger in migration 0011. The tied fixture kept those cardinalities and assigned at least 3,000 rows per branch the same timestamp. Both fixtures queried under `app_runtime`, `row_security=on`, read-only repeatable read, with limit 101. The first-page probe used the prior internal infinity boundary. The tied probe used `2026-01-01T00:00:00Z`, the queried branch's rank and UUID `01000000-0000-0000-0000-000000000000`.

**Stopped.** At the tied boundary, the prior predicate compares `(timestamp, type_rank, UUID)`. The actual index conditions only bound the timestamp. Both versions filtered several thousand candidates afterward. Artifact and gate branches still sorted on both versions, and the decision branch still sorted on PostgreSQL 16. An ordered scan on PostgreSQL 17 still filtered 2,992 decision rows. The first-page results do not establish bounded work for continuation. A future review must decide whether to authorize a rank-aware branch predicate and re-run the probes. No migration was added to the repository. Second-scale, NULL-majority, multi-project, write overhead and CI verification were not reached after this stop.

### Actual EXPLAIN output

Below are the measured plans, with psql formatting and planning-only buffer output omitted.

#### PostgreSQL 16 · Original size, first page

**artifact.recorded**

```text
 Limit  (cost=0.41..16.90 rows=101 width=93) (actual time=0.061..0.102 rows=101 loops=1)
   Buffers: shared hit=5 read=3
         One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
         Buffers: shared hit=5 read=3
               Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (created_at IS NOT NULL) AND (created_at <= 'infinity'::timestamp with time zone))
               Filter: (ROW(created_at, 2, artifact_id) < ROW('infinity'::timestamp with time zone, 6, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
               Buffers: shared hit=5 read=3
Execution Time: 0.145 ms
```

**gate.decided**

```text
 Limit  (cost=0.41..13.70 rows=101 width=118) (actual time=0.057..0.092 rows=101 loops=1)
   Buffers: shared hit=4 read=3
         One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
         Buffers: shared hit=4 read=3
               Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (decided_at IS NOT NULL) AND (decided_at <= 'infinity'::timestamp with time zone))
               Filter: (ROW(decided_at, 3, gate_id) < ROW('infinity'::timestamp with time zone, 6, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
               Buffers: shared hit=4 read=3
Execution Time: 0.118 ms
```

**change-request.decided**

```text
 Limit  (cost=0.42..7.27 rows=101 width=28) (actual time=0.069..0.090 rows=101 loops=1)
   Buffers: shared hit=1 read=3
         One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
         Buffers: shared hit=1 read=3
               Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (decided_at <= 'infinity'::timestamp with time zone))
               Filter: (ROW(decided_at, 6, cr_id) < ROW('infinity'::timestamp with time zone, 6, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
               Heap Fetches: 0
               Buffers: shared hit=1 read=3
Execution Time: 0.114 ms
```

#### PostgreSQL 16 · Tied continuation

**artifact.recorded**

```text
 Limit  (cost=1430.41..1430.42 rows=3 width=93) (actual time=1.981..1.985 rows=13 loops=1)
   Buffers: shared hit=122 read=30
         Sort Key: created_at DESC, artifact_id DESC
         Sort Method: quicksort  Memory: 26kB
         Buffers: shared hit=122 read=30
               One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
               Buffers: shared hit=122 read=30
                     Recheck Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (created_at IS NOT NULL))
                     Filter: (ROW(created_at, 2, artifact_id) < ROW('2026-01-01 00:00:00+00'::timestamp with time zone, 2, '01000000-0000-0000-0000-000000000000'::uuid))
                     Rows Removed by Filter: 2991
                     Heap Blocks: exact=121
                     Buffers: shared hit=122 read=30
                           Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (created_at IS NOT NULL) AND (created_at <= '2026-01-01 00:00:00+00'::timestamp with time zone))
                           Buffers: shared hit=1 read=30
 Planning Time: 0.241 ms
 Execution Time: 2.053 ms
(20 rows)
Execution Time: 2.053 ms
```

**gate.decided**

```text
 Limit  (cost=1019.34..1019.35 rows=3 width=118) (actual time=1.477..1.480 rows=13 loops=1)
   Buffers: shared hit=80 read=30
         Sort Key: decided_at DESC, gate_id DESC
         Sort Method: quicksort  Memory: 28kB
         Buffers: shared hit=80 read=30
               One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
               Buffers: shared hit=80 read=30
                     Recheck Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (decided_at IS NOT NULL))
                     Filter: (ROW(decided_at, 3, gate_id) < ROW('2026-01-01 00:00:00+00'::timestamp with time zone, 3, '01000000-0000-0000-0000-000000000000'::uuid))
                     Rows Removed by Filter: 2988
                     Heap Blocks: exact=79
                     Buffers: shared hit=80 read=30
                           Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (decided_at IS NOT NULL) AND (decided_at <= '2026-01-01 00:00:00+00'::timestamp with time zone))
                           Buffers: shared hit=1 read=30
 Planning Time: 0.163 ms
 Execution Time: 1.545 ms
(20 rows)
Execution Time: 1.545 ms
```

**change-request.decided**

```text
 Limit  (cost=3815.12..3815.14 rows=10 width=28) (actual time=2.122..2.125 rows=7 loops=1)
   Buffers: shared hit=109 read=30
         Sort Key: decided_at DESC, cr_id DESC
         Sort Method: quicksort  Memory: 25kB
         Buffers: shared hit=109 read=30
               One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
               Buffers: shared hit=109 read=30
                     Recheck Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (decided_at IS NOT NULL))
                     Filter: (ROW(decided_at, 6, cr_id) < ROW('2026-01-01 00:00:00+00'::timestamp with time zone, 6, '01000000-0000-0000-0000-000000000000'::uuid))
                     Rows Removed by Filter: 2993
                     Heap Blocks: exact=108
                     Buffers: shared hit=109 read=30
                           Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (decided_at <= '2026-01-01 00:00:00+00'::timestamp with time zone))
                           Buffers: shared hit=1 read=30
 Planning Time: 0.153 ms
 Execution Time: 2.231 ms
(20 rows)
Execution Time: 2.231 ms
```

#### PostgreSQL 17 · Original size, first page

**artifact.recorded**

```text
 Limit  (cost=0.41..16.65 rows=101 width=93) (actual time=0.153..0.208 rows=101 loops=1)
   Buffers: shared hit=5 read=3
         One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
         Buffers: shared hit=5 read=3
               Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (created_at <= 'infinity'::timestamp with time zone))
               Filter: (ROW(created_at, 2, artifact_id) < ROW('infinity'::timestamp with time zone, 6, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
               Buffers: shared hit=5 read=3
Execution Time: 0.263 ms
```

**gate.decided**

```text
 Limit  (cost=0.41..13.45 rows=101 width=118) (actual time=0.089..0.148 rows=101 loops=1)
   Buffers: shared hit=4 read=3
         One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
         Buffers: shared hit=4 read=3
               Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (decided_at <= 'infinity'::timestamp with time zone))
               Filter: (ROW(decided_at, 3, gate_id) < ROW('infinity'::timestamp with time zone, 6, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
               Buffers: shared hit=4 read=3
Execution Time: 0.184 ms
```

**change-request.decided**

```text
 Limit  (cost=0.42..15.62 rows=101 width=28) (actual time=0.084..0.132 rows=101 loops=1)
   Buffers: shared hit=4 read=3
         One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
         Buffers: shared hit=4 read=3
               Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (decided_at <= 'infinity'::timestamp with time zone))
               Filter: (ROW(decided_at, 6, cr_id) < ROW('infinity'::timestamp with time zone, 6, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
               Heap Fetches: 101
               Buffers: shared hit=4 read=3
Execution Time: 0.162 ms
```

#### PostgreSQL 17 · Tied continuation

**artifact.recorded**

```text
 Limit  (cost=1422.86..1422.87 rows=3 width=93) (actual time=1.054..1.057 rows=13 loops=1)
   Buffers: shared hit=122 read=30
         Sort Key: created_at DESC, artifact_id DESC
         Sort Method: quicksort  Memory: 26kB
         Buffers: shared hit=122 read=30
               One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
               Buffers: shared hit=122 read=30
                     Recheck Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid))
                     Filter: (ROW(created_at, 2, artifact_id) < ROW('2026-01-01 00:00:00+00'::timestamp with time zone, 2, '01000000-0000-0000-0000-000000000000'::uuid))
                     Rows Removed by Filter: 2991
                     Heap Blocks: exact=121
                     Buffers: shared hit=122 read=30
                           Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (created_at <= '2026-01-01 00:00:00+00'::timestamp with time zone))
                           Buffers: shared hit=1 read=30
 Planning Time: 0.318 ms
 Execution Time: 1.117 ms
(20 rows)
Execution Time: 1.117 ms
```

**gate.decided**

```text
 Limit  (cost=1011.83..1011.84 rows=3 width=118) (actual time=0.930..0.932 rows=13 loops=1)
   Buffers: shared hit=80 read=30
         Sort Key: decided_at DESC, gate_id DESC
         Sort Method: quicksort  Memory: 28kB
         Buffers: shared hit=80 read=30
               One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
               Buffers: shared hit=80 read=30
                     Recheck Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid))
                     Filter: (ROW(decided_at, 3, gate_id) < ROW('2026-01-01 00:00:00+00'::timestamp with time zone, 3, '01000000-0000-0000-0000-000000000000'::uuid))
                     Rows Removed by Filter: 2988
                     Heap Blocks: exact=79
                     Buffers: shared hit=80 read=30
                           Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (decided_at <= '2026-01-01 00:00:00+00'::timestamp with time zone))
                           Buffers: shared hit=1 read=30
 Planning Time: 0.182 ms
 Execution Time: 1.001 ms
(20 rows)
Execution Time: 1.001 ms
```

**change-request.decided**

```text
 Limit  (cost=0.42..200.50 rows=10 width=28) (actual time=0.573..0.578 rows=8 loops=1)
   Buffers: shared hit=2 read=30
         One-Time Filter: (current_app_project_id() = '10000000-0000-0000-0000-000000000001'::uuid)
         Buffers: shared hit=2 read=30
               Index Cond: ((project_id = '10000000-0000-0000-0000-000000000001'::uuid) AND (pipeline_session_id = '20000000-0000-0000-0000-000000000001'::uuid) AND (decided_at <= '2026-01-01 00:00:00+00'::timestamp with time zone))
               Filter: (ROW(decided_at, 6, cr_id) < ROW('2026-01-01 00:00:00+00'::timestamp with time zone, 6, '01000000-0000-0000-0000-000000000000'::uuid))
               Rows Removed by Filter: 2992
               Heap Fetches: 0
               Buffers: shared hit=2 read=30
 Planning Time: 0.133 ms
 Execution Time: 0.609 ms
(13 rows)
Execution Time: 0.609 ms
```

## Issue #34 retry with a two-stage boundary

The retry uses the unchanged candidate DDL above. The historical Sort failures used the three-column row comparison. The standard for S1-a is the rank-aware, two-stage boundary in the HTTP contract above.

Run the [self-checking probe](../../../packages/database/tests/timeline-index/probe.py) from the repository root with Python 3 and Docker. The local PostgreSQL images must report 16.16 and 17.12 respectively.

```sh
python3 packages/database/tests/timeline-index/probe.py 16 /tmp/timeline-pg16.json --writes
python3 packages/database/tests/timeline-index/probe.py 17 /tmp/timeline-pg17.json --writes
```

The probe starts disposable databases, replays the schema migrations, applies the candidate twice and checks the three catalog entries. It runs each EXPLAIN as `app_runtime` under read-only repeatable read with RLS enabled. Every stage must use exactly one of its expected ordered index scans, with `Actual Rows <= 101`, one loop at most, zero removed rows, no residual filter and no Sort. Combining stages may use up to 202 rows per branch. It exits nonzero if a checked plan or page deviates.

The first fixture has 30,004 artifacts, 30,001 gates and 100,000 decided CRs. The second has 60,004 artifacts, 60,001 gates and 200,000 decided CRs, plus 210,000 pending CRs. Both projects and both sessions remain in the second database's tables during measurements. The probe checks that the other project's rows are invisible under RLS. Groups of at least 3,000 ties are present for all three branches. The second fixture has a 100,000-row CR tie. Positions are the first, middle and last UUID within a tie and a real key at the neighboring group boundary. Each is probed at equal, lower and higher relative rank. The rank comparison tests include synthetic ranks to exercise every branch rule. The full keyset walk checks the larger fixture against an unrestricted reference ORDER BY on the same snapshot.

The write probe measures 100 artifact inserts, 100 gate inserts and 100 pending-to-approved CR updates. Both runs roll back. The baseline temporarily drops the three candidate indexes inside its rolled-back transaction. The timings are observations from disposable databases and carry no hard performance threshold.

Actual EXPLAIN JSON is attached for [PostgreSQL 16.16](timeline-index-probe-pg16.json) and [PostgreSQL 17.12](timeline-index-probe-pg17.json). The `plans` array records each case, its boundary, the stage and the unmodified EXPLAIN JSON values. The `writes` section includes the write plans and timings.

## Issue #32 S1-a parity and six-branch plan gate

Before DAO work, M6B-AC4 (memory) and M6B-AC7 (PostgreSQL 17) verified the create → decide → apply flow. Create records a valid `created_at` and a null `decided_at`. Decide records `decided_at` at or after creation and preserves `created_at`. Apply preserves both values. Under app_runtime, a direct `created_at` update was denied (42501) and an attempted APPROVED → APPLIED update that changed `decided_at` was rejected by the transition trigger (23514). Both acceptance tests passed.

The six-branch first-page probe used PostgreSQL 16.16 and 17.12, schema through 0031, the Issue #34 original-size fixture (one project, one session, one baseline, 30,004 artifacts, 30,001 gates, 100,000 decided change requests), and the same app_runtime RLS read-only repeatable-read settings. Each branch used its direct timestamp and UUID, explicit project/session predicates, a nonnull timestamp check, descending ordering, and LIMIT 101. The raw JSON contains the plans and buffer counts. [PG16 plans](timeline-s1a-first-page-pg16.json) · [PG17 plans](timeline-s1a-first-page-pg17.json)

**Stopped before DAO.** Both versions explicitly sort the session and baseline branches even on the one-row fixture. The submitted branch uses `idx_cr_project_session` and an Incremental Sort to complete UUID ordering, reading 102 index rows to return 101 on distinct creation timestamps. The three branches indexed by 0031 use ordered scans and read 101 rows each. The requested no-Sort gate over all six branches therefore fails. No continuation, DAO parity, cursor, or route tests were run. Issue #34's standalone keyset probe for its three indexed branches remains separate evidence.

The S1-a task text groups cursor expiry and owner/session mismatch under 401/403/400, while the contract above assigns 409 to a valid cursor that expired or whose context differs. The distinction is unresolved in this stopped slice.

## Issue #32 S1-a retry with a work bound

[Decision](https://github.com/shmtoan08/SoftwareFactory/issues/32#issuecomment-7165362909). The acceptance gate is scan work, including rows filtered or removed by index recheck, summed across executed scan nodes and accounting for loops. A Sort or Incremental Sort is acceptable only within the same input limit. The probe sets the bound to 102 rows per SELECT stage (limit 100, one lookahead row, one sort lookahead row). The database catalog checks confirm `product_pipeline_sessions.pipeline_session_id` is the primary key and `baseline_spec_freezes.uq_one_frozen_baseline_per_session` is a unique constraint on `pipeline_session_id`. Both constraints originate in migration 0006.

Reproduce from the repository root using Docker and Python 3. The probe exits 1 on either version for the recorded work-bound violations.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 packages/database/tests/timeline-index/work_bound.py 16 /tmp/timeline-work-bound-pg16.json
PYTHONDONTWRITEBYTECODE=1 python3 packages/database/tests/timeline-index/work_bound.py 17 /tmp/timeline-work-bound-pg17.json
```

The mixed fixture has 30,004 artifacts, 30,001 gates and 100,000 decided CRs, including 3,000 CRs sharing a submission timestamp. A second session has 3,000 CRs all sharing one submission timestamp. The first, second and last page probes use the locked two-stage queries under app_runtime RLS in a read-only repeatable-read transaction. The second and last boundary keys come from a reference ORDER BY in that snapshot. The reference query uses a separate 30-second test-oracle budget, and each measured stage uses the regular P0 2-second statement timeout.

**Stopped before DAO.** Both versions passed 23 of 30 stages. The first and second global pages scanned 3,001 submitted rows for an Incremental Sort. In the submitted-only page walk, the second page's equality stage scanned 3,232 rows on PG16 and 3,321 on PG17 despite having no Sort. The all-tied fixture scanned 3,000 submitted rows per measured nonempty page, including the last page where the Sort input itself was only 100. Other branches stayed within 102. No index, schema, trigger, write-path, DAO or cursor changes are included. [Raw PG16 plans](timeline-s1a-work-bound-pg16.json) · [Raw PG17 plans](timeline-s1a-work-bound-pg17.json)

Parity evidence remains [b311d65](https://github.com/shmtoan08/SoftwareFactory/commit/b311d65). The decision also resolves the prior cursor question. Use 409 ERR_READ_CURSOR_CONTEXT for a valid expired or context-mismatched cursor, 400 for invalid signature or format, and 401/403 for auth failures.

## Issue #35 submitted index and work-bound verification

Migration `0032_change_request_submitted_timeline_index.sql` creates `idx_change_requests_submitted_timeline`, a nonpartial B-tree on `change_requests (project_id, pipeline_session_id, created_at DESC, cr_id DESC)`. The migration uses the same explicit transaction and idempotent index creation as 0031. The repository has no down migration runner. The probe verified manual rollback with `BEGIN; DROP INDEX public.idx_change_requests_submitted_timeline; COMMIT;` on disposable databases. It verified the catalog definition on a clean replay and again upgrading a populated 0031 database, including reapplying 0032.

The work-bound reproduction commands above now exit 0 on PG16.16 and PG17.12. Both versions pass all 30 stages across all six branches, under app_runtime with RLS enabled. Each submitted stage uses the new ordered index with no Sort, including stages that return zero rows. The unchanged bound is 102. The work bound is an observation for these fixtures and plans. Production data distributions and planner choices can differ.

| Fixture and branch | First page | Page 2 (equality + older where applicable) | Last page |
| --- | ---: | ---: | ---: |
| Mixed, global submitted | 101 | 101 | 0 + 7 |
| Mixed, submitted only | 101 | 101 + 101 | 0 + 100 |
| All-tied, submitted only | 101 | 101 + 0 | 100 + 0 |
| Mixed, global decided | 101 | 0 + 101 | 0 |

The complete submitted walks matched the reference `ORDER BY created_at DESC, cr_id DESC` on the same snapshot. Both versions returned 100,000 rows on the mixed fixture and 3,000 on the all-tied fixture without duplicates or omissions. The decided regression retains `idx_change_requests_decided_timeline` from 0031 on every stage. Parity evidence remains b311d65.

The new index occupies 7,749,632 bytes at 100,000 CRs on each version. One rollback-only batch of 1,000 pending CR inserts measured 40.055 ms before and 56.811 ms after on PG16, and 68.580 ms before and 76.769 ms after on PG17. These are single EXPLAIN execution times from disposable databases, with no latency acceptance threshold.

[Actual PG16 EXPLAIN JSON](timeline-s1-idx2-pg16.json) · [Actual PG17 EXPLAIN JSON](timeline-s1-idx2-pg17.json)

## Issue #32 S1-a implementation evidence

The DAO issues a separate parameterized SELECT for each milestone and each required boundary stage. Timestamp projection preserves PostgreSQL microseconds. It reads through the existing app_runtime read-only repeatable-read unit and merges the bounded results in the contract's global order. The internal core service checks signed project, live membership, session visibility, cursor purpose and context. S1-b will own the HTTP route.

The actual SQL and bound parameters exported by the DAO were run with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` under app_runtime RLS on PostgreSQL 16.16 and 17.12. Each version passed 68 stages across first, second, last and submitted-specific continuation pages. The mixed fixture has 30,004 artifacts, 30,001 gates and 100,000 decided CRs with 3,000 tied creation timestamps. The second fixture has 5 artifacts, 2 gates and 3,000 CRs with all creation timestamps tied. Each fixture has one project, session and baseline. Both coexist for the second fixture's queries.

| Branch | Max scan rows on PG16 / PG17 | Observed access path |
| --- | ---: | --- |
| session.created | 2 / 2 | Seq Scan, max Sort input 1 |
| artifact.recorded | 101 / 101 | Index Scan, idx_stage_artifacts_timeline |
| gate.decided | 101 / 101 | Index Scan, idx_stage_approval_gates_timeline |
| baseline.frozen | 2 / 2 | Seq Scan, max Sort input 1 |
| change-request.submitted | 101 / 101 | Index Only Scan, idx_change_requests_submitted_timeline |
| change-request.decided | 101 / 101 | Index Only Scan, idx_change_requests_decided_timeline |

Counts include rows filtered by the scans. The threshold remains 102. The SQL plans are fixture evidence. The signed cursor integration test walks 6,009 milestones in 61 pages on each version and compares with a single reference ORDER BY. Unit coverage checks auth, query validation, purpose separation and expired or mismatched cursor contexts. The existing parity and work-bound probes were not run separately.

Reproduce from the repository root with Node, Python 3, Docker and local PG16.16/PG17.12 Alpine images.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 packages/database/tests/timeline-index/dao_explain.py 16 /tmp/timeline-dao-pg16.json
PYTHONDONTWRITEBYTECODE=1 python3 packages/database/tests/timeline-index/dao_explain.py 17 /tmp/timeline-dao-pg17.json
```

[Actual DAO plans PG16](timeline-s1a-dao-pg16.json) · [Actual DAO plans PG17](timeline-s1a-dao-pg17.json)

## Issue #32 S1-b applied work-bound gate

Issue #33 aligned the memory `applied_at` with the end of materialization in commit `7d420c9`. Before adding the candidate rank-7 `change-request.applied` milestone, the probe measured `applied_at` and `cr_id` with the existing two-stage boundary and a 101-row SQL limit. The bound stays at 102 scanned rows per stage.

The probe created disposable databases with schema through 0032. The mixed fixture has 100,000 applied CRs, including 3,000 with the same `applied_at`. The all-tied fixture has 3,000 applied CRs at one timestamp. The script creates those values using fixture transitions through the existing triggers. The measured reads use `app_runtime`, RLS, and a read-only repeatable-read transaction. Cursor anchors are drawn from the reference order at the first, second and last pages.

| Fixture | Page | Stage | Rows read PG16.16 / PG17.12 | Sort input PG16.16 / PG17.12 |
| --- | --- | --- | ---: | ---: |
| Mixed | First | Initial | 100,000 / 100,000 | 100,000 / 100,000 |
| Mixed | Second | Equal timestamp | 3,772 / 3,547 | none / none |
| Mixed | Second | Older | 100,000 / 100,000 | 97,000 / 97,000 |
| Mixed | Last | Equal timestamp | 58,074 / 100,000 | 0 / 0 |
| Mixed | Last | Older | 100,000 / 100,000 | 100 / 100 |
| All tied | First | Initial | 3,000 / 3,000 | 3,000 / 3,000 |
| All tied | Second | Equal timestamp | 2,900 / 2,900 | 2,900 / 2,900 |
| All tied | Second | Older | 3,000 / 3,000 | 0 / 0 |
| All tied | Last | Equal timestamp | 100 / 100 | 100 / 100 |
| All tied | Last | Older | 3,000 / 3,000 | 0 / 0 |

**Stopped.** One of ten stages passed on each version, and each run exited 1. Existing CR indexes order by submission or decision time. The measured plans could not bound reads in applied time under the locked query shape. The rank-7 milestone and S1-b route remain deferred. No index, schema, apply write-path, or DAO changes are included in this slice.

Reproduce from the repository root using the same Docker versions as the S1-a probe.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 packages/database/tests/timeline-index/applied_bound.py 16 /tmp/timeline-applied-pg16.json
PYTHONDONTWRITEBYTECODE=1 python3 packages/database/tests/timeline-index/applied_bound.py 17 /tmp/timeline-applied-pg17.json
```

[Actual PG16 EXPLAIN JSON](timeline-s1b-applied-pg16.json) · [Actual PG17 EXPLAIN JSON](timeline-s1b-applied-pg17.json)

## Issue #36 partial index and applied work-bound verification

Migration 0033 adds `idx_change_requests_applied_timeline`, a B-tree on `change_requests (project_id, pipeline_session_id, applied_at DESC, cr_id DESC) WHERE applied_at IS NOT NULL`. The probe checks the catalog after replay from empty, verifies removal with transactional `DROP INDEX` in the disposable database, upgrades the populated 0032 database, and reapplies 0033. The migration follows the existing forward-only file convention with explicit BEGIN/COMMIT.

The reproduction commands above now exit 0 on PG16.16 and PG17.12, under app_runtime with RLS and read-only repeatable read. Each applied stage uses the partial index with an ordered scan. The proven query includes the literal `applied_at IS NOT NULL` on every stage. No fallback to a full index was needed. No applied plan uses a Sort or a sequential scan. The 102-row bound is unchanged.

| Fixture and page | Rows read before PG16 / PG17 | Rows read after on both versions |
| --- | ---: | ---: |
| Mixed 100,000 CR, first | 100,000 / 100,000 | 101 |
| Mixed, second (equal then older) | 3,772 + 100,000 / 3,547 + 100,000 | 101 + 101 |
| Mixed, last (equal then older) | 58,074 + 100,000 / 100,000 + 100,000 | 0 + 100 |
| All tied 3,000 CR, first | 3,000 / 3,000 | 101 |
| All tied, second | 2,900 + 3,000 / 2,900 + 3,000 | 101 + 0 |
| All tied, last | 100 + 3,000 / 100 + 3,000 | 100 + 0 |

The additional NULL-majority fixture has 3,000 applied and 6,000 pending CRs. Its five stages match the all-tied counts. All 3,000 tied applied rows matched the reference `ORDER BY applied_at DESC, cr_id DESC` in a full keyset walk on both versions with no duplication or omission.

Each version passed all 33 measured stages. The 18 same-table regression stages used indexes 0032 for submitted and 0031 for decided and read at most 101 rows per stage. The eight global CR stages and five submitted-only stages matched Issue #35's recorded counts. The five additional decided-only stages measured 101, 0 + 101 and 100 + 0 rows. These results describe the measured fixtures. S1-b still owns the DAO milestone, route and E2E tests.

[Actual PG16 EXPLAIN JSON](timeline-s1-idx3-pg16.json) · [Actual PG17 EXPLAIN JSON](timeline-s1-idx3-pg17.json)

## Issue #32 S1-b route and verification

The required applied probe was rerun on PG16.16 and PG17.12 before implementation. Both exited 0 with 33/33 stages passing. The ten original applied stages retained the Issue #36 counts. The mixed fixture's first, second and last pages scanned 101, 101 + 101 and 0 + 100 respectively. The all-tied and NULL-majority fixtures each scanned 101, 101 + 0 and 100 + 0. The bound remains 102 rows per stage.

The actual seven-milestone DAO SQL passed 78/78 EXPLAIN stages on each version, with a maximum of 101 scan rows in these fixtures. All 12 applied stages used `idx_change_requests_applied_timeline` without Sort, with the literal nonnull predicate and two-stage boundary. The endpoint writes the same UTF-8 buffer it measured and returns the generic projection failure before sending any success headers or partial body if it exceeds 1 MiB.

The HTTP keyset walk on both PostgreSQL versions matched the seven-branch reference order for all 9,009 milestones across 91 pages, including 3,000 applied milestones tied on timestamp. Tests exercised empty continuation, project-token isolation, matching 404s for foreign and absent sessions, limit and cursor validation, and the 401/403/400/409/404/500 error table. The transport cap test uses an injected oversized DAO row because the production DTO bounds prevent normal rows from reaching the cap. Exactly 1,048,576 bytes pass and one extra byte returns 500.

Run the existing `dao_explain.py` commands above to reproduce seven-branch EXPLAIN and the real PostgreSQL HTTP test. [Applied DAO plans PG16](timeline-s1b-dao-pg16.json) · [Applied DAO plans PG17](timeline-s1b-dao-pg17.json)
