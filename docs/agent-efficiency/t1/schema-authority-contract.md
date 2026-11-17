# T1 — Telemetry schema and authority contract for review

Date: 2026-11-17 (Asia/Tokyo). Source baseline: `30a1430bde371a223d047b4908664dce2d69971d`. Tracker: [issue #23](https://github.com/shmtoan08/SoftwareFactory/issues/23). Prerequisite: [Kit accepted T0 revision 2](https://github.com/shmtoan08/SoftwareFactory/commit/30a1430bde371a223d047b4908664dce2d69971d#commitcomment-210451522), under the owner's conditional approval. Normative collection semantics: [T0 revision 2](../slice-0/telemetry-collection-proposal.md).

**PROPOSED CONTRACT — NOT IMPLEMENTED OR AUTHORIZED FOR LIVE COLLECTION.** Team approval of this document must explicitly select the implementation scope below. This commit adds no migration, role, API, provider hook, template, retention job or paid call. T1 builds provider-free observation mechanics; T2 needs separate owner spending approval. Zero representative real samples and null S/M/L token budgets remain accurate.

## 1. Source findings and implementation boundary

Current `ModelCallLedgerRecord` has task/pipeline/cost-session and normalized totals, but no authoritative execution/generation or cached/thinking split. `ModelCallOrchestrator` in adapter-sdk performs preflight before provider invocation and finalizes a ledger afterward; memory finalization allocates call IDs internally. A ledger call ID therefore cannot simply be assumed durable before dispatch. PromptRegistry currently fingerprints templates with SHA-256; new telemetry must not export that sensitive hash. Existing RLS session variables are useful scope controls but are not proof that an agent has service authority.

T1 introduces an independent server invocation ID allocated before the provider call, then an explicit service-owned settlement link to the final ledger call ID. It does not repurpose a ledger ID or infer links by task/time. A crash between dispatch and finalization leaves an unsettled invocation and an incomplete lifecycle. Nothing retries the provider to repair that gap.

Two deliverables have different eligibility:

- **T1-A:** service invocation inventory, sanitized usage observations, explicit ledger links, call-level canonical normalization, role isolation and reconciliation. Calls lacking independently verified execution context remain call-level.
- **T1-B:** task attribution/lifecycle eligibility, only for a service-mediated execution path that can prove current generation at creation. Add no new coding/reviewer execution route as a telemetry shortcut. If the existing path cannot supply that authority, deliver its gap and keep task-level enrollment disabled. T1-A passing does not imply S0-B/T2 task baseline readiness.

Checkpoint/memo, dirty-tree fingerprints, first meaningful action, takeover token formats, local L0/L1/L2 tokenization, prompt optimization and workload scheduling remain outside T1. Use existing execution identity/lease generation where proven; introduce no new generation ownership algorithm in this slice.

## 2. Proposed relational schema

All new tables are owned by a non-login migration owner, FORCE ROW LEVEL SECURITY, with `project_id UUID NOT NULL`. IDs are UUIDs; timestamps are TIMESTAMPTZ. Composite foreign keys include project scope. No polymorphic JSON authority fields. Text identifiers have explicit length bounds (normally 128 bytes); protected references up to 256 bytes; numeric counters are NUMERIC(30,0), nonnegative, serialized as decimal strings. Values exceeding bounds become unavailable, never rounded. Schema/version enum changes require review.

| New table | Fields and invariants | Indexes / lifecycle |
|---|---|---|
| telemetry_lifecycles | lifecycle_id, project_id, task_id, manifest_id, created_at; UNIQUE(project_id,task_id), UNIQUE(project_id,lifecycle_id) | FK(project,task); one root per task. Cross-task families excluded until a separately approved relationship exists |
| telemetry_cohort_manifests | manifest_id, project_id, contract_ref_hmac, key_version, task_size S/M/L/unclassified, planned_file_count, planned_package_count, five risk booleans, operator_principal, approved_at, source_sha, manifest_version | Append-only; binds the T0 pre-run rubric. No raw task contract or post-spend relabel |
| telemetry_lifecycle_events | event_id, project_id, lifecycle_id, sequence, kind OPEN/AMEND/CLOSE/REOPEN/CENSOR, outcome nullable, service_actor_ref, observed_at, cutoff_at nullable, prior_event_digest, event_digest | UNIQUE(project,lifecycle,sequence); append-only. CLOSE requires reconciled settlement proof; CENSOR is reporting only, never workflow closure |
| telemetry_invocations | invocation_id, project_id, lifecycle_id nullable, task_id nullable, cost_session_id, pipeline_session_id nullable, binding_state TASK_BOUND/CALL_ONLY, execution_id nullable, lease_id nullable, lease_epoch nullable, generation_ref nullable, binding_reason enum, provider, model, prompt_id, prompt_version, prompt_hmac_ref, key_version, mapping_id, created_at, binding_digest | UNIQUE(project,invocation); composite FKs for known task/session/lease; TASK_BOUND requires all execution authority fields, verified lease/task/epoch and lifecycle; immutable after creation |
| telemetry_observations | observation_id, project_id, invocation_id, revision, kind USAGE/PARTIAL/FAILURE, observed_at, canonical_status, canonical_input/output/total nullable, cache_read/write/uncached/reasoning nullable, reasoning_inclusion enum, reported_total nullable, billed_amount/currency nullable, calculated_micro_usd nullable, pricing_version nullable, normalized_error nullable, missing_reason enum, numeric_usage JSONB, mapping_revision, provenance enum, content_digest | UNIQUE(project,invocation,kind,revision); append-only. JSON object <=8 KiB with mapping-specific numeric keys only; event <=16 KiB. Canonical total only with available validated mapping and complete reconciled components |
| telemetry_settlements | settlement_id, project_id, invocation_id, ledger_call_id, recorded_at, ledger_outcome, settlement_digest | UNIQUE(project,invocation), UNIQUE(project,ledger_call_id); append-only explicit link, same task/session/provider/model/prompt identity verified against ledger |
| telemetry_quality_events | event_id, project_id, invocation_id nullable, lifecycle_id nullable, category enum, observed_at, conflict_digest nullable | Append-only normalized coverage/conflict markers. No raw exception, SQL or provider payload |
| telemetry_reports | report_id, project_id, cutoff_at, manifest_version, mapping_versions, report_digest, aggregate_json, supersedes_report_id nullable, finalized_at | Append-only bounded aggregates; includes complete/incomplete/censored denominators and sample IDs through protected report membership, never raw prompts |

`telemetry_report_members` associates report/project/lifecycle/event watermark with outcome and eligibility reason, unique per report/root. It allows reproducible reopening revisions without double counting. No aggregates are trusted from an agent-provided report body: the reporting service derives them from eligible source records.

Required indexes: invocations(project,lifecycle,created_at), settlements(project,invocation), observations(project,invocation,revision), lifecycle_events(project,lifecycle,sequence), quality_events(project,observed_at), reports(project,cutoff_at); uniqueness indexes above are additional. Avoid globally unscoped read indexes as a substitute for authorization. Explain/bounded scale tests accompany the migration. No change to existing task status enums, task contract JSON, reservation/Cost Guard semantics or ledger fields is proposed. Ledger settlement uses its existing primary key plus service/DB validation of project and identity; if a composite FK requires a new ledger unique index, that exact index must be included in the reviewed migration diff, not assumed existing.

Missingness is derived from expected invocations minus valid settlements/observations, not solely quality-event rows. A failure to write a quality event cannot make coverage green. An observation inventory cannot detect a call that bypassed its creation hook. Therefore T1 must prove complete mediation of every chargeable path in an enrolled lifecycle, including failures before ledger finalization, using an independently authoritative dispatch/in-flight inventory. If that inventory does not exist or cannot be reconciled without changing execution, report the gap and keep task-level enrollment disabled; adding a mandatory dispatch journal requires separate approval. A missing lifecycle manifest, observer outage or unproved enrollment boundary excludes that lifecycle even if some calls look complete. Historical rows are never backfilled into TASK_BOUND from task IDs/timestamps.

## 3. Database and service authority

| Principal | Allowed | Denied |
|---|---|---|
| migration owner (non-login) | Approved DDL and function ownership | Runtime credentials or provider calls |
| telemetry_ingestor service login | Execute narrowly typed creation/append/settlement functions through private authenticated service boundary | Direct table INSERT/UPDATE/DELETE, arbitrary SQL authority, deciding task/generation from client text |
| telemetry_reporter service login | Project-scoped SELECT and execute deterministic report publication | Invocation/usage writes, lease/task changes, public arbitrary query endpoint |
| operator lifecycle service | Execute pre-run manifest and closure/reopen functions after existing authenticated operator/project checks | Changing historical labels or forging provider counters |
| existing app_runtime / worker / agent / anonymous | No new telemetry grants or writer functions | SET ROLE into telemetry roles, schema/table reads/writes and observation submission |
| future retention operator | No grant in T1 | Any deletion, especially ledger/security evidence |

New roles are not members of existing app_runtime and existing app_runtime is not a member of them. Role login secrets stay in operator secret storage, never task environments. Functions must check both the database principal and verified project binding; client-set RLS GUCs alone do not confer authority. A worker bearer token must never authenticate as telemetry_ingestor. Private service transport is authenticated with service credentials bound to environment/project allowlist; no public worker-facing telemetry HTTP endpoint is added.

If SECURITY DEFINER is required for restricted inserts, use a dedicated non-login function owner with minimal grants, fixed `search_path=pg_catalog` and fully qualified objects. Revoke EXECUTE from PUBLIC; prohibit dynamic SQL and caller-selected identifiers/functions. RLS, same-project predicates and composite relationships are enforced inside each function. Functions return bounded codes only. Test direct SQL as app_runtime, altered GUCs and role escalation attempts, not only mock service calls.

Mapping manifests are immutable server configuration signed/versioned by operator and reviewed before installation. Worker messages cannot switch mappings, price versions, prompts or canonical eligibility. All mappings start UNVERIFIED. Template HMAC keys are separate from auth/cursor keys, domain-separated by environment/project/purpose, with key version and rotation plan; old keys needed to verify retained evidence remain protected for its retention period.

## 4. Creation, fencing and noninterference protocol

1. Existing execution/provider authorization and Cost Guard preflight run with unchanged outcomes. The server allocates an invocation ID and derives scope from authenticated service context, never an agent-supplied task/generation assertion.
2. For TASK_BOUND eligibility, a trusted binding observer validates the authoritative active lease/task/execution identity under the same row-lock/CAS discipline as existing lease transfer. Read-only inspection of a task ID is insufficient. No lease renewal, generation change or scheduling mutation is permitted. Registration linearizes at the successful validation plus invocation insert commit; takeover before it denies old TASK_BOUND registration, takeover after it leaves an immutable historical binding.
3. Observer lock contention/storage faults must not block or fail ordinary execution. Use a dedicated connection and bounded best-effort observation budget, proposed 50 ms lock/100 ms total with no retry on the execution path; failure yields CALL_ONLY/incomplete eligibility when recordable. These are proposed observer bounds for review and load testing, not changes to the existing execution timeout. Existing execution's own admission/fencing remains authoritative even when the observer is unavailable. No claim that telemetry itself fences dispatch is allowed.
4. After registration commit, provider invocation proceeds through the existing authorized path. A takeover may happen between registration and network send: existing runtime admission decides whether sending is allowed; any actual late usage remains bound to the original invocation, never reattributed. No telemetry receipt can authorize execution or validate a new generation.
5. Provider adapter emits only sanitized immutable numeric events to a bounded observer queue. Completion supplies the finalized ledger ID explicitly through the server call closure. Late responses are settled by trusted service authority under the old binding. Stale workers cannot create new bindings or submit current-generation receipts.
6. Reconciler joins explicit invocation/ledger IDs and checks identity, terminal usage, mapping, conflict/coverage status. A crash, missing record or disagreement makes the lifecycle incomplete. It never invokes a provider, retries a chargeable operation or changes business state.

T1 must prove that the selected existing execution path exposes a suitable authority boundary. If it does not, TASK_BOUND stays disabled and the implementation report states that limitation; designing a new dispatcher or takeover mechanism requires separate approval. This resolves the difference between observer-only semantics and authoritative binding without silently changing execution.

## 5. Internal interfaces and explicit core-change scope requested

These are proposed interfaces, not code introduced by this commit:

- `beginObservation(verifiedServiceCallContext): ObservationHandle | UnavailableHandle` — server-only, derives typed binding; no arbitrary identity claims at an external boundary.
- `recordUsage(handle, sanitizedProviderUsageEvent): void` — bounded nonthrowing enqueue; no untrusted raw response parameter in persistence interfaces.
- `linkLedger(handle, finalizedLedgerId): void` — explicit invocation closure, subject to identity checks; partial/failure paths must link actual finalization where it exists.
- `reconcileLifecycle(projectId,lifecycleId,cutoff): EligibilityReport` — deterministic, read-only until publishing an append-only report/event through a separate service operation.

Requested implementation ownership: database package for schema/DAO/functions/reconciliation; adapter-sdk model orchestrator/provider normalization for optional observer hooks at server creation and explicit ledger finalization; trusted gateway/core service composition for deriving context and injecting service-only hooks; test-harness for memory/real PG/HTTP-auth negatives. Shared-types may receive telemetry-specific types only if the approved implementation task_contract names those changes; otherwise keep types in a dedicated telemetry module with explicit imports. Existing Cost Guard interfaces/results, TaskRecord/TaskStatus and task-contract schema are unchanged. Optional observers must default to disabled, and observer exceptions must never replace provider/Cost Guard results or errors. No browser/worker client accepts an ObservationHandle as authority.

The team must approve these adapter-sdk/core signature touches explicitly before code. This document is the requested scope decision, not authorization inferred from a general application task. T1-A hooks cannot assert task binding where trusted context is absent.

## 6. Usage matrix, errors and limits

The T0 numeric schemas and canonical equations remain normative. The T1 implementation must deliver a checked-in mapping matrix for the exact Anthropic/Google candidate model, endpoint/version and stream mode with primary provider references and executable fixtures. This contract does not assert current provider accounting or availability. Cached subset versus additive and thinking inclusion must be proved independently; UNVERIFIED yields canonical unavailable. Include over-safe-integer cases, missing totals, partial streams, cumulative snapshots and duplicate/delta sequences. Local tokenizer counts are outside this contract.

Allowed normalized errors initially: provider-timeout, provider-rate-limited, provider-rejected, transport-failure, usage-missing, mapping-unverified, attribution-incomplete, observer-persist-failed, observer-overflow, conflicting-observation, ledger-link-mismatch. Adding enum values requires version review. No free-text error details, stack traces, raw responses or plain prompt/request hashes in telemetry.

Proposed queue maximum: 1,024 events / 16 MiB per service process, whichever is reached first; flush batch <=100 events, max 3 background delivery attempts with bounded backoff within 60 seconds. These retry **only sanitized observation writes**, never model requests. Overflow/persist failure produces best-effort normalized health counters; independent enrollment/ledger inventory marks the affected window incomplete even if markers are lost. Reporting pages <=100 records, queries <=2 seconds, response <=1 MiB; aggregation jobs use explicit project/cutoff and bounded batches. Runtime instrumentation overhead must be measured before pilot; no claims of constant scan cost.

## 7. Lifecycle and retention

Retain the accepted T0 numbers explicitly: **details 90 days after final lifecycle closure/settlement; aggregates 365 days after finalized report cut-off**. Reopen resets the detailed clock to final settlement and preserves old segments; day-30 censoring does not close a workflow or start detail expiry. T1 records retention anchors/holds but implements no deletion grants/job. ModelCallLedger/security/audit evidence remain outside telemetry deletion scope.

Manifest size S <=1 package/5 files, M <=3 packages/20 files excluding S, L above those bounds, unclassified when unbounded; risk is independent. Operator locks the manifest before chargeable execution. Proposed enrollment requires explicit expected-call boundary coverage; no retroactive labels. Scope amendments retain original classification with deviation evidence.

A close event requires terminal disposition plus no linked unsettled invocation/execution/retry/rework and no coverage gap. MergedAndCompleted is success; ManualIntervention remains hold. Failed/abandoned/cancelled terminal dispositions require explicit operator/workflow authority, not new TaskStatus values. Reopen appends a segment under the same root and supersedes affected reports. A report at 30 days from first chargeable call includes unsettled roots as censored/incomplete; no indefinitely blocked T3 and no duplicate reopened samples. Separate outcome/model/mapping strata retain missingness and sample denominators.

## 8. Rollout, migration and pilot gates

Deliver implementation in reviewable stages: (A) isolated schema/roles and negative tests; (B) disabled optional observation hooks and provider-free normalization; (C) reconciler/lifecycle reports and generation race tests; (D) measured authority/coverage readiness report. Every stage gets exact-source CI and review. Migrations add only the approved telemetry objects plus an explicitly reviewed ledger FK index if needed. Backfill none of the old ledger rows as verified task samples. Rolling deployment tolerates missing telemetry schema by disabling observation/marking enrollment unavailable while keeping existing execution behavior. Kill switch disables observation enrollment/hooks; preserve evidence, never roll back business calls or delete ledgers.

Two pilot prompt aliases from T0 remain **disabled/unregistered** unless separately approved existing template equivalence and exact protected fingerprint are supplied. T1 does not implement developer/reviewer prompts or an execution flow to make them work. Model/account availability, verified mapping and provider model revision must be checked before T2; no alias fallback. Owner Huynh's separate approval must bind project/environment/accounts/source/model/prompt/mapping, proposed USD10 combined cap and exact seven-day UTC window. Existing spending boundary must enforce that cap independently of telemetry or T2 cannot start. T1 success alone grants no live calls, threshold or S0-B tick.

## 9. Acceptance matrix and decisions requested

| Test group | Required evidence before T1 acceptance |
|---|---|
| Schema/RLS | Real PG16/17 cross-project FK/read/write denial, app_runtime/worker privilege and GUC spoof tests, immutable updates/deletes denied, function ownership/search_path/EXECUTE audit, clean migration/upgrade and unchanged legacy behavior |
| Creation/fencing | Real concurrent creation versus takeover in both orders; stale binding rejected; pre-transfer admitted call settles only to original generation; unproved context CALL_ONLY; no current-generation receipt forged |
| Observer isolation | DB down/lock contention/queue overflow/throw/crash; same business result/reservation/lease/provider invocation count with observer off/on; no paid-action retry; bounded overhead; missing failure marker still detected |
| Ledger identity | Explicit final call link on allowed/blocked/provider failure/validation failure paths; mismatch/conflict denied; crash before finalization incomplete, never inferred by timestamp |
| Canonical usage | Exact integers, cache/thinking inclusion proofs, unavailable mappings, partial/missing usage, repeated cumulative and true delta streams, duplicates/conflicts; no estimated usage accepted as actual |
| Lifecycle | Locked size/risk, scope deviations, terminal with dangling work remains incomplete, cancelled/abandoned outcomes, reopening no double sample, day-30 censoring with full denominators |
| Privacy | Strict numeric schema/error enum, secret canaries in provider errors/unknown fields excluded from persistence/log/export; HMAC isolation/rotation/access; no plain sensitive prompt fingerprint export |
| Scale/reporting | Query EXPLAIN and bounded multi-project fixtures, deterministic cut-off/watermark reports, complete versus censored totals, canonical null versus zero, queue/load/overhead measurements |
| Rollout | Disabled-by-default behavior, absent schema/old service compatibility, kill switch and retained evidence; no T2 activation or provider credential use |

Team decisions requested: approve/adjust the proposed tables/indexes and role isolation; the server invocation ID plus explicit settlement link; bounded observer binding protocol with TASK_BOUND disabled where authority cannot be proved; the exact adapter-sdk/service hook scope; numeric/event/queue/report bounds; and the staged provider-free acceptance plan. Acceptance must be recorded on #23 before implementation. Remaining mapping/template/account evidence is an explicit later gate, not a blank permission to implement an execution flow.

After approval, dev writes the scoped implementation task_contract and implements only approved T1 stages. Actual task baseline and S/M/L token budgets remain T3 deliverables.
