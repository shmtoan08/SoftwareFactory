# Dashboard Slice 0 — Data Mapping Spec v1 (proposal)

Status: **PROPOSED, NOT APPROVED FOR UI IMPLEMENTATION**. [Issue #20](https://github.com/shmtoan08/SoftwareFactory/issues/20), source baseline `305796031ac2f063e20efcb1692f6bd72743c9bf`, 2026-11-14 (Asia/Tokyo). Read together with the [capability/read-only matrix](./api-capability-matrix.md). All display rules below require team approval, including unsupported items. No mappings or UI have been implemented in Slice 0.

## 1. Identity, session context and resource state

Authoritative relationships:

- `Project.project_id` is the tenant/project scope. There is no approved HTTP project detail/list reader; show verified project ID as context, not a fabricated project name. `ProductPipelineSessionRecord.title` is a session title only.
- `Project → ProductPipelineSessionRecord[]` is obtained from the sessions reader. A selected pipeline session is identified by `pipeline_session_id`, with original `status` and `current_stage`. It is not an entire project lifecycle.
- `ProductPipelineBundle.session`, `.artifacts`, `.approvalGates`, `.discoveryItems`, `.baselineFreeze` are session-scoped records. Validate returned project/session IDs against the requested context before presentation; mismatch is data-error, not a fallback to another project/session.
- Session work hierarchy is `milestones → epics(milestone_id) → stories(epic_id) → TaskPlanLink(story_id,task_id,pipeline_session_id) → TaskRecord`. The authoritative join is a link record, never task title or creation time. This data currently comes only through conditional R1 `m6b-bundle`; its table is unsupported until the read-only and scale decisions are resolved.
- `AgentOrganizationProfileRecord` belongs to a project, even if bundled with a session. `TaskPlanLink.assigned_profile_id` records planned assignment; `TaskExecutionAssignmentRecord` is the approved external assignment snapshot. `TaskLeaseRecord.worker_id` is a lease owner, not necessarily a profile principal. No Agent Instance entity or live presence endpoint exists.

Proposed default selection:

| Situation | Selection and presentation |
|---|---|
| Explicit session ID in dashboard URL | Fetch/validate it within the authorized project. Preserve 403/404/error; never silently choose another session |
| No explicit ID, exactly one returned ACTIVE session | Select it; show session ID/title/status/current_stage and selection reason |
| No explicit ID, more than one ACTIVE session | No automatic choice. Show the actual selectable session records and ambiguity message; no merged progress/cost |
| No ACTIVE sessions, other sessions exist | No automatic “latest”/“most complete” choice. Require explicit selection; list actual FROZEN/CANCELLED statuses |
| No sessions | Empty session context; do not synthesize a session/stages/tasks |
| Session list request denied/failed | Access-denied/error state, not “no sessions” and not “no active work” |

The session collection has no backend pagination/status filtering. It can support a returned-record selector, not an all-project aggregation or fabricated paged dataset. Large-list support remains unsupported; no hidden full-project scan/join may be added to work around it. Team must approve the selector's deployment/scale limits before Slice 1.

Changing session cancels/invalidates in-flight reads and cached projections for the old `(projectId,sessionId,authScope)` context. Late old responses must not populate the new session. Project-scoped panels carry a visible Project scope label; they are not silently aggregated into session metrics.

Each frontend resource envelope retains `source.endpoint`, `source.resourceType`, exact IDs and original payload/status, plus `fetchedAt` (client receipt time) separately from backend timestamps. The proposed adapter result states are `loading`, `ready`, `empty`, `error`, `access-denied`; capability `unsupported` is separate and hides the panel. 401 is authentication-required, 403 access-denied, 404 not-found (not an empty list), 409/422 precondition/data errors, 500/timeout error. `200 []` is empty. No auto-retry that could invoke work; refresh is explicit, independent per panel, with stale/error visibly retained if appropriate. No realtime claim.

## 2. Pipeline Progress — presentation facts, not project percentage

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

“Blocked” requires a backend-confirmed blocker and a resource ref/reason. No TaskStatus currently equals Blocked. ManualIntervention, ReworkRequired, missing artifacts, dependency edges, timeouts and model failures are not automatically blocked. The mutating scheduler cannot be invoked to discover rejection reasons; budget/pause panels are excluded because their GET may recover/write.

## 3. Complete source-to-display mappings at this baseline

Every badge retains `resourceType`, `sourceField`, **sourceStatus** (unaltered), **displayStatus** (presentation only), source IDs and endpoint. Unknown/missing/wrong-type values produce `displayStatus=Unknown`, preserve safe original source data for diagnosis and do not coerce to To Do/Done/Blocked. Plain-text rendering must escape all source content. The tables are presentation proposals, not additions to backend enums or proof that conditional/unsupported endpoints are approved.

### TaskStatus (all 11 values)

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

### Other status domains (every literal in each relevant source enum)

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

### Approval families and deadlines

- Pipeline gates are immutable decisions with `decided_at`, approver and exact artifact binding. No TTL/pending-request row exists. Missing gate decision means “No recorded decision”, not a fabricated Pending approval card.
- Human task approval requests and decisions are separate entities. Preserve both decision and lifecycle, all candidate/hash bindings and real `expires_at`. REQUEST_CHANGES is not REJECTED, and ACTIVE is not automatically APPROVED. Existing R1 readers expose only the selected/latest request plus available decisions; do not claim a complete request history.
- Deployment/reconciliation approvals have real issued/expires timestamps in backend records, but no Dashboard-approved list/detail approval endpoint returns those records. Hide these collections; a known deployment's `approval_id` is not permission to fabricate an approval, owner, status or deadline.
- A real deadline can be displayed as timestamp. If a local countdown/elapsed hint is later approved, label it as an observation using fetchedAt/client clock; it must not persist expiry or replace PENDING/ACTIVE with an invented backend EXPIRED value. Prefer a server-supplied expiry observation when available through an approved reader. No countdown for records without a source deadline.

## 4. Agent identity and metrics

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
- **Project/task budget:** unsupported; GET /budget can replay/write. Do not reuse cost-session limits as project limits. Zero is displayed only when returned; missing/null/error is never zero.

## 5. Evidence, activity facts and console navigation

Evidence v1 is approved resource metadata (IDs, kind, stage, version, SHA, creator, timestamp), not guessed downloads. Artifact content is escaped and size-controlled; it is not executable markup. There is no artifact download/expiry URL endpoint, so downloads and expired-object UX are unsupported. A 403/404 fetching metadata remains access-denied/not-found; do not mislabel it “expired artifact”. Do not construct URLs from artifact IDs, hashes, task workspace paths or repository locations.

A full audit/pipeline event feed is unsupported. Proposed limited timeline is explicitly **Recorded resource activity**, assembled only from already approved, authorized responses:

```
{id, type, timestamp, actor: {principalId}|null,
 projectId, sessionId|null, resourceRef: {kind,id},
 source: {endpoint,kind:"resource-fact"|"worker-event",sourceId,sourceField},
 fetchedAt}
```

- Resource-fact types are literal descriptions such as artifact recorded (`artifact.created_at`), gate decision recorded (`gate.decided_at`), baseline frozen (`frozen_at`) or release acceptance recorded (`accepted_at`). They are presentation facts, not invented backend audit events. Current status + updated_at does not reconstruct a status-change history.
- Actor is the exact record creator/approver/worker field when its semantics are known; otherwise null/Unknown, not the current dashboard viewer. Timestamp is the backend event/fact time, never fetchedAt substituted for a missing source time. Missing timestamp means the fact cannot enter chronological activity.
- Genuine `processedEvents` from a future approved lineage reader use original event_id/event_type/processed_at and a recorded actor only if provided. Do not relabel processing time as original guest wall-clock event time. R1 exclusion means no worker-event fetch in current R0 v1.
- Presentation `id` is the stable canonical tuple below, not a newly created backend event ID.
- Dedup resource facts by `(projectId,sessionId,resourceKind,resourceId,factKind)` across overlapping bundles, not by timestamp/title. Worker events dedup by project + original event_id. Distinct records with the same time remain distinct. Conflicting payloads for one identity are a data-conflict, not silent last-response-wins. Order by valid source UTC time then stable identity; preserve partial-data labels and fetchedAt per source.
- Session facts must match selected session; project-only facts stay in a visibly project-scoped section. No automatic multi-session history join, pagination fiction, realtime or complete audit-trail claim. Large timeline/event history requires an approved paginated backend reader.

Existing GET console deep links may use verified IDs only: `/projects/{p}/pipeline-sessions`, `/projects/{p}/pipeline-sessions/{s}`, `/projects/{p}/agent-profiles`; conditional legacy detail views include `/projects/{p}/pipeline-sessions/{s}/m6b`, `/projects/{p}/pipeline-sessions/{s}/traceability`, `/projects/{p}/tasks/{t}/lineage`, `/projects/{p}/tasks/{t}/approval-center`. These are navigation references, not authorization, dashboard data endpoints or permission to prefetch R1 views. Preserve existing auth requirements; no tokens in URL. No GET web release-package page is advertised (existing web route is POST only). No Dashboard approval/execute/drag-and-drop actions or legacy mutation forms are embedded.

## 6. Future frontend boundaries and verification plan

After approval, implementation stays in apps/web:

1. UI-independent data client: fixed approved R0 Core HTTP readers, existing auth boundary, deadline/cancellation, per-resource errors and source/fetchedAt. Shared with a future 3D mode; no demo entity generator or migration.
2. Pure mapping layer: scoped identity checks, explicit status tables, session selection, source-bound stage facts and timeline dedup. Mapping rules are unit tested; raw payload is not rewritten.
3. Components/routes: render mapping output only, with independent loading/empty/error/access-denied behavior, hidden unsupported panels and explicit manual refresh. Existing console routes remain available and unchanged.

Required Slice 1–3 cases (not claimed executed in this docs-only slice): no sessions; multiple ACTIVE sessions; no ACTIVE sessions; explicit missing/forbidden session; unknown session status including FAILED; recorded provider failure without changing session.status; artifact-version retry and gate binding conflicts; task attempt/lease retry preservation; human rejection/request-changes/expiry/stale invalidation; artifact/metadata 403/404 with downloads unsupported; API 401/403/404/422/500/timeout; malformed/unsafe numeric/ID data; late cross-session responses; duplicate and conflicting timeline facts; missing cost scope; cost overruns; R1/unsupported panels causing zero API requests; forbidden GET /budget causing zero requests; no POST/PUT/PATCH/DELETE; no model/lease/reconciliation activity; console route regressions.

Before Slice 1, team must approve the capability matrix and this mapping, confirm all unsupported panels and session-selector scale behavior, and decide any separately requested safe API projections. Issue #20 explicitly requires that review; this proposal is ready for that decision, not a claim that the Dashboard has shipped.

API-gap decisions are tracked in [issue #21](https://github.com/shmtoan08/SoftwareFactory/issues/21); no API change is approved or implemented by opening that issue.
