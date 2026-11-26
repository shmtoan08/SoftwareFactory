# Issue #38 — Pending approvals S1 verification

The migration adds exactly two project-ordered partial btree indexes, one for
`change_requests.status = 'PENDING_APPROVAL'` and one for
`approval_requests.status = 'PENDING'`. The verification runner applies 0034
after the schema through 0033, verifies that rolling back the DDL transaction
leaves neither index, reapplies 0034 twice, and also applies the complete schema
through 0034 to a fresh database. It checks the two catalog definitions on each
path. The repository uses transactional, idempotent migrations without
separate down files.

The fixture reuses the [Slice C probe](../project-pending-probe/README.md).
Each of two projects has 100,000 CRs across ten sessions, including 3,000
pending. The second project has a single timestamp shared by all pending CRs.
Each project has 10,000 approval requests including 1,000 pending, with its 200
newest pending requests expired. The reader tests compare complete walks
against an independent SQL order oracle under real PostgreSQL and run the
source SQL again as the RLS-bypassing fixture owner to check project predicates.

## Plans

The runner captures the actual first-page reader statements under
`app_runtime` with RLS enabled and a repeatable-read, read-only transaction.
These plans measure the ordered CR and raw PENDING approval candidate scans.
Approval TTL is applied after each chunk using one database timestamp per
request. Long runs of expired approvals may require additional chunks and
remain subject to the read deadline. The measured bound is per statement.

| PostgreSQL | Source | Fixtures | Rows read per statement | Plan | Sort |
| --- | --- | --- | ---: | --- | --- |
| 16.16 | CR | Mixed and tied | 101 | Index Scan on `idx_change_requests_project_pending` | None |
| 16.16 | Merge approval | Mixed and tied | 101 | Index Scan on `idx_approval_requests_project_pending` | None |
| 17.12 | CR | Mixed and tied | 101 | Index Scan on `idx_change_requests_project_pending` | None |
| 17.12 | Merge approval | Mixed and tied | 101 | Index Scan on `idx_approval_requests_project_pending` | None |

[Raw PG16.16 JSON](pg16.json) · [Raw PG17.12 JSON](pg17.json) · [S0 contract](../dashboard-project-pending-approvals-s0.md)

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 apps/core-api/docs/project-pending-s1/verify.py 16 /tmp/pending-s1-pg16.json
PYTHONDONTWRITEBYTECODE=1 python3 apps/core-api/docs/project-pending-s1/verify.py 17 /tmp/pending-s1-pg17.json
```
