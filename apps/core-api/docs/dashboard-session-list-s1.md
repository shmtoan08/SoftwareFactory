# Dashboard session list S1 — query plan and verification

The endpoint implements the [S0 contract](./dashboard-session-list-s0.md) through the [bounded source projection](../../../packages/database/src/postgres-pool.ts). The HTTP checks run in the [session test harness](../../../packages/test-harness/src/dashboard-session-source.test.ts) alongside the source checks. The harness exercises the defensive 404 by injecting an empty project lookup after membership verification. The membership foreign key prevents that state in the normal PostgreSQL fixture.

## PostgreSQL 17 query plan

Executed the repository's literal SELECT with `EXPLAIN (ANALYZE, BUFFERS)` in a dedicated PostgreSQL 17 fixture with the repository migrations applied, 10,006 sessions in the signed project and eight in other projects. The read used `REPEATABLE READ READ ONLY`, effective role `app_runtime`, the normal project/principal RLS settings and the existing indexes. Both requests used the maximum API page size (100 plus one probe row).

| Request | Plan shape | Rows entering sort | Rows returned by SQL | Shared buffers hit | Execution time |
|---|---|---:|---:|---:|---:|
| First page, null anchor | Sequential scan, project/RLS filter, top-N heapsort, limit | 10,006 | 101 | 236 | 17.660 ms |
| Next page, timestamp/UUID anchor | Sequential scan, project/RLS and strict tuple filters, top-N heapsort, limit | 4,799 | 101 | 214 | 8.721 ms |

Both sorts used `created_at DESC, pipeline_session_id DESC` and 51 kB of memory. The later-page plan applied `ROW(created_at, pipeline_session_id) < ROW(anchor timestamp, anchor UUID)` before the sort. The application receives only the bounded page. PostgreSQL still scans candidate rows because the existing index does not provide the full unfiltered ordering. These are local fixture measurements under the existing 2 s statement limit. No schema or index changes were needed for this fixture.
