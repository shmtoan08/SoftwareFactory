# Dashboard 3a — Approval decisions and change requests

[Issue #29](https://github.com/shmtoan08/SoftwareFactory/issues/29) authorizes two R0 reads for the session explicitly selected in Session context. Each section has an independent loading, empty, error and access-denied state. An unselected session produces an explicit empty state and triggers neither read. The two collections are rendered as returned, without a claim of complete approval history.

Let `S` be `/api/v1/projects/:projectId/pipeline-sessions/:sessionId`. Project and session IDs are checked against the request before rendering. Source timestamps are displayed verbatim.

| Section and display field | Approved GET response field | Mapping rule |
|---|---|---|
| Approval decisions · Session nguồn | `GET S → approvalGates[].pipeline_session_id` | Match the selected session and the enclosing `session.pipeline_session_id` |
| Approval decisions · Gate ID | `approvalGates[].gate_id` | Recorded gate identity |
| Approval decisions · Gate | `approvalGates[].gate_stage` | Recorded gate identifier |
| Approval decisions · Artifact ID đã ghi | `approvalGates[].target_artifact_id` | Preserve the decision's target ID |
| Approval decisions · Artifact SHA-256 đã ghi | `approvalGates[].target_artifact_sha256` | Preserve the decision's target hash |
| Approval decisions · Binding | Gate target ID and hash compared with `artifacts[].artifact_id` and `artifacts[].artifact_sha256` | An exact match requires both values in one artifact record in the same project and session. A decision remains bound to its recorded hash |
| Approval decisions · Decision label | `approvalGates[].decision` | APPROVED → Approved, REJECTED → Rejected, REQUEST_CHANGES → Changes requested. Missing or null → No recorded decision |
| Approval decisions · Lý do | `approvalGates[].rationale` | Display the recorded rationale or its explicit null |
| Approval decisions · Người quyết định | `approvalGates[].approver_principal_id` | Recorded principal |
| Approval decisions · Quyết định lúc | `approvalGates[].decided_at` | Recorded timestamp |
| Change requests · Session nguồn | `GET S/change-requests → change_requests[].pipeline_session_id` | Match the selected session |
| Change requests · Change request ID | `change_requests[].cr_id` | Recorded request identity |
| Change requests · Mã and title | `change_requests[].cr_key`, `change_requests[].title` | Recorded key and title |
| Change requests · Baseline ID | `change_requests[].baseline_id` | Recorded baseline binding |
| Change requests · Change request SHA-256 | `change_requests[].cr_sha256` | Recorded request hash |
| Change requests · Trạng thái | `change_requests[].status` | PENDING_APPROVAL → Pending approval, APPROVED → Approved, REJECTED → Rejected, APPLIED → Applied. Only returned records receive labels |

Both readers return `project_id` on records for scope validation. The bundle's top-level session scope is checked independently. The artifact comparison consumes identity and hash only. Artifact bodies, cost ledgers and proposed task content remain outside the mapped views.

Unsupported and hidden capabilities include pending pipeline gate requests, derived approval deadlines, task approval history, and deployment/reconciliation approval collections. Missing gate decisions use the specified fallback. Missing binding fields or invalid scope produce a section error. The Dashboard makes no approval mutations.
