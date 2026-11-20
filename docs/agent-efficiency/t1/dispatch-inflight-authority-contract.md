# T1-E proposal — authoritative dispatch and in-flight inventory

Date: 2026-11-20. Tracker: issue #23. Baseline: main `0d76348`.

**PROPOSED CONTRACT — AWAITING EXPLICIT OWNER AND TEAM APPROVAL.** This document is not authority to add a migration, mandatory journal, service credential, runtime wiring, provider call or pilot enrollment. `TASK_BOUND`, lifecycle `CLOSE`, production collection, prompt aliases and T2 remain disabled. Stage D's `NOT READY` result stays controlling until a separately reviewed implementation satisfies every acceptance condition below.

## 1. Decision requested

Approve, adjust or reject one authoritative boundary for future enrolled lifecycles:

1. Every potentially chargeable dispatch must have a durable, service-owned dispatch record committed **before** network/process dispatch.
2. Creating that record must validate the active project/task/execution/lease epoch/generation under the same database row-lock and compare-and-swap discipline as lease transfer. Caller text, worker tokens, timestamps and task IDs alone are not authority.
3. A route that cannot participate in this boundary is ineligible and must be rejected for an enrolled lifecycle before it can spend. Non-enrolled legacy operation remains call-level and cannot enter the T1 baseline.
4. Journal failure changes enrolled execution behavior by denying the new dispatch. This mandatory fail-closed boundary is intentionally different from the existing best-effort observer and therefore requires explicit approval.

No telemetry record authorizes execution, renews a lease, transfers ownership, retries a provider call or changes task status. Existing scheduler/lease authority remains the source of truth.

## 2. Route eligibility matrix

| Known surface | Proposed enrolled policy | Required change before eligibility |
|---|---|---|
| `ManagedModelProviderExecutor` structured execution | Candidate boundary | Inject server-only dispatch authority; commit dispatch identity after Cost Guard admission and before `client.complete`; settle exact ledger ID |
| Independent live review calling `client.complete` directly | Ineligible as-is | Route through the same managed boundary or reject it inside an enrolled lifecycle; review independence semantics must remain unchanged |
| Workspace coding adapter calling `modelClient.complete` directly | Ineligible as-is | Route the supervisor-side call through the managed boundary or reject enrolled use; no provider key enters the sandbox |
| Claude Code CLI | Ineligible | One CLI process may hide multiple provider calls and supplies no trusted per-call Cost Guard/dispatch receipts; do not infer calls from process lifetime or output |
| Codex CLI | Production remains blocked | Existing `ERR_UNMETERED_CODEX_DISABLED` remains; emulator is provider-free test evidence only |
| Future `AgentRuntimeAdapter` or client subtype | Deny by default | Add it to the reviewed route matrix and executable inventory before enrolled use |

The implementation may start only with managed structured execution. It must not manufacture coverage by silently excluding another chargeable route used by the same lifecycle: that lifecycle remains incomplete or the route is denied before spending.

## 3. Proposed immutable identities and chronology

The exact migration DDL is deferred until this contract is approved. A later schema proposal must use isolated telemetry ownership, FORCE RLS and composite project keys, and model at least:

- A dispatch identity: project, dispatch ID, invocation ID, lifecycle, task, execution, lease ID/epoch, generation reference, cost session, pipeline session, provider/model, protected prompt reference/key version and creation timestamp.
- Append-only dispatch events with server-derived sequence/digest and a reviewed finite kind set such as `PREPARED`, `DISPATCH_STARTED`, `TERMINAL`, `ABANDONED_UNKNOWN`. Mutable status alone is insufficient evidence.
- An explicit one-to-one link from dispatch to telemetry invocation and at most one finalized Cost Guard ledger call. Identity mismatch is a conflict, never a timestamp join.
- An immutable route/version identifier proving which reviewed mediation path created the dispatch.

Chronology:

1. Authenticated server context enters the existing execution boundary.
2. Cost Guard preflight runs without provider dispatch. A denied preflight records its existing blocked ledger and never creates a chargeable `DISPATCH_STARTED` event.
3. For an allowed call, one transaction locks/rechecks the current lease/generation and commits the dispatch identity plus `PREPARED`. Takeover before this transaction commits rejects the stale generation.
4. The server commits `DISPATCH_STARTED` immediately before the external call. Once this marker exists, a crash is treated as possibly charged and remains unsettled/incomplete; it is never automatically retried.
5. Provider result/failure finalizes the existing Cost Guard ledger. Trusted settlement links the exact ledger and appends `TERMINAL`. A late result stays historical under the original generation and cannot create authority for the new generation.
6. Reconciliation computes expected dispatches from the independent journal, not observer rows. Missing invocation, HMAC mismatch, missing usage, missing settlement, conflict, unknown crash outcome or unverified mapping makes the lifecycle incomplete.

The team must decide how the current Cost Guard reservation/preflight transaction and the new dispatch transaction compose. The implementation must not claim atomicity across them unless the database boundary proves it. A crash after admission but before `PREPARED`, or after `PREPARED` but before `DISPATCH_STARTED`, must have an explicit non-chargeable/unknown classification backed by tests.

## 4. Authority, privacy and noninterference

- Only a dedicated non-login function owner and a private authenticated dispatch service role may create records. `app_runtime`, workers, agents, browser clients, observer transport and worker bearer tokens receive no journal grants.
- Project binding derives from a service-principal registry and authenticated server context. Client-set RLS GUCs are insufficient; membership in `app_runtime` invalidates dispatch authority.
- All writer functions use fixed `search_path=pg_catalog`, fully qualified objects, bounded typed parameters, no dynamic SQL and no caller-supplied actor/timestamp/digest.
- Protected HMAC verification must use the approved service key context and exact ledger template fingerprint. Plain prompt/request hashes, content, raw provider payloads, credentials and free-text errors never enter the journal or its readers.
- Journal persistence is mandatory only for an explicitly enrolled lifecycle. Journal/authority failure denies that new provider dispatch with a stable error before spending; it must not cancel or roll back an already dispatched business call.
- Reconciliation is read-only with respect to execution, leases and provider activity. It never repairs evidence by calling a model.

## 5. Idempotency, takeover and crash rules

- A server-generated dispatch ID plus immutable binding digest is the idempotency identity. Exact replay returns the existing result; changed reuse conflicts.
- Concurrent creation for the same reviewed call identity serializes. It may not create two external calls through an automatic retry path.
- Takeover before authority commit rejects the old generation. Takeover after authority commit leaves immutable evidence under the old generation; the existing runtime fence decides whether dispatch may still start.
- `DISPATCH_STARTED` without terminal settlement is incomplete even if the observer is empty. `PREPARED` without `DISPATCH_STARTED` is not automatically assumed uncharged until the accepted protocol proves the send boundary.
- Process timeout, lost response and service crash are unknown outcomes, not provider failures with zero usage. Operators may append a reviewed terminal evidence event but cannot rewrite history.
- No historical CALL_ONLY row is upgraded from task ID, timestamp or proximity. No backfill into TASK_BOUND.

## 6. Provider-free acceptance required before activation

| Group | Required evidence |
|---|---|
| Schema/RLS | PG16/17 apply/reapply; FORCE RLS; cross-project/direct-table/GUC/role-contamination denial; immutability; function ACL/search-path audit |
| Route inventory | Type-aware client/subtype scan plus CLI and generic adapter inventory; new route makes CI fail until classified |
| Lease/generation | Real concurrent tests for takeover-before, takeover-after, stale epoch, wrong execution, expired lease and two creators; exact linearization evidence |
| Dispatch boundary | Fixture transport proves durable `DISPATCH_STARTED` precedes the external-call signal; DB failure causes zero provider fixture calls |
| Idempotency | Concurrent identical replay creates one dispatch; changed replay conflicts; no code path retries the provider to heal journal/settlement gaps |
| Crash matrix | Crash before prepare, after prepare, after dispatch-start, after response and before ledger settlement; every ambiguous case remains incomplete |
| Settlement/HMAC | Exact invocation/dispatch/ledger identity, protected HMAC verification, allowed/blocked/provider/validation/domain-failure paths, mismatch/conflict denial |
| Noninterference | Non-enrolled behavior unchanged; enrolled journal failure has the explicitly approved stable denial; no lease/task mutation or provider retry by reconciliation |
| Reporting | Lifecycle close succeeds only when independent expected-dispatch inventory, settlements, usage, mapping and terminal workflow evidence are complete |
| Rollout | Disabled by default; absent schema leaves enrollment unavailable; kill switch stops new enrollment, preserves evidence and does not interrupt in-flight calls |

All acceptance is provider-free. A fixture call counter stands in for an external provider; no real credential, paid request or production activation is permitted.

## 7. Proposed staged implementation after approval

- **E1 — schema and authority only:** dispatch identities/events, roles, typed functions, RLS and concurrency negatives. No production composition or TASK_BOUND.
- **E2 — managed-boundary fixture integration:** one disabled-by-default server interface around `ManagedModelProviderExecutor`, exact send-boundary and crash tests. Direct review/workspace/CLI routes remain ineligible.
- **E3 — reconciler and lifecycle proof:** join dispatch/invocation/HMAC/ledger/usage/mapping, implement complete/incomplete decisions and generation-race tests. `CLOSE` remains blocked until review accepts the proof.
- **E4 — repeated readiness report:** re-run route inventory and measured failure/overhead tests. Only a separate reviewed migration may then permit TASK_BOUND/CLOSE for the approved boundary.

Each stage is merged to `main`, receives exact-source CI and team review, and preserves the ability to stop without activating the next stage.

## 8. Explicit approvals requested

Before E1 code, record decisions on issue #23 for:

1. Mandatory fail-closed journal semantics for newly enrolled calls.
2. Initial eligible surface: managed structured execution only.
3. The preflight/dispatch transaction ordering and definition of the external send linearization point.
4. Proposed immutable identities/events, role isolation and retention relationship to existing 90-day detail evidence.
5. Ineligibility of Claude Code, production Codex, direct live review and direct workspace-client routes until separately mediated.
6. Staged E1–E4 implementation and provider-free acceptance matrix.

Approval of this contract does not approve T2 spending, live credentials, prompt aliases, mapping promotion, production enrollment or S0-B completion.
