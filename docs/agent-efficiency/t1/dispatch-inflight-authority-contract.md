# T1-E proposal — authoritative dispatch and in-flight inventory

Revision 2, 2026-11-23 (Asia/Tokyo). Baseline: main `b89b997`. [Owner decision and ten conditions](https://github.com/shmtoan08/SoftwareFactory/issues/23#issuecomment-7040509221).

**CONDITIONALLY APPROVED DIRECTION — REVISION AWAITING KIT RE-REVIEW.** E1 starts after Kit accepts this revision under the recorded owner decision. Stage D's `NOT READY` verdict governs `TASK_BOUND`, lifecycle `CLOSE` and production enrollment. T2, spending, live credentials, prompt aliases and mapping promotion require separate approvals.

## 1. Decision requested

Approve, adjust or reject one authoritative boundary for future enrolled lifecycles:

1. Every potentially chargeable provider attempt requires a durable service-owned `DISPATCH_STARTED` commit before any provider transport operation.
2. Dispatch-start validates the active project, task, execution, lease epoch and generation under the same row-lock and compare-and-swap (CAS) discipline as lease transfer. Authority derives from authenticated server context and current database state.
3. A route that cannot participate in this boundary is ineligible and must be rejected for an enrolled lifecycle before it can spend. Non-enrolled legacy operation remains call-level and cannot enter the T1 baseline.
4. Journal failure changes enrolled execution behavior by denying the new dispatch. This mandatory fail-closed boundary is intentionally different from the existing best-effort observer and therefore requires explicit approval.

Existing scheduler and lease authority govern execution. The journal gates a single provider transport handoff within that authority.

## 2. Route eligibility matrix

| Known surface | Proposed enrolled policy | Required change before eligibility |
|---|---|---|
| `ManagedModelProviderExecutor` structured execution | Sole candidate for E2 | Require a managed send capability and settle the exact attempt and ledger |
| Independent live review calling `client.complete` directly | Ineligible as-is | Route through the same managed boundary or reject it inside an enrolled lifecycle; review independence semantics must remain unchanged |
| Workspace coding adapter calling `modelClient.complete` directly | Ineligible as-is | Route the supervisor-side call through the managed boundary or reject enrolled use; no provider key enters the sandbox |
| Claude Code CLI | Ineligible | One CLI process may hide multiple provider calls and supplies no trusted per-call Cost Guard/dispatch receipts; do not infer calls from process lifetime or output |
| Codex CLI | Production remains blocked | Existing `ERR_UNMETERED_CODEX_DISABLED` remains; emulator is provider-free test evidence only |
| Background workers, future adapters and new provider clients | Deny by default | Classify the route and prove managed enforcement before granting enrolled use |

Enforcement has two layers. CI classifies provider transport sites, client calls and process launch routes, including generic adapter entry points. The runtime derives enrollment from authoritative task/execution context and denies ineligible routes at scheduling or invocation and at the provider egress or process boundary before external side effects. Enrolled executions receive only a private managed dispatch capability, with provider credentials and provider egress restricted to that boundary. Direct clients, CLI, review, workspace and background paths cannot obtain the capability through request flags or by omitting lifecycle context. If any route or deployment cannot enforce this, enrollment stays unavailable. The static inventory alone is an audit aid.

## 3. Attempt identity and Cost Guard protocol

The exact migration DDL is deferred until this contract is approved. A later schema proposal must use isolated telemetry ownership, FORCE RLS and composite project keys, and model at least:

| Identity | Binding |
|---|---|
| Logical invocation | Server-owned request identity under a project/lifecycle. May group multiple attempts under a future reviewed retry policy. |
| Chargeable attempt | Server-generated attempt ID and ordinal within the logical invocation. Immutable binding includes execution, task, lease ID/epoch, generation, route version, cost and pipeline sessions, provider/model and protected prompt reference. At most one transport handoff per attempt. |
| Cost Guard reservation | Immutable reservation ID and allocation bound to one attempt. Each potentially chargeable retry or fallback requires its own reservation. |
| Finalized ledger call | At most one exact business ledger ID per attempt, unique within the project across attempts. Settlement matches reservation, attempt, session, provider/model and protected template evidence. A blocked admission ledger is separate from a started attempt. |

An optional telemetry invocation/observation link is per attempt and separate from the logical invocation identity. The journal derives expected attempts independently of observer delivery. Dispatch events are append-only with server-derived sequence, actor, timestamp and digest.

**Selected option (b): two transactions for reservation and prepare.** The current PostgreSQL preflight returns an admission decision and session on success. E1 must introduce the durable reservation contract under Cost Guard ownership for enrolled calls.

1. **Reserve.** Cost Guard atomically checks budgets and records an `ACTIVE` reservation with immutable ID, proposed attempt identity, allocation and server expiry. Admission includes outstanding holds in the budget check. Denial follows the existing blocked-ledger flow. Commit the reservation before opening the prepare transaction.
2. **Prepare.** Lock the reservation, validate scope and current authority, and attach it exclusively to the attempt while recording `PREPARED` atomically. Require an unexpired active reservation. Reserve and prepare commit independently.
3. **Dispatch-start.** In a subsequent transaction, lock the same lease/task authority used by takeover and lock the attempt and reservation under an explicit consistent lock order. Revalidate generation, expiry, eligibility and unused start, then append `DISPATCH_STARTED` and move the reservation to `HELD_FOR_SETTLEMENT` atomically. Its durable commit is the authorization linearization point. Before acknowledged commit success, transport call count is zero. If the commit acknowledgement is lost, the caller denies transport and reconciliation checks durable state. A committed start remains potentially charged.
4. **Recovery and accounting.** Before a durable start, expiry recovery locks the same reservation and attempt state as dispatch-start, revokes the ability to start, and releases an orphan or prepared reservation only after transactionally verifying the absence of a start. An uncertain read or lock loss leaves the hold in place. After durable start, expiry alone cannot release the hold. Cost Guard converts the hold to finalized accounting at most once against the exact ledger. Accounting recognizes an already committed conversion during recovery and avoids counting both the hold and finalized ledger.
5. **Settlement.** Append the exact ledger link and `TERMINAL` in one journal transaction after verifying the finalized ledger and protected HMAC. A committed ledger without the terminal record remains incomplete. Reconciliation can append that link from durable exact-ID evidence and never repeats transport. Late verified settlement attaches only to the original generation.

Takeover and dispatch-start serialize on the same authority lock/CAS. Takeover committed first denies the stale attempt. Dispatch-start committed first authorizes the original attempt, so transport handoff may occur after takeover. The journal cannot fence an already authorized external handoff.

## 4. Authority, privacy and noninterference

- Only a dedicated non-login function owner and a private authenticated dispatch service role may create records. `app_runtime`, workers, agents, browser clients, observer transport and worker bearer tokens receive no journal grants.
- Project binding derives from a service-principal registry and authenticated server context. Client-set RLS GUCs are insufficient; membership in `app_runtime` invalidates dispatch authority.
- All writer functions use fixed `search_path=pg_catalog`, fully qualified objects, bounded typed parameters, no dynamic SQL and no caller-supplied actor/timestamp/digest.
- Protected HMAC verification must use the approved service key context and exact ledger template fingerprint. Plain prompt/request hashes, content, raw provider payloads, credentials and free-text errors never enter the journal or its readers.
- Journal persistence is mandatory only for an explicitly enrolled lifecycle. Journal/authority failure denies that new provider dispatch with a stable error before spending; it must not cancel or roll back an already dispatched business call.
- Reconciliation is read-only with respect to execution, leases and provider activity. It never repairs evidence by calling a model.

## 5. Idempotency, takeover and crash rules

- Enforce DB uniqueness on `(project_id, attempt_id)` and `(project_id, logical_invocation_id, attempt_ordinal)`. Reserve and prepare replay in the current generation return the original receipt only on exact immutable binding match. Changed binding conflicts, and stale or cross-generation replay rejects before returning a receipt. Takeover does not reset attempt ordinals or permit an ambiguous attempt to be replayed as a fresh send.
- Only the live caller that wins the start CAS and receives its commit acknowledgement may consume a single-use in-process send permit. Duplicate starts and receipt lookups return evidence only. Restart, lost acknowledgement, or permit loss requires reconciliation. Journal idempotency provides no upstream provider idempotency guarantee.
- E2 permits a single request, including consumption of one continuous stream if supported on that route. Disable SDK/client and HTTP retries, redirects that reissue a request, stream reconnect/resume, and automatic model/provider fallback for enrolled calls. Block clients or egress paths where these behaviors cannot be controlled. Interrupted streaming preserves verified partial usage and leaves settlement incomplete where evidence is missing. A future reviewed policy requires separate ordinal, attempt ID, reservation and start for every potentially chargeable retry, reconnect or fallback.
- Historical CALL_ONLY evidence remains call-level. Task IDs and timestamps cannot establish a dispatch or settlement link.

| Derived outcome | Required evidence |
|---|---|
| `CONFIRMED_NOT_SENT` | Start was durably prevented under the start/expiry lock discipline, or separately approved authoritative evidence proves no handoff and no charge exposure. |
| `UNKNOWN` | Start committed or may have committed and no verified evidence resolves handoff. Includes crash, lost acknowledgement and transport timeout without stronger evidence. Preserve the accounting hold until verified resolution. |
| `CONFIRMED_SENT` | Verified transport/provider evidence of send exists, including a response or observed stream usage. Billing and settlement may remain unresolved. |
| `SETTLED` | Exact finalized ledger and verified terminal link resolve the attempt. Lifecycle completeness additionally requires usage, mapping, template binding and workflow evidence. |

Operators may append only approved evidence with authenticated actor, provenance and a protected reference. Timeout, absent observer data and operator assertion alone cannot resolve unknown to zero charge. Reconciliation marks missing or conflicting evidence incomplete.

Stable proposed error classes are `DISPATCH_STORE_UNAVAILABLE` for storage failure (including ambiguous commit), `DISPATCH_FENCE_REJECTED` for lease/lock/CAS failure, `DISPATCH_AUTHORITY_DENIED` for identity or route denial, `DISPATCH_RESERVATION_INVALID` for invalid or expired holds, and `DISPATCH_BINDING_CONFLICT` for changed replay. These deny transport before authorization. Provider failures keep their own classification. After possible handoff, use `DISPATCH_OUTCOME_UNKNOWN` when send evidence is absent and `DISPATCH_SETTLEMENT_PENDING` when send is confirmed but accounting evidence is incomplete. Neither status authorizes a retry or implies reversal of an external side effect.

## 6. Retention and dependency order

| Evidence | Retention rule |
|---|---|
| Dispatch identity, events and reservation evidence | Hold while unsettled or disputed. Retain through at least the 90-day detail window after final closure/settlement and longer while any retained evidence requires the journal to prove accounting completeness. |
| Cost Guard ledger | Existing business retention policy applies. Telemetry grants no ledger deletion authority. |
| Protected HMAC references and verification keys | Retain verification capability while any retained evidence depends on it. Keep keys in protected service storage, including historical versions needed for verification. |
| Detailed telemetry and finalized aggregates | Existing 90-day detail anchor after final closure/settlement and 365-day aggregate anchor after finalized cutoff apply. Reopening resets the detail anchor. Censoring does not start expiry. Protect referenced journal evidence for as long as report reproducibility requires it. |

Deletion requires a separate approved implementation that checks dependencies and holds before deleting any evidence. Retain evidence where an anchor or dependency cannot be verified.

## 7. Provider-free acceptance required before activation

| Group | Required evidence |
|---|---|
| Schema/RLS | PG16/17 apply/reapply; FORCE RLS; cross-project/direct-table/GUC/role-contamination denial; immutability; function ACL/search-path audit |
| Route inventory | Type-aware client/subtype scan plus CLI and generic adapter inventory; new route makes CI fail until classified |
| Lease/generation | Race takeover against dispatch-start in both commit orders, including takeover after prepare. Test stale epoch, wrong execution, expired lease and late settlement under the old generation. |
| Dispatch boundary | Observe durable `DISPATCH_STARTED` before first transport operation. DB failure or ambiguous acknowledgement yields zero fixture calls. Replayed receipt cannot send. |
| Reservations | Recover orphaned active reservations. Test expiry before prepare and between prepare and start, expiry recovery racing start, accounting conversion replay, and preservation of holds after ambiguous start. |
| Idempotency | Concurrent creators produce one attempt and one send permit. Same-generation exact replay returns a receipt, changed binding conflicts, and same invocation/ordinal replay across generations rejects. |
| Crash matrix | Inject loss before prepare, after prepare, after start commit, at transport handoff, after response, after ledger commit and before journal terminal commit. Preserve unknown or settlement-pending evidence and assert zero recovery sends. |
| Transport behavior | Assert no hidden client or HTTP retry, redirect replay, streaming reconnect, model fallback or provider fallback. Interrupt a stream after usage and verify partial evidence with incomplete accounting. |
| Runtime route enforcement | Assert zero external side effects on ineligible direct client, review, workspace, CLI and background routes, including missing context and absent schema. |
| Settlement/HMAC | Verify exact attempt/reservation/ledger identity and protected template binding. Cover blocked, provider, validation and domain failures, successful response with failed settlement transaction, and late settlement with old generation. |
| Noninterference | Non-enrolled behavior unchanged; enrolled journal failure has the explicitly approved stable denial; no lease/task mutation or provider retry by reconciliation |
| Reporting | Lifecycle close succeeds only when independent expected-dispatch inventory, settlements, usage, mapping and terminal workflow evidence are complete |
| Rollout | Disabled by default; absent schema leaves enrollment unavailable; kill switch stops new enrollment, preserves evidence and does not interrupt in-flight calls |

All acceptance is provider-free. A fixture call counter stands in for an external provider; no real credential, paid request or production activation is permitted.

## 8. Proposed staged implementation after approval

- **E1 — schema and authority only:** attempt and reservation identities, dispatch events, guarded state transitions, roles, typed functions, RLS and concurrency tests. Production composition and TASK_BOUND are deferred.
- **E2 — managed-boundary fixture integration:** one disabled-by-default server interface around `ManagedModelProviderExecutor`, exact send-boundary and crash tests. Direct review/workspace/CLI routes remain ineligible.
- **E3 — reconciler and lifecycle proof:** join dispatch/invocation/HMAC/ledger/usage/mapping, implement complete/incomplete decisions and generation-race tests. `CLOSE` remains blocked until review accepts the proof.
- **E4 — repeated readiness report:** re-run route inventory and measured failure/overhead tests. Only a separate reviewed migration may then permit TASK_BOUND/CLOSE for the approved boundary.

Each stage is merged to `main`, receives exact-source CI and team review, and preserves the ability to stop without activating the next stage.

## 9. Owner conditions and review gate

The owner conditions map to §3 for attempt identity, start linearization and Cost Guard protocol (1–3), §5 for outcomes and transport behavior (4–5), §2 for route enforcement (6), §5 for DB replay (7), §6 for retention (8), §5 for stable failures (9) and §7 for provider-free acceptance (10). Kit's acceptance of this revision is the gate for E1 schema and authority work.
