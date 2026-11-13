# M6C-3 — Signed Production Deployment Gate

Baseline: `7edf453` on main. Its CI #43348718857 passed all four jobs. GitHub review retrieved for the preceding verifier commit `f963c6d` was ĐẠT; no newer review comment for `7edf453` was visible when work began. The owner explicitly authorized continuing development.

## Implemented boundary

The gate is disabled until an operator supplies an explicit stable signing key and a target-keyed executor registry. No cloud backend, credential or automatic production deployment is included. It protects this execution entry point; it does not govern out-of-band operator deployments.

An authenticated PROJECT_APPROVER/ORG_ADMIN approves the exact accepted Stage 9 release, package SHA-256, live Git main commit, artifact SHA-256, target and lifetime (15-minute default, one-hour maximum). HMAC-SHA256 binds the authenticated principal and one approval UUID as well. The approval token is returned to the approver; only its SHA-256 is persisted. This is a Factory-signed record of an authenticated approver action, not a user-held signing-key or physical-presence protocol.

The execution API accepts only approval ID/token. Core API rechecks project authorization, signature, exact durable binding and release/main. A transactional, row-locked claim consumes approval and creates RUNNING evidence; its transaction must commit before the operator backend is invoked. Nested outer transactions are rejected. Replays read existing state rather than redispatching. A project/target partial unique index holds both RUNNING and UNKNOWN outcomes, including against a different approval. Revocation races serialize on the approval row.

The backend receives a frozen action (deployment UUID, project, release/package/commit/artifact/target) plus AbortSignal. Provider configuration/credentials belong to the operator backend, not request bodies or task context. The backend must verify artifact bytes and provenance, use the deployment UUID as its provider idempotency key and return a SHA-256 receipt. Real artifact-building/provenance and cloud execution are not established by the test executor.

Timeout/error/invalid receipt becomes UNKNOWN without exposing provider error text. A crash before terminal recording leaves RUNNING. No automatic redispatch, unlock, compensation, or exactly-once physical side-effect guarantee is claimed. There is deliberately no force-unlock HTTP route in this slice: unresolved targets hold until a separately implemented, evidence-bound operator reconciliation workflow is available. Concrete cloud executors and that recovery workflow are still needed before production rollout.

## Database and audit

Migration 0014 adds composite tenant-bound FKs, immutable approval bindings, single-use transition guards, terminal-only deployment updates, a unique approval per deployment and unresolved target exclusion. Approver/requester principals must match the authenticated database session; approval issuance also requires project approver membership. Both tables FORCE RLS and restrict mutation to the Core API role and narrow status/receipt columns. No DELETE or identity UPDATE grants are added. Core store transitions and outbox audit commit together; signatures and raw backend errors are absent from audit payloads.

The memory implementation mirrors the gate and uses transaction undo tracking. PostgreSQL uses real row locks/unique constraints. Application role checks are enforced at Core API entry points; only trusted in-process code has access to the signing service and executor registry.

## Verification

- Focused suite: 4/4 passed on Node 24 / PostgreSQL 17 before final regression. Memory, HTTP and real PG cover role denial, disabled configuration, MAC tampering, wrong approval/project, strict request fields, nested TX rejection, concurrent replay, target exclusion, expiry/revocation, live-main drift, unknown outcomes, timeout, lost terminal persistence and restart. A separate Node process exits during executor dispatch after claim commit; the durable RUNNING row remains and a retry does not invoke a backend.
- SQL probes cover RLS invisibility, cross-project reads, principal impersonation rejection, append-only grants and immutable/terminal transitions. Test release prerequisites are seeded through existing trusted store methods; the suite does not claim to repeat real cloud deployment or artifact provenance validation.
- Full local regression: **128/128 passed, 16 suites, 0 failures, 0 skips** on Node 24.16.0 / PostgreSQL 17.10 (~302 seconds). Final request-ID validation was then checked by rerunning the focused deployment suite: **4/4 passed**. Lint/typecheck/shell syntax: **138 inputs passed**; secret scan: **137 inputs, 0 leaks**.
- Migration 0014 is applied twice in clean and historical upgrade paths. CI results are pending push; the review issue will record the exact source commit and completed CI evidence.

No live model or production API call occurred. Existing Codex production blocking and gVisor policy remain. Tier 2/3/4 execution connectors, trust-tier routing, Firecracker, Lima/WSL2 and M6C/G7 acceptance remain pending.
