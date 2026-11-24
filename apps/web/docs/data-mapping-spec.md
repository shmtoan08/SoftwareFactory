# Dashboard — Data Mapping Spec v2

**Status:** Ready for Kit review. Slice 1a implementation starts after Kit accepts this revision.

**DTO baseline:** `e9a8d56f8b377880f08342ea101dac575262eee6` on `main`. This revision follows the [Slice 1a decision](https://github.com/shmtoan08/SoftwareFactory/issues/20#issuecomment-7121313686) and the [P1–P3 acceptance](https://github.com/shmtoan08/SoftwareFactory/issues/22#issuecomment-6937147418). The [Slice 0 capability matrix](./api-capability-matrix.md) records the earlier audit. The [P0 contract](../../core-api/docs/dashboard-read-projections-p0.md) and the response builders at the stated baseline define the DTOs below.

## 1. Client results and API metadata

Slice 1a uses the four GET endpoints below with the existing signed project context. Preserve the endpoint and requested IDs as client metadata outside the mapped DTO. Check returned project and session IDs against the authorized/requested context. A scope mismatch or missing or malformed required data is an explicit data error. Construct mapped DTOs from the field allowlists below and discard extra keys at each level.

- Client results are `ok | empty | error`. An accepted collection response with `items: []` is empty. A 403 is access-denied, 404 is not-found, and 500 is a server error. Keep HTTP 400, timeout and network failures distinguishable. Preserve other HTTP errors and their status codes.
- `receivedAt` belongs to the client result envelope and records when the HTTP response arrives, including HTTP errors. A timeout or network failure without a response has no receipt timestamp. `fetchedAt` belongs to a successful API DTO and records the server transaction snapshot. Copy it verbatim, including on an empty collection. Preserve source timestamps as strings at API precision.
- Every successful DTO includes `schemaVersion` (`dashboard-read-v1`) and `fetchedAt`. Copy both directly. For both collections, copy `page.limit`, `page.hasMore` and `page.nextCursor` directly. The server supplies an opaque keyset cursor or explicit `null` when no next page exists. Pass the cursor back unchanged with the same scope, limit and filters. Each page has its own snapshot.
- Limits default to 20 for projects and 25 for tasks. Both accept 1–100. An over-limit request is a 400 error. Preserve this error and avoid clamping the limit.

## 2. P1 project list and detail

GET `/api/v1/projects` maps `items[]` to project DTOs and copies `scope.kind` (`project-token`), `scope.projectId` and the page metadata above. Under D-01, the collection is scoped to the signed project token. GET `/api/v1/projects/:projectId` maps the single `project` object. Both use the same field allowlist. [P1 reader](../../core-api/docs/dashboard-project-reader-p1.md)

| DTO field | Mapped field | Meaning |
|---|---|---|
| `projectId` | `projectId` | Project ID |
| `slug` | `slug` | Project slug |
| `name` | `name` | Project name |
| `defaultBranch` | `defaultBranch` | Configured default branch |
| `createdAt` | `createdAt` | Project creation timestamp |
| `updatedAt` | `updatedAt` | Project update timestamp |

## 3. P2 project budget snapshot

GET `/api/v1/projects/:projectId/budget-snapshot` takes no query parameters. Map the following fields and the common DTO metadata. [P2 reader](../../core-api/docs/dashboard-budget-reader-p2.md)

| DTO field | Mapped field | Meaning |
|---|---|---|
| `projectId` | `projectId` | Project scope |
| `policy` | `policy` | Preserve `null` for absent policy |
| `policy.status` | `policy.status` | Literal `ACTIVE` or `AUTO_PAUSED` when policy exists |
| `policy.updatedAt` | `policy.updatedAt` | Policy update timestamp when policy exists |
| `dimensions.tokens` | `dimensions.tokens` | Recorded model token usage |
| `dimensions.costMicroUsd` | `dimensions.costMicroUsd` | Recorded model cost in micro-USD |
| `dimensions.wallTimeMs` | `dimensions.wallTimeMs` | Recorded phase/attempt wall time in milliseconds |
| `estimatedModelUsageIncluded` | `estimatedModelUsageIncluded` | Boolean observation from recorded ledgers |
| `recoveryState` | `recoveryState` | Preserve `clear`, `pending` and `unknown`. Missing or unrecognized values become `unknown`. Use `clear` only when explicitly returned |
| `recoveryReason` | `recoveryReason` | Server literal `no-visible-pending-intent`, `visible-pending-intent` or `journal-not-modeled` |
| `recoveryScope` | `recoveryScope` | Server literal `visible-project-budget-denial-intents-at-snapshot` |
| `usageSemantics` | `usageSemantics` | Server literal `recorded-project-ledgers-and-resource-metrics` |

Each of the three dimension objects has the same field mapping.

| DTO field | Mapped field | Meaning |
|---|---|---|
| `unit` | `unit` | `tokens`, `micro_usd` or `milliseconds` as returned for that dimension |
| `limitKind` | `limitKind` | `configured`, `unbounded` or `policy-absent` |
| `limit` | `limit` | Exact unsigned decimal string or `null` |
| `consumed` | `consumed` | Exact unsigned decimal string |
| `remaining` | `remaining` | Exact signed decimal string or `null` |

Preserve decimal strings, negative remaining amounts and explicit nulls. Use the server's remaining amount directly. Pending and unknown snapshots are provisional. Clear describes the absence of visible committed pending intents at the snapshot.

## 4. P3 session task page

GET `/api/v1/projects/:projectId/sessions/:sessionId/tasks` requires a caller-supplied `sessionId`. Copy the envelope's `projectId`, `sessionId`, `filters.sourceStatuses`, `filters.stage` (literal `null`) and the common DTO and page metadata. The server validates session membership and task links before projecting items. [P3 reader](../../core-api/docs/dashboard-task-reader-p3.md)

| DTO field in `items[]` | Mapped field | Meaning |
|---|---|---|
| `taskId` | `taskId` | Task ID |
| `projectId` | `projectId` | Project ID |
| `sessionId` | `sessionId` | Validated session association |
| `title` | `title` | Task title |
| `sourceStatus` | `sourceStatus` | Exact source string, including unfamiliar literals |
| `currentAttemptNo` | `currentAttemptNo` | Current attempt counter as a safe integer |
| `reworkCount` | `reworkCount` | Rework counter as a safe integer |
| `maxReworkCycles` | `maxReworkCycles` | Rework limit as a safe integer |
| `activeLeaseEpoch` | `activeLeaseEpoch` | Exact unsigned decimal string |
| `assigneeId` | `assigneeId` | Planned profile ID or `null` |
| `leaseOwnerId` | `leaseOwnerId` | Recorded lease worker ID or `null` |
| `leaseExpiresAt` | `leaseExpiresAt` | Recorded lease expiry or `null`, even when the recorded expiry has elapsed |
| `createdAt` | `createdAt` | Task creation timestamp |
| `updatedAt` | `updatedAt` | Task update timestamp |

Keep `sourceStatus` verbatim. Slice 1a assigns no display label, inferred status or previous-attempt outcome. The three counters and lease epoch remain independent fields.

**D-02:** Any `stage` query returns HTTP 400. Stage filtering, grouping and counting are unsupported. `filters.stage: null` is response metadata and confers no task stage.

### Session selection for Slice 1b

The official source of selectable sessions is `GET /api/v1/projects/:projectId/sessions` under the signed project scope (D-01). Match the response and each item's `projectId` to the selected project. Use a returned `pipelineSessionId` as the identity for explicit selection and pass it as `sessionId` when requesting the P3 task page. [S0 contract](../../core-api/docs/dashboard-session-list-s0.md) · [S1 projection](../../core-api/src/session-read-projection.ts) · [S1 route](../../core-api/src/http-server.ts)

| DTO field in `items[]` | Use in session selection |
|---|---|
| `pipelineSessionId` | Session identity |
| `projectId` | Authorized project scope |
| `title` | Stored session title |
| `createdAt` | Stored creation timestamp |
| `updatedAt` | Stored update timestamp |

Each page has `schemaVersion`, `fetchedAt`, `projectId`, `items` and `page: {limit, hasMore, nextCursor}`. `fetchedAt` remains the server transaction snapshot timestamp and is copied verbatim. The client records `receivedAt` separately when it receives the response. Keep source timestamps at wire precision.

The reader uses keyset order `(created_at DESC, pipeline_session_id DESC)`. Limit defaults to 20 and accepts at most 100. Pass the opaque `nextCursor` unchanged within the same project, principal and limit until it is null. The cursor uses HMAC-SHA256 with the dedicated purpose `dashboard-session-list-cursor-v1` and expires after 15 minutes. An invalid cursor returns 400, and an expired or context-mismatched session cursor returns 409. The reader supports no filters. A `stage` query returns 400.

Session selection in 1b uses the candidates returned by this reader. A successful empty list supplies no candidates. An access denial or read failure remains an error. The DTO supplies no session status. An ACTIVE-based automatic choice requires an authorized status source. List order and timestamps supply no evidence of an ACTIVE session.

## 5. Unsupported ở 1a

| Capability | Missing source | Follow-up |
|---|---|---|
| Session-dependent Pipeline Progress | The session reader supplies identity, title and timestamps. It exposes no stage, status, artifacts, gate decisions or baseline evidence. D-02 supplies no authoritative task stage, so a P3 task page cannot fill this gap | Remains unsupported for 1b until a separate authorized progress evidence source is established |
| Approval | The P1–P3 DTOs supply no approval or decision records | Slice 3, after an approved reader. Include the rejected-approval case there |
| Artifact | The P1–P3 DTOs supply no artifact records or access observations | Slice 3, after an approved reader. Include the inaccessible-artifact case there |

## 6. Slice 1a verification after spec review

Use fixtures with the actual P1–P3 wire shapes. Check project list/detail, budget snapshot, task pages with a supplied session ID, counters and unfamiliar `sourceStatus` strings preserved verbatim. Check the allowlists with extra-field fixtures and verify scope and malformed-data failures. Check missing or unfamiliar `recoveryState` separately. Exercise GET-only requests, typed HTTP/timeout/network failures, empty collections, both limit boundaries, opaque cursor forwarding and the D-02 response. Verify that the client sets `receivedAt` at receipt while the DTO's `fetchedAt` passes through unchanged. Run the existing console route regression suite when implementing 1a.

## Appendix. Slice 0 proposals for later slices

The following presentation proposals are retained for later slices. Sections 1–6 govern Slice 1a. Later slices need their own approved data sources and review before implementing these proposals.

### Pipeline Progress — presentation facts, not project percentage

Use the name **Pipeline Progress**. There is no approved formula for total project completion percentage, Project Health or workload. `coverage_percent` is traceability coverage only. The backend `PipelineStageName` has stages 1–4 only; do not extend `current_stage` with invented Stage5–9 states.

| Display step | Source evidence and proposed label rule | Absent/rejected/retry handling |
|---|---|---|
| 1 — Idea discovery | Artifact.stage=STAGE_1_IDEA_DISCOVERY / discoveryItems; gate_stage=STAGE_1_DISCOVERY bound to artifact ID/hash | “No recorded artifact/decision” if absent; REJECTED/REQUEST_CHANGES remain distinct |
| 2 — Requirements | Artifact.stage=STAGE_2_REQUIREMENTS; exact bound stage2 gate | Presence means “Artifact recorded”, not “Completed” or “Approved” |
| 3 — Architecture | Artifact.stage=STAGE_3_ARCHITECTURE; exact bound stage3 gate | Keep source versions/hashes; do not apply approval of an older artifact to a newer one |
| 4 — Spec freeze | STAGE_4_SPEC_FREEZE artifact/gate; baselineFreeze.status=FROZEN and frozen_at | Only an actual baseline record warrants “Baseline frozen”; session.FROZEN does not prove project delivery |
| 5 — Bootstrap | M6B bundle.bootstrap record | Conditional R1; unsupported until approved. Record presence would mean “Bootstrap recorded”, not inferred test health |
| 6 — Agent profiles | Project-scoped agent_profiles/configuration | Profiles are not session stage executions or online agents; label source scope, no inferred stage-complete flag |
| 7 — Development plan | stage7_plan hierarchy/taskLinks | Conditional R1 and unpaginated; “Plan records available” only when authorized data exists |
| 8 — Task execution | Authoritative session task links and their TaskRecord/attempts | Conditional R1/scale gap; show per-task source states only. Do not manufacture a stage-level ACTIVE/FAILED/Blocked state |
| 9 — Change and release | GET change-requests and release-package records | Show each record's decision/status/coverage separately. A CR or package is not proof that all work or deployment finished |

R0 v1 can render available stage1–4 artifact/gate facts and approved stage9 record panels. Do not render misleading complete progress steps for unsupported stage5–8 panels. Their capability omission and reasons are reported in the audit, not replaced with demo placeholders.

Retries: `StageArtifactRecord.version` is an artifact version, not a stage execution attempt count. Preserve all returned versions. For a “latest artifact” view, use the greatest version within `(project,session,stage,artifact_kind)` only when unique; conflicting equal versions yield a data-conflict state. Gate records bind `target_artifact_id` and `target_artifact_sha256`; show decisions for that exact version. `current_stage` is a source marker, not proof of a running model call. Actual `ModelCallLedgerRecord` failure statuses may annotate their recorded stage/call, never change the session's source status. The session enum has no FAILED value: an unknown future FAILED state displays Unknown until a mapping is reviewed.

“Blocked” requires a backend-confirmed blocker and a resource ref/reason. No TaskStatus currently equals Blocked. ManualIntervention, ReworkRequired, missing artifacts, dependency edges, timeouts and model failures are not automatically blocked. The mutating scheduler cannot be invoked to discover rejection reasons; the legacy GET /budget may recover/write. The P2 snapshot supplies project budget observations only.

### Status presentation (deferred)

Every badge retains `resourceType`, `sourceField`, **sourceStatus** (unaltered), **displayStatus** (presentation only), source IDs and endpoint. Unknown/missing/wrong-type values produce `displayStatus=Unknown`, preserve safe original source data for diagnosis and do not coerce to To Do/Done/Blocked. Plain-text rendering must escape all source content. The tables are presentation proposals, not additions to backend enums or proof that conditional/unsupported endpoints are approved.

#### TaskStatus (all 11 values)

| sourceStatus | displayStatus |
|---|---|
| Ready | Ready |
| Leased | Leased |
| ExecutingInTarget | Executing in target |
| BuildingMergeCandidate | Building merge candidate |
| VerifyingInDocker | Verifying in Docker |
| UnderIndependentReview | Under independent review |
| AwaitingHumanApproval | Awaiting human approval |
| AtomicCasMerge | Atomic CAS merge |
| MergedAndCompleted | Merged and completed |
| ReworkRequired | Rework required |
| ManualIntervention | Manual intervention |

Task retry display uses `current_attempt_no`, `active_lease_epoch`, `rework_count` and `max_rework_cycles` as separate exact fields. `Ready` after an expired lease is still Ready; do not collapse it into a hidden previous failed attempt. Candidate/approval records must retain their task/attempt/candidate bindings when such a reader is approved.

#### Other status domains (every literal in each relevant source enum)

| Domain/source field | Exact mapping (source → display) |
|---|---|
| Pipeline session.status | ACTIVE → Active; FROZEN → Frozen; CANCELLED → Cancelled |
| Lease.status | ACTIVE → Active lease; COMPLETED → Completed lease; EXPIRED → Expired lease; REVOKED → Revoked lease |
| Stage1 confirmation_status | AUTO_VERIFIED → Auto verified; UNCONFIRMED → Unconfirmed; CONFIRMED → Confirmed; REJECTED → Rejected |
| Pipeline gate.decision | APPROVED → Approved; REJECTED → Rejected; REQUEST_CHANGES → Changes requested |
| Human approval request.status | PENDING → Pending approval; APPROVED → Approved; REJECTED → Rejected; INVALIDATED_EXPIRED → Invalidated: expired; INVALIDATED_STALE_BASE → Invalidated: stale base; INVALIDATED_STALE_CANDIDATE → Invalidated: stale candidate |
| Human approval decision.decision | APPROVED → Approved; REJECTED → Rejected; REQUEST_CHANGES → Changes requested |
| Human approval decision.status (separate badge) | ACTIVE → Active; CONSUMED → Consumed; INVALIDATED → Invalidated; EXPIRED → Expired |
| Verification overall_status | PASSED → Passed; FAILED_ACCEPTANCE → Failed acceptance; TEST_TAMPERING_DETECTED → Test tampering detected; TEST_TIMEOUT → Test timeout; INFRA_ERROR → Infrastructure error |
| Review session.status | ACTIVE → Active review; COMPLETED → Completed review; FAILED → Failed review; REVOKED → Revoked review |
| Review artifact.status, when supplied | VALID → Valid; INVALIDATED_STALE_CANDIDATE → Invalidated: stale candidate; INVALIDATED_STALE_BASE → Invalidated: stale base |
| Review artifact.verdict (separate) | PASS → Pass; FAIL → Fail. `is_invalidated`/`invalidated_reason` remain separate; PASS is not necessarily a usable approval |
| CR.status | PENDING_APPROVAL → Pending approval; APPROVED → Approved; REJECTED → Rejected; APPLIED → Applied |
| Budget policy.status (unsupported reader) | ACTIVE → Active budget policy; AUTO_PAUSED → Budget auto-paused. Not a task Blocked state; do not fetch mutating budget GET |
| Cost session.status | ACTIVE → Active; EXHAUSTED → Exhausted; CLOSED → Closed |
| Model call.status | ALLOWED → Allowed; BLOCKED_PREFLIGHT → Blocked at preflight; BLOCKED_POSTCALL → Blocked at postcall; FAILED_VALIDATION → Failed validation; FAILED_PROVIDER → Failed provider. These are call results, not task Blocked |
| Target dispatch.status | PENDING → Pending dispatch; SENDING → Sending; IMPORTED → Imported; UNKNOWN → Unknown outcome; REJECTED → Rejected |
| Merge queue.status | QUEUED → Queued; PROCESSING → Processing; MERGED → Merged; REBASED_NEEDS_REVERIFY → Rebased, needs reverification; FAILED → Failed; CANCELLED → Cancelled |
| Merge operation.status | IN_PROGRESS → In progress; MERGED → Merged; CAS_CONFLICT_ABORTED → Aborted: CAS conflict |
| Deployment approval.status (currently unsupported reader) | ACTIVE → Active; CONSUMED → Consumed; REVOKED → Revoked |
| Production deployment.status | RUNNING → Running; SUCCEEDED → Succeeded; UNKNOWN → Unknown outcome. No inferred Failed/Cancelled/Not deployed from missing records |
| Reconciliation approval.status (currently unsupported reader) | ACTIVE → Active; CONSUMED → Consumed; REVOKED → Revoked |
| Reconciliation record.outcome | SUCCEEDED → Succeeded; NOT_DEPLOYED → Not deployed; never erase the original deployment UNKNOWN/RUNNING history |

#### Approval families and deadlines

- Pipeline gates are immutable decisions with `decided_at`, approver and exact artifact binding. No TTL/pending-request row exists. Missing gate decision means “No recorded decision”, not a fabricated Pending approval card.
- Human task approval requests and decisions are separate entities. Preserve both decision and lifecycle, all candidate/hash bindings and real `expires_at`. REQUEST_CHANGES is not REJECTED, and ACTIVE is not automatically APPROVED. Existing R1 readers expose only the selected/latest request plus available decisions; do not claim a complete request history.
- Deployment/reconciliation approvals have real issued/expires timestamps in backend records, but no Dashboard-approved list/detail approval endpoint returns those records. Hide these collections; a known deployment's `approval_id` is not permission to fabricate an approval, owner, status or deadline.
- A real deadline can be displayed as timestamp. If a local countdown/elapsed hint is later approved, label it as an observation using `receivedAt` and the client clock; it must not persist expiry or replace PENDING/ACTIVE with an invented backend EXPIRED value. Prefer a server-supplied expiry observation when available through an approved reader. No countdown for records without a source deadline.

### Agent identity and metrics

| Concept | Source meaning | Permitted interpretation |
|---|---|---|
| Agent Profile | profile_id/principal_id/role/provider/model/target type/trust tier/is_active | Configured project profile. `is_active` is configuration, not live presence |
| Agent Instance | No matching Core HTTP entity/reader | Unsupported; no avatar implies online, staffing or recruitment |
| Planned assignment | TaskPlanLink.assigned_profile_id | A plan association; not an active lease or worker instance. Exact session link is mandatory |
| Approved external assignment | assignment_id, profile_snapshot/hash, worker_id, task_id | An immutable approved external target binding, not a live activity state. Never render target_locator/public_context/snapshot wholesale |
| Lease owner | TaskLeaseRecord.worker_id tied to lease_id/epoch/attempt/task | Owner of that lease snapshot. No inferred provider identity or profile join from matching strings |

Proposed replacement metrics:

- **Active assignments:** unsupported as a global/session metric. Assignment records have no active lifecycle, and plan links lack runtime status. Do not count assigned_profile_id as active work.
- **Active executions:** unsupported as a physical process metric; no authoritative collection/heartbeat reader provides it. If a session table is approved later, “Tasks reporting ExecutingInTarget” may be proposed separately as a snapshot count, never relabeled “running workers”. No dispatch SENDING/UNKNOWN inference.
- **Actual managed-model cost:** use returned `CostSessionRecord.cost_used_micro_usd` with label **Cost session usage**, exact cost_session_id and scope; for selected-session attribution require `costSession.pipeline_session_id === selectedSessionId`. Null/different session scope is shown as cost-session/project scope only or hidden from a session metric, never apportioned. Individual bundle ledgers are pipeline-filtered; do not add their amounts on top of cost-session totals, or equate estimates with invoices. Preserve `usage_estimated` and source provider/model where shown.
- **Cost-session budget:** supported field `session_cost_budget_micro_usd`; consumed is `cost_used_micro_usd`, proposed remaining is their exact difference in micro-USD, including negative overrun. Formula needs mapping approval; retain integers, reject unsafe numbers instead of rounding silently. No percentage utilization or live provider billing claim.
- **Project budget:** use the P2 projection defined above. Task budget remains unsupported. The legacy GET /budget can replay/write. Cost-session limits apply to their own scope.

### Evidence, activity facts and console navigation

Evidence v1 is approved resource metadata (IDs, kind, stage, version, SHA, creator, timestamp), not guessed downloads. Artifact content is escaped and size-controlled; it is not executable markup. There is no artifact download/expiry URL endpoint, so downloads and expired-object UX are unsupported. A 403/404 fetching metadata remains access-denied/not-found; do not mislabel it “expired artifact”. Do not construct URLs from artifact IDs, hashes, task workspace paths or repository locations.

A full audit/pipeline event feed is unsupported. Proposed limited timeline is explicitly **Recorded resource activity**, assembled only from already approved, authorized responses:

```
{id, type, timestamp, actor: {principalId}|null,
 projectId, sessionId|null, resourceRef: {kind,id},
 source: {endpoint,kind:"resource-fact"|"worker-event",sourceId,sourceField},
 receivedAt}
```

- Resource-fact types are literal descriptions such as artifact recorded (`artifact.created_at`), gate decision recorded (`gate.decided_at`), baseline frozen (`frozen_at`) or release acceptance recorded (`accepted_at`). They are presentation facts, not invented backend audit events. Current status + updated_at does not reconstruct a status-change history.
- Actor is the exact record creator/approver/worker field when its semantics are known; otherwise null/Unknown, not the current dashboard viewer. Timestamp is the backend event/fact time, never `receivedAt` substituted for a missing source time. Missing timestamp means the fact cannot enter chronological activity.
- Genuine `processedEvents` from a future approved lineage reader use original event_id/event_type/processed_at and a recorded actor only if provided. Do not relabel processing time as original guest wall-clock event time. R1 exclusion means no worker-event fetch in current R0 v1.
- Presentation `id` is the stable canonical tuple below, not a newly created backend event ID.
- Dedup resource facts by `(projectId,sessionId,resourceKind,resourceId,factKind)` across overlapping bundles, not by timestamp/title. Worker events dedup by project + original event_id. Distinct records with the same time remain distinct. Conflicting payloads for one identity are a data-conflict, not silent last-response-wins. Order by valid source UTC time then stable identity; preserve partial-data labels and `receivedAt` per source.
- Session facts must match selected session; project-only facts stay in a visibly project-scoped section. No automatic multi-session history join, pagination fiction, realtime or complete audit-trail claim. Large timeline/event history requires an approved paginated backend reader.

Existing GET console deep links may use verified IDs only: `/projects/{p}/pipeline-sessions`, `/projects/{p}/pipeline-sessions/{s}`, `/projects/{p}/agent-profiles`; conditional legacy detail views include `/projects/{p}/pipeline-sessions/{s}/m6b`, `/projects/{p}/pipeline-sessions/{s}/traceability`, `/projects/{p}/tasks/{t}/lineage`, `/projects/{p}/tasks/{t}/approval-center`. These are navigation references, not authorization, dashboard data endpoints or permission to prefetch R1 views. Preserve existing auth requirements; no tokens in URL. No GET web release-package page is advertised (existing web route is POST only). No Dashboard approval/execute/drag-and-drop actions or legacy mutation forms are embedded.
