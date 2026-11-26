# Slice C project pending EXPLAIN evidence

The revised index inventory matches the migrated PostgreSQL catalogs on 16.16
and 17.12, including index keys, uniqueness and predicates. The
[previous schema check](../project-pending-slice-c-schema-check.md) documents
the first attempt. The catalogs and unmodified EXPLAIN JSON are in
[pg16.json](pg16.json) and [pg17.json](pg17.json).

## Reproduce

From the repository root, using Docker and the versions checked by the script:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 apps/core-api/docs/project-pending-probe/probe.py 16 /tmp/pending-pg16.json
PYTHONDONTWRITEBYTECODE=1 python3 apps/core-api/docs/project-pending-probe/probe.py 17 /tmp/pending-pg17.json
```

The script applies all schema migrations in disposable containers using the
existing Timeline probe harness. It skips 0002, the standalone RLS assertion
suite. Each measured query uses a UUID parameter in a prepared statement
under `app_runtime`, with RLS enabled and a repeatable-read, read-only transaction.
The script checks scoped fixture cardinality, prints scan-row counts, and asserts
that each query returns the same ordered 101 rows before and after trial indexes.

Two projects each have 100,000 change requests across ten sessions, including
3,000 pending. The first uses distinct pending timestamps and the second puts all
3,000 pending records at one timestamp. Both projects are present in the same
database. The first project also has 10,000 approval requests, of which 1,000
are pending and the newest 200 pending are expired. It has 10,000 tasks, of
which 500 have status `AwaitingHumanApproval`.

## Observations

The 102-row Timeline figure is a reference. Rows read follow the Timeline
probe's scan-node accounting. Each scan contributes output plus rows removed by
filter or index recheck, multiplied by its loop count. The bitmap plans count
1,000 index entries and 1,000 heap rows separately. Buffer figures are root
shared hits and reads, and times are single-run execution milliseconds.
Sort figures are input rows, including for a top-N Sort.

| PG | Query | Phase | Rows read | Scan | Sort input | Shared hit/read | Execution ms |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: |
| 16.16 | Q1 | baseline | 200,000 | Seq Scan | 3000 | 5,590/1,539 | 46.521 |
| 16.16 | Q1-tied | baseline | 200,000 | Seq Scan | 3000 | 5,654/1,475 | 40.845 |
| 16.16 | Q2a | baseline | 2,000 | Bitmap Heap Scan + Bitmap Index Scan: uq_one_pending_approval_request_per_candidate | 1000 | 46/0 | 1.060 |
| 16.16 | Q2b | baseline | 2,000 | Bitmap Heap Scan + Bitmap Index Scan: uq_one_pending_approval_request_per_candidate | 800 | 46/0 | 0.868 |
| 16.16 | Q3 | baseline | 10,000 | Seq Scan | 500 | 205/0 | 6.209 |
| 16.16 | Q1 | trial | 101 | Index Scan: probe_pending_cr | — | 4/2 | 0.260 |
| 16.16 | Q1-tied | trial | 101 | Index Scan: probe_pending_cr | — | 101/2 | 0.365 |
| 16.16 | Q2a | trial | 101 | Index Scan: probe_pending_approval | — | 5/2 | 0.125 |
| 16.16 | Q2b | trial | 2,000 | Bitmap Heap Scan + Bitmap Index Scan: uq_one_pending_approval_request_per_candidate | 800 | 46/0 | 0.897 |
| 16.16 | Q3 | trial | 101 | Index Only Scan: probe_waiting_tasks | — | 42/2 | 0.172 |
| 17.12 | Q1 | baseline | 200,000 | Seq Scan | 3000 | 5,704/1,425 | 43.337 |
| 17.12 | Q1-tied | baseline | 200,000 | Seq Scan | 3000 | 5,768/1,361 | 37.916 |
| 17.12 | Q2a | baseline | 2,000 | Bitmap Heap Scan + Bitmap Index Scan: uq_one_pending_approval_request_per_candidate | 1000 | 46/0 | 0.717 |
| 17.12 | Q2b | baseline | 2,000 | Bitmap Heap Scan + Bitmap Index Scan: uq_one_pending_approval_request_per_candidate | 800 | 46/0 | 0.714 |
| 17.12 | Q3 | baseline | 10,000 | Seq Scan | 500 | 205/0 | 1.489 |
| 17.12 | Q1 | trial | 101 | Index Scan: probe_pending_cr | — | 4/2 | 0.218 |
| 17.12 | Q1-tied | trial | 101 | Index Scan: probe_pending_cr | — | 101/2 | 0.220 |
| 17.12 | Q2a | trial | 101 | Index Scan: probe_pending_approval | — | 5/2 | 0.093 |
| 17.12 | Q2b | trial | 2,000 | Bitmap Heap Scan + Bitmap Index Scan: uq_one_pending_approval_request_per_candidate | 800 | 46/0 | 0.715 |
| 17.12 | Q3 | trial | 101 | Index Only Scan: probe_waiting_tasks | — | 42/2 | 0.123 |

## Index recommendations

Each definition below was tested only inside the disposable databases. The
repository contains no schema migration for these indexes.

| Query | Recommendation and proposed btree definition |
| --- | --- |
| Q1 and Q1-tied | Needs a project-ordered pending index for short scans in the measured fixtures. Use `change_requests (project_id, created_at DESC, cr_id DESC) WHERE status = 'PENDING_APPROVAL'`. |
| Q2a | Needs a project-ordered pending index for a short scan. Use `approval_requests (project_id, created_at DESC, approval_request_id DESC) WHERE status = 'PENDING'`. |
| Q2b | Needs a separate access-path decision if short scans are required. Both planners kept the original bitmap and Sort with the Q2a index present. That index leaves expiry as a residual filter, so an ordered scan can still pass many expired rows. An expiry-leading index would leave the requested order to a Sort. A predicate tied to `now()` is unavailable for a partial index because index predicates must be immutable. No index definition is recommended as proven for Q2b from these runs. |
| Q3 | Needs a project-ordered pending index if this query enters scope. Use `tasks (project_id, created_at DESC, task_id DESC) WHERE status = 'AwaitingHumanApproval'`. |

This probe measures the exact first-page queries and one expiry distribution.
Later-page costs, write overhead and production selectivity remain unmeasured.
