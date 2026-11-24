# Dashboard Evidence (Slice 3b, Issue #30)

Evidence uses the selected session's R0 `GET /api/v1/projects/:projectId/pipeline-sessions/:sessionId` bundle, shared with Approval decisions. The response shape comes from `ProductPipelineBundle` and `StageArtifactRecord` in `packages/shared-types/src/index.ts`.

| Display | Bundle response |
| --- | --- |
| Artifact ID | `artifacts[].artifact_id` |
| Artifact SHA-256 | `artifacts[].artifact_sha256` |
| Artifact type | `artifacts[].artifact_kind` |
| Recorded artifact stage | `artifacts[].stage` |
| Escaped JSON text preview | `artifacts[].content_json` |
| Matching approval gate IDs | `approvalGates[].gate_id`, where `target_artifact_id` and `target_artifact_sha256` both equal the row's ID and hash |

The mapper checks bundle and artifact project/session scope before displaying content. Missing or invalid artifact fields produce an inaccessible/unavailable row. If gate data is invalid, the gate association is unsupported. A valid empty artifact list has a separate empty state.

The UI displays at most 50 artifact rows in bundle order and up to 4,096 UTF-16 code units of JSON preview per row before HTML escaping. It indicates both limits when applied. These are display limits on the existing R0 response.

Blob access, download URLs, reconciliation evidence lookup and R1 traceability are unsupported in this view.
