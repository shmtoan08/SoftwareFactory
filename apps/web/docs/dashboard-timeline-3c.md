# Recorded resource activity (Slice 3c, Issue #31)

The timeline uses the same results as the initial Dashboard panels for the current project and selected session. Manual refresh and paging in other panels remain local to those panels. The timeline adds no requests or controls. The banner reads “Not a complete audit trail; assembled from separate snapshots, no global ordering.”

| Scope | Displayed fact | Reader and response fields |
| --- | --- | --- |
| Session | Session created | R0 session bundle `session.pipeline_session_id`, `session.created_at` |
| Session | Gate decision recorded | R0 session bundle `approvalGates[].gate_id`, `decided_at`, with a recorded `decision` |
| Session | Artifact recorded | R0 session bundle `artifacts[].artifact_id`, `created_at`, from the same bounded list displayed in Evidence |
| Session or project | Cost session record updated | R0 session bundle `costSession.cost_session_id`, `updated_at`, `project_id`, `pipeline_session_id`; the cost ID must match `session.cost_session_id`. An explicitly null session ID stays project-scoped |
| Session | Task created / Task record updated | P3 current task page `items[].taskId`, `createdAt`, `updatedAt`, checked against `projectId` and `sessionId` |
| Session | Change request created | R0 change request reader `change_requests[].cr_id`, `created_at`, checked against `project_id` and `pipeline_session_id` |
| Project | Project budget snapshot | P2 `projectId` and `fetchedAt` |

Each row shows the reader and its client `receivedAt` as “Tải lúc”, separately from the backend timestamp. Reader groups keep a fixed presentation order. Rows within each reader are sorted by recorded timestamp and stable record identity. A record update timestamp does not establish a status transition. Missing or invalid times and conflicting facts are omitted with a partial-data indicator. Empty sources, permission errors and upstream errors are shown per reader. Worker events, event IDs and complete history are unsupported.
